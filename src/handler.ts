import { findModelConfig } from "./config";
import {
  normalizeRequest,
  normalizeResponse,
  renderCountTokensRequest,
  renderRequest,
  renderResponse,
  renderSyntheticStream,
} from "./canonical";
import {
  isEmbeddingOperation,
  normalizeEmbeddingRequest,
  normalizeEmbeddingResponse,
  renderEmbeddingRequest,
  renderEmbeddingResponse,
  rewriteEmbeddingRequestBodyModel,
} from "./embeddings";
import { buildTargetUrl, buildUpstreamPath, detectEndpoint } from "./endpoints";
import { transformStreamingResponse } from "./stream";
import type {
  ApiFormat,
  ApiKeyConfig,
  ApiKeyHeader,
  CreateForwarderOptions,
  ForwarderConfig,
  ForwarderHandleResult,
  ModelConfig,
  NormalizedEmbeddingRequest,
  NormalizedRequest,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const BILLING_HEADER_RE = /^\s*x-anthropic-billing-header\s*:/i;
const THINKING_PREFIX_TYPES = new Set(["thinking", "redacted_thinking"]);

const SAFE_RESPONSE_INPUT_ITEM_TYPES = new Set([
  "message",
  "input_text",
  "output_text",
  "input_image",
  "input_file",
  "function_call",
  "function_call_output",
  "tool_outputs",
]);

const SAFE_RESPONSE_MESSAGE_CONTENT_TYPES = new Set([
  "input_text",
  "output_text",
  "input_image",
  "input_file",
]);

function extractRequestBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (request.method === "GET" || request.method === "HEAD") {
    return Promise.resolve({});
  }
  if (!contentType.includes("application/json")) {
    return request.text().then((text) => (text ? JSON.parse(text) : {}));
  }
  return request.json();
}

function rectifyResponseInputShape(requestBody: unknown): boolean {
  const payload = asRecord(requestBody);
  if (!("input" in payload)) {
    return false;
  }

  const input = payload.input;
  if (Array.isArray(input) || input == null) {
    return false;
  }

  if (typeof input === "string") {
    payload.input = input.length > 0
      ? [{ role: "user", content: [{ type: "input_text", text: input }] }]
      : [];
    return true;
  }

  const record = asRecord(input);
  if (Object.keys(record).length > 0 && (record.role !== undefined || record.type !== undefined)) {
    payload.input = [input];
    return true;
  }

  return false;
}

function isBillingHeaderText(value: unknown): boolean {
  return typeof value === "string" && BILLING_HEADER_RE.test(value);
}

function rectifyBillingHeader(body: Record<string, unknown> | null): boolean {
  if (!body) {
    return false;
  }

  const system = body.system;
  if (typeof system === "string") {
    if (!isBillingHeaderText(system)) {
      return false;
    }

    delete body.system;
    return true;
  }

  if (!Array.isArray(system)) {
    return false;
  }

  const filtered = system.filter((item) => {
    if (typeof item === "string") {
      return !isBillingHeaderText(item);
    }

    const record = asRecord(item);
    if (record.type === "text") {
      return !isBillingHeaderText(record.text);
    }

    return true;
  });

  if (filtered.length === system.length) {
    return false;
  }

  if (filtered.length > 0) {
    body.system = filtered;
  } else {
    delete body.system;
  }

  return true;
}

function detectThinkingBudgetRectifierTrigger(message: string): boolean {
  const normalized = message.toLowerCase();
  const mentionsBudget = normalized.includes("budget_tokens") || normalized.includes("budget tokens");
  const mentionsThinking = normalized.includes("thinking");
  const mentionsThreshold =
    normalized.includes("greater than or equal to 1024") ||
    normalized.includes(">= 1024") ||
    normalized.includes("at least 1024") ||
    (normalized.includes("1024") && normalized.includes("input should be"));

  return mentionsBudget && mentionsThinking && mentionsThreshold;
}

function rectifyThinkingBudget(body: Record<string, unknown> | null): boolean {
  if (!body) {
    return false;
  }

  const thinking = body.thinking === undefined ? {} : asRecord(body.thinking);
  if (thinking.type === "adaptive") {
    return false;
  }

  let changed = false;

  if (thinking.type !== "enabled") {
    thinking.type = "enabled";
    changed = true;
  }

  if (asNumber(thinking.budget_tokens) !== 32000) {
    thinking.budget_tokens = 32000;
    changed = true;
  }

  body.thinking = thinking;

  const maxTokens = asNumber(body.max_tokens);
  if (maxTokens === undefined || maxTokens < 32001) {
    if (maxTokens !== 64000) {
      body.max_tokens = 64000;
      changed = true;
    }
  }

  return changed;
}

function requestHasThinkingArtifacts(body: Record<string, unknown> | null): boolean {
  if (!body) {
    return false;
  }

  if (body.thinking !== undefined) {
    return true;
  }

  for (const message of asArray(body.messages)) {
    for (const block of asArray(asRecord(message).content)) {
      const record = asRecord(block);
      const type = asString(record.type);
      if (type === "thinking" || type === "redacted_thinking" || record.signature !== undefined) {
        return true;
      }
    }
  }

  return false;
}

function detectThinkingSignatureRectifierTrigger(
  message: string,
  body: Record<string, unknown> | null
): boolean {
  const normalized = message.toLowerCase();

  if (normalized.includes("must start with a thinking block")) {
    return true;
  }

  if (normalized.includes("expected thinking or redacted_thinking") && normalized.includes("found tool_use")) {
    return true;
  }

  if (
    normalized.includes("invalid") &&
    normalized.includes("signature") &&
    normalized.includes("thinking") &&
    normalized.includes("block")
  ) {
    return true;
  }

  if (normalized.includes("signature") && normalized.includes("field required")) {
    return true;
  }

  if (normalized.includes("signature") && normalized.includes("extra inputs are not permitted")) {
    return true;
  }

  if (
    (normalized.includes("thinking") || normalized.includes("redacted_thinking")) &&
    normalized.includes("cannot be modified")
  ) {
    return true;
  }

  return requestHasThinkingArtifacts(body) && (
    normalized.includes("invalid request") ||
    normalized.includes("illegal request") ||
    normalized.includes("非法请求")
  );
}

function rectifyThinkingSignature(body: Record<string, unknown> | null): boolean {
  if (!body) {
    return false;
  }

  let changed = false;

  for (const message of asArray(body.messages)) {
    const messageRecord = asRecord(message);
    const content = asArray(messageRecord.content);
    if (content.length === 0) {
      continue;
    }

    const filtered: unknown[] = [];
    for (const block of content) {
      const blockRecord = asRecord(block);
      const type = asString(blockRecord.type);

      if (type === "thinking" || type === "redacted_thinking") {
        changed = true;
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(blockRecord, "signature")) {
        delete blockRecord.signature;
        changed = true;
      }

      filtered.push(block);
    }

    if (filtered.length !== content.length) {
      messageRecord.content = filtered;
    }
  }

  const lastAssistant = [...asArray(body.messages)]
    .map((message) => asRecord(message))
    .reverse()
    .find((message) => message.role === "assistant");

  if (body.thinking !== undefined && lastAssistant) {
    const content = asArray(lastAssistant.content);
    const firstType = asString(asRecord(content[0]).type);
    const hasToolUse = content.some((block) => asRecord(block).type === "tool_use");

    if (hasToolUse && !THINKING_PREFIX_TYPES.has(firstType ?? "")) {
      delete body.thinking;
      changed = true;
    }
  }

  return changed;
}

function responseRequestNeedsNativeResponseUpstream(requestBody: unknown): boolean {
  const payload = asRecord(requestBody);

  if (
    payload.context_management !== undefined ||
    payload.previous_response_id !== undefined ||
    payload.prompt_cache_key !== undefined
  ) {
    return true;
  }

  for (const item of asArray(payload.input)) {
    const record = asRecord(item);
    const type = asString(record.type);

    if (!type) {
      continue;
    }

    if (!SAFE_RESPONSE_INPUT_ITEM_TYPES.has(type)) {
      return true;
    }

    if (type !== "message") {
      continue;
    }

    if (
      record.id !== undefined ||
      record.status !== undefined ||
      record.phase !== undefined ||
      record.created_by !== undefined
    ) {
      return true;
    }

    for (const contentPart of asArray(record.content)) {
      const partType = asString(asRecord(contentPart).type);
      if (partType && !SAFE_RESPONSE_MESSAGE_CONTENT_TYPES.has(partType)) {
        return true;
      }
    }
  }

  return false;
}

function detectCompactSourceEndpoint(requestBody: unknown): ReturnType<typeof detectEndpoint> {
  const payload = asRecord(requestBody);
  const requestEnvelope = asRecord(payload.request);

  if (
    payload.input !== undefined ||
    payload.instructions !== undefined ||
    payload.previous_response_id !== undefined
  ) {
    return { format: "response", operation: "compact", pathname: "/v1/responses/compact" };
  }

  if (requestEnvelope.contents !== undefined || requestEnvelope.systemInstruction !== undefined) {
    return {
      format: "gemini-cli",
      operation: "generate",
      pathname: "/v1internal/models/compact:generateContent",
    };
  }

  if (payload.contents !== undefined || payload.systemInstruction !== undefined) {
    return {
      format: "gemini",
      operation: "generate",
      pathname: "/v1beta/models/compact:generateContent",
    };
  }

  if (payload.messages !== undefined) {
    if (payload.system !== undefined || payload.stop_sequences !== undefined) {
      return { format: "claude", operation: "generate", pathname: "/v1/messages" };
    }
    return { format: "openai", operation: "generate", pathname: "/v1/chat/completions" };
  }

  return { format: "response", operation: "compact", pathname: "/v1/responses/compact" };
}

function buildCompactRequestBody(requestBody: unknown, upstreamModel: string): Record<string, unknown> {
  const sourceEndpoint = detectCompactSourceEndpoint(requestBody);

  if (sourceEndpoint.format === "response") {
    return cloneRequestBodyWithUpstreamModel(
      { format: "response", operation: "compact", pathname: "/v1/responses/compact" },
      requestBody,
      upstreamModel
    );
  }

  const normalizedRequest = normalizeRequest(sourceEndpoint, requestBody);
  normalizedRequest.model = upstreamModel;
  normalizedRequest.stream = false;

  const renderedBody = renderRequest("response", normalizedRequest);
  delete renderedBody.stream;
  delete renderedBody.max_output_tokens;
  delete renderedBody.temperature;
  delete renderedBody.top_p;
  delete renderedBody.tool_choice;
  delete renderedBody.parallel_tool_calls;
  delete renderedBody.reasoning;

  return renderedBody;
}

function copyRequestHeaders(source: Headers): Headers {
  const target = new Headers();
  for (const [key, value] of source.entries()) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "host" ||
      lowerKey === "content-length" ||
      lowerKey === "authorization" ||
      lowerKey === "x-api-key" ||
      lowerKey === "x-goog-api-key"
    ) {
      continue;
    }
    target.set(key, value);
  }
  return target;
}

function requiresClaudeCompactionBeta(body: Record<string, unknown> | null): boolean {
  if (!body) {
    return false;
  }

  const contextManagement = asRecord(body.context_management);
  const edits = asArray(contextManagement.edits);
  if (edits.some((item) => asRecord(item).type === "compact_20260112")) {
    return true;
  }

  return asArray(body.messages).some((message) =>
    asArray(asRecord(message).content).some((block) => asRecord(block).type === "compaction")
  );
}

function ensureAnthropicBeta(headers: Headers, beta: string): void {
  const existing = headers.get("anthropic-beta");
  if (!existing) {
    headers.set("anthropic-beta", beta);
    return;
  }

  const values = existing
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.includes(beta)) {
    values.push(beta);
    headers.set("anthropic-beta", values.join(","));
  }
}

function defaultAuthHeader(format: ApiFormat): ApiKeyHeader {
  switch (format) {
    case "claude":
      return "x-api-key";
    case "openai":
    case "response":
      return "authorization";
    case "gemini":
    case "gemini-cli":
      return "x-goog-api-key";
  }
}

function validateDownstreamApiKeys(
  headers: Headers,
  url: URL
): { ok: true; apiKey: string | null } | { ok: false; message: string } {
  const values = [
    headers.get("authorization")?.startsWith("Bearer ")
      ? headers.get("authorization")?.slice("Bearer ".length).trim()
      : null,
    headers.get("x-api-key")?.trim() || null,
    headers.get("x-goog-api-key")?.trim() || null,
    url.searchParams.get("key")?.trim() || null,
  ].filter((value): value is string => Boolean(value));

  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length > 1) {
    return {
      ok: false,
      message: "Conflicting API credentials provided across Authorization/x-api-key/x-goog-api-key/key",
    };
  }

  return {
    ok: true,
    apiKey: uniqueValues[0] ?? null,
  };
}

function applyApiKey(
  headers: Headers,
  url: URL,
  apiKeyConfig: ApiKeyConfig,
  upstreamFormat: ApiFormat,
  downstreamKey: string | null
): void {
  const mode = apiKeyConfig.mode ?? "pass-through";
  if (mode === "none") {
    return;
  }

  const resolvedKey =
    mode === "static" && "value" in apiKeyConfig ? apiKeyConfig.value : downstreamKey;
  if (!resolvedKey) {
    return;
  }

  const header = ("header" in apiKeyConfig ? apiKeyConfig.header : undefined) ??
    defaultAuthHeader(upstreamFormat);

  if (header === "authorization") {
    headers.set("authorization", `Bearer ${resolvedKey}`);
    return;
  }
  if (header === "query:key") {
    url.searchParams.set("key", resolvedKey);
    return;
  }
  headers.set(header, resolvedKey);
}

function buildUpstreamRequestHeaders(
  request: Request,
  model: ModelConfig,
  url: URL,
  hasBody: boolean,
  downstreamKey: string | null
): Headers {
  const headers = copyRequestHeaders(request.headers);

  for (const [key, value] of Object.entries(model.upstream.headers)) {
    headers.set(key, value);
  }

  applyApiKey(headers, url, model.upstream.apiKey, model.upstream.format, downstreamKey);

  if (hasBody) {
    headers.set("content-type", "application/json");
  }

  return headers;
}

function buildModelsResponse(config: ForwarderConfig): Response {
  const body = {
    object: "list",
    data: config.models.map((model) => ({
      id: model.name,
      object: "model",
      created: 0,
      owned_by: "transapi-forwarder",
    })),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type ErrorDetails = {
  message: string;
  type?: string;
  code?: string;
};

function extractErrorDetails(raw: unknown): ErrorDetails {
  if (typeof raw === "string") {
    return { message: raw || "Upstream request failed" };
  }
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const error = record.error as Record<string, unknown> | undefined;
    if (typeof error?.message === "string") {
      return {
        message: error.message,
        ...(typeof error.type === "string" ? { type: error.type } : {}),
        ...(typeof error.code === "string" ? { code: error.code } : {}),
      };
    }
    if (typeof record.message === "string") {
      return {
        message: record.message,
        ...(typeof record.type === "string" ? { type: record.type } : {}),
        ...(typeof record.code === "string" ? { code: record.code } : {}),
      };
    }

    if (typeof record.detail === "string") {
      return {
        message: record.detail,
        ...(typeof record.type === "string" ? { type: record.type } : {}),
        ...(typeof record.code === "string" ? { code: record.code } : {}),
      };
    }

    const detail = record.detail as Record<string, unknown> | undefined;
    if (typeof detail?.message === "string") {
      return {
        message: detail.message,
        ...(typeof detail.type === "string" ? { type: detail.type } : {}),
        ...(typeof detail.code === "string" ? { code: detail.code } : {}),
      };
    }

    const serialized = JSON.stringify(record);
    if (serialized && serialized !== "{}") {
      return { message: serialized };
    }
  }
  return { message: "Upstream request failed" };
}

function detectOpenAiMaxCompletionTokensRectifierTrigger(
  message: string,
  body: Record<string, unknown> | null
): boolean {
  if (!body || body.max_completion_tokens !== undefined || asNumber(body.max_tokens) === undefined) {
    return false;
  }

  const normalized = message.toLowerCase();
  if (normalized.includes("max_tokens") && normalized.includes("max_completion_tokens")) {
    return true;
  }

  return (
    normalized.includes("max_tokens") &&
    (
      normalized.includes("unsupported") ||
      normalized.includes("unknown parameter") ||
      normalized.includes("extra inputs are not permitted")
    )
  );
}

function rectifyOpenAiMaxCompletionTokens(body: Record<string, unknown> | null): boolean {
  if (!body || body.max_completion_tokens !== undefined) {
    return false;
  }

  const maxTokens = asNumber(body.max_tokens);
  if (maxTokens === undefined) {
    return false;
  }

  body.max_completion_tokens = maxTokens;
  delete body.max_tokens;
  return true;
}

function detectStreamRequiredRectifierTrigger(message: string, body: Record<string, unknown> | null): boolean {
  if (!body || body.stream === true) {
    return false;
  }

  const normalized = message.toLowerCase();
  return normalized.includes("stream") && (
    normalized.includes("must be set to true") ||
    normalized.includes("must be true") ||
    normalized.includes("requires stream") ||
    normalized.includes("streaming only")
  );
}

function rectifyBufferedStreamRequirement(upstreamRequest: BuiltUpstreamRequest): boolean {
  if (upstreamRequest.passthrough || !upstreamRequest.renderedBody || upstreamRequest.renderedBody.stream === true) {
    return false;
  }

  upstreamRequest.renderedBody.stream = true;
  upstreamRequest.bufferedStreamResponse = true;
  return true;
}

function extractUnsupportedParameterPath(message: string): string | undefined {
  const match = message.match(/(?:unsupported|unknown) parameter:\s*['"]?([a-z0-9_.\[\]]+)['"]?/i);
  return match?.[1];
}

function rectifyUnsupportedOptionalParameter(body: Record<string, unknown> | null, path: string): boolean {
  if (!body) {
    return false;
  }

  const topLevelField = path.split(/[.[]/, 1)[0] ?? path;
  const supportedTopLevelOptionalFields = new Set([
    "metadata",
    "service_tier",
    "truncation",
    "store",
    "parallel_tool_calls",
    "reasoning",
    "tool_choice",
    "user",
    "previous_response_id",
  ]);

  if (supportedTopLevelOptionalFields.has(topLevelField) && body[topLevelField] !== undefined) {
    delete body[topLevelField];
    return true;
  }

  const toolMatch = path.match(/^tools\[(\d+)\]\.(strict|description)$/);
  if (toolMatch) {
    const tool = asRecord(asArray(body.tools)[Number(toolMatch[1])]);
    const field = toolMatch[2] as "strict" | "description";
    if (tool[field] !== undefined) {
      delete tool[field];
      return true;
    }
    return false;
  }

  const openAiToolMatch = path.match(/^tools\[(\d+)\]\.function\.(strict|description)$/);
  if (openAiToolMatch) {
    const tool = asRecord(asArray(body.tools)[Number(openAiToolMatch[1])]);
    const functionRecord = asRecord(tool.function);
    const field = openAiToolMatch[2] as "strict" | "description";
    if (functionRecord[field] !== undefined) {
      delete functionRecord[field];
      return true;
    }
    return false;
  }

  return false;
}

function buildErrorResponse(
  format: ApiFormat,
  status: number,
  message: string,
  details?: { type?: string; code?: string }
): Response {
  let payload: Record<string, unknown> = {
    error: {
      message,
    },
  };

  switch (format) {
    case "claude":
      payload = {
        type: "error",
        error: {
          type: details?.type ?? (status >= 500 ? "api_error" : "invalid_request_error"),
          message,
        },
      };
      break;
    case "gemini":
    case "gemini-cli":
      payload = {
        error: {
          code: status,
          message,
          status: status >= 500 ? "INTERNAL" : "INVALID_ARGUMENT",
        },
      };
      break;
    case "openai":
    case "response":
      payload = {
        error: {
          message,
          type: details?.type ?? (status >= 500 ? "api_error" : "invalid_request_error"),
          ...(details?.code ? { code: details.code } : {}),
        },
      };
      break;
  }

  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cloneRequestBodyWithUpstreamModel(
  endpoint: ReturnType<typeof detectEndpoint>,
  requestBody: unknown,
  upstreamModel: string
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(requestBody ?? {})) as Record<string, unknown>;

  if (isEmbeddingOperation(endpoint.operation)) {
    return rewriteEmbeddingRequestBodyModel(endpoint, clone, upstreamModel);
  }

  switch (endpoint.format) {
    case "claude":
    case "openai":
    case "response":
      clone.model = upstreamModel;
      return clone;
    case "gemini":
      if (typeof clone.model === "string") {
        clone.model = upstreamModel;
      }
      return clone;
    case "gemini-cli": {
      const requestEnvelope =
        clone.request && typeof clone.request === "object" && !Array.isArray(clone.request)
          ? (clone.request as Record<string, unknown>)
          : null;
      if (requestEnvelope && typeof requestEnvelope.model === "string") {
        requestEnvelope.model = upstreamModel;
      }
      return clone;
    }
  }
}

function requestContainsFiles(request: NormalizedRequest): boolean {
  return request.messages.some((message) => message.content.some((block) => block.type === "file"));
}

function requestContainsCompaction(request: NormalizedRequest): boolean {
  return (
    request.compaction !== undefined ||
    request.messages.some((message) => message.content.some((block) => block.type === "compaction"))
  );
}

function requestContainsTooling(request: NormalizedRequest): boolean {
  return (
    (request.tools?.length ?? 0) > 0 ||
    request.toolChoice !== undefined ||
    request.messages.some((message) =>
      message.content.some((block) => block.type === "tool-call" || block.type === "tool-result")
    )
  );
}

function selectUpstreamFormat(
  endpoint: ReturnType<typeof detectEndpoint>,
  model: ModelConfig,
  requestBody: unknown,
  request: NormalizedRequest
): ApiFormat {
  if (
    model.upstream.format === "openai" &&
    requestContainsCompaction(request)
  ) {
    return "response";
  }

  if (
    endpoint.format === "response" &&
    model.upstream.format === "openai" &&
    responseRequestNeedsNativeResponseUpstream(requestBody)
  ) {
    return "response";
  }

  if (
    model.upstream.preferResponsesForFiles &&
    model.upstream.format === "openai" &&
    (endpoint.operation === "generate" || endpoint.operation === "stream") &&
    requestContainsFiles(request)
  ) {
    return "response";
  }

  return model.upstream.format;
}

function selectCompactUpstreamFormat(model: ModelConfig): ApiFormat {
  if (model.upstream.format === "response" || model.upstream.format === "openai") {
    return "response";
  }

  throw new Error("Compaction is only supported for Responses/OpenAI-compatible upstreams");
}

function shouldBufferResponseStream(
  endpoint: ReturnType<typeof detectEndpoint>,
  model: ModelConfig,
  upstreamFormat: ApiFormat,
  request: NormalizedRequest,
  allowDirectStream: boolean
): boolean {
  if (allowDirectStream && upstreamFormat === "response" && requestContainsTooling(request)) {
    return true;
  }

  if (!allowDirectStream && upstreamFormat === "response" && model.upstream.format === "response") {
    return true;
  }

  if (!allowDirectStream && upstreamFormat === "response" && requestContainsCompaction(request)) {
    return true;
  }

  return (
    !allowDirectStream &&
    model.upstream.preferResponsesForFiles &&
    upstreamFormat === "response" &&
    (endpoint.operation === "generate" || endpoint.operation === "stream") &&
    requestContainsFiles(request)
  );
}

function buildUpstreamRequest(
  endpoint: ReturnType<typeof detectEndpoint>,
  requestBody: unknown,
  model: ModelConfig,
  allowDirectStream: boolean
): {
  upstreamUrl: URL;
  upstreamFormat: ApiFormat;
  bufferedStreamResponse: boolean;
  renderedBody: Record<string, unknown> | null;
  normalizedRequest: NormalizedRequest | null;
  normalizedEmbeddingRequest: NormalizedEmbeddingRequest | null;
  passthrough: boolean;
} {
  if (endpoint.operation === "models") {
    return {
      upstreamUrl: new URL(buildTargetUrl(model.upstream.baseUrl, "/v1/models")),
      upstreamFormat: model.upstream.format,
      bufferedStreamResponse: false,
      renderedBody: null,
      normalizedRequest: null,
      normalizedEmbeddingRequest: null,
      passthrough: false,
    };
  }

  if (isEmbeddingOperation(endpoint.operation)) {
    const normalizedEmbeddingRequest = normalizeEmbeddingRequest(endpoint, requestBody);
    normalizedEmbeddingRequest.model = model.upstream.model;

    if (endpoint.format === model.upstream.format) {
      return {
        upstreamUrl: new URL(
          buildTargetUrl(
            model.upstream.baseUrl,
            buildUpstreamPath(model.upstream.format, model.upstream.model, endpoint.operation)
          )
        ),
        upstreamFormat: model.upstream.format,
        bufferedStreamResponse: false,
        renderedBody: cloneRequestBodyWithUpstreamModel(endpoint, requestBody, model.upstream.model),
        normalizedRequest: null,
        normalizedEmbeddingRequest: null,
        passthrough: true,
      };
    }

    const renderedEmbedding = renderEmbeddingRequest(model.upstream.format, normalizedEmbeddingRequest);
    return {
      upstreamUrl: new URL(
        buildTargetUrl(
          model.upstream.baseUrl,
          buildUpstreamPath(model.upstream.format, model.upstream.model, renderedEmbedding.operation)
        )
      ),
      upstreamFormat: model.upstream.format,
      bufferedStreamResponse: false,
      renderedBody: renderedEmbedding.body,
      normalizedRequest: null,
      normalizedEmbeddingRequest,
      passthrough: false,
    };
  }

  if (endpoint.operation === "compact") {
    const upstreamFormat = selectCompactUpstreamFormat(model);
    return {
      upstreamUrl: new URL(
        buildTargetUrl(model.upstream.baseUrl, buildUpstreamPath(upstreamFormat, model.upstream.model, "compact"))
      ),
      upstreamFormat,
      bufferedStreamResponse: false,
      renderedBody: buildCompactRequestBody(requestBody, model.upstream.model),
      normalizedRequest: null,
      normalizedEmbeddingRequest: null,
      passthrough: true,
    };
  }

  const normalizedRequest = normalizeRequest(endpoint, requestBody);
  normalizedRequest.model = model.upstream.model;
  const upstreamFormat = selectUpstreamFormat(endpoint, model, requestBody, normalizedRequest);
  const bufferedStreamResponse = shouldBufferResponseStream(
    endpoint,
    model,
    upstreamFormat,
    normalizedRequest,
    allowDirectStream
  );
  const upstreamStream = allowDirectStream || bufferedStreamResponse;

  if (endpoint.operation === "count_tokens") {
    if (
      (model.upstream.format === "gemini" || model.upstream.format === "gemini-cli") &&
      endpoint.format === model.upstream.format
    ) {
      return {
        upstreamUrl: new URL(
          buildTargetUrl(
            model.upstream.baseUrl,
            buildUpstreamPath(model.upstream.format, model.upstream.model, "count_tokens")
          )
        ),
        upstreamFormat: model.upstream.format,
        bufferedStreamResponse: false,
        renderedBody: cloneRequestBodyWithUpstreamModel(endpoint, requestBody, model.upstream.model),
        normalizedRequest: null,
        normalizedEmbeddingRequest: null,
        passthrough: true,
      };
    }

    if (model.upstream.format !== "claude") {
      throw new Error("Count tokens is only supported for Claude upstreams");
    }

    const upstreamUrl = new URL(
      buildTargetUrl(model.upstream.baseUrl, buildUpstreamPath(model.upstream.format, model.upstream.model, "count_tokens"))
    );
    return {
      upstreamUrl,
      upstreamFormat: model.upstream.format,
      bufferedStreamResponse: false,
      renderedBody: renderCountTokensRequest(model.upstream.format, normalizedRequest),
      normalizedRequest,
      normalizedEmbeddingRequest: null,
      passthrough: false,
    };
  }

  if (endpoint.format === upstreamFormat && !bufferedStreamResponse) {
    const operation = endpoint.operation === "stream" ? "stream" : "generate";
    const upstreamPath = buildUpstreamPath(upstreamFormat, model.upstream.model, operation);
    const upstreamUrl = new URL(buildTargetUrl(model.upstream.baseUrl, upstreamPath));
    if (upstreamFormat === "gemini" && operation === "stream") {
      upstreamUrl.searchParams.set("alt", "sse");
    }

    return {
      upstreamUrl,
      upstreamFormat,
      bufferedStreamResponse: false,
      renderedBody: cloneRequestBodyWithUpstreamModel(endpoint, requestBody, model.upstream.model),
      normalizedRequest: null,
      normalizedEmbeddingRequest: null,
      passthrough: true,
    };
  }

  normalizedRequest.stream = upstreamStream;

  const operation = upstreamStream ? "stream" : "generate";
  const upstreamPath = buildUpstreamPath(upstreamFormat, model.upstream.model, operation);
  const upstreamUrl = new URL(buildTargetUrl(model.upstream.baseUrl, upstreamPath));
  if (upstreamFormat === "gemini" && operation === "stream") {
    upstreamUrl.searchParams.set("alt", "sse");
  }

  return {
    upstreamUrl,
    upstreamFormat,
    bufferedStreamResponse,
    renderedBody: renderRequest(upstreamFormat, normalizedRequest),
    normalizedRequest,
    normalizedEmbeddingRequest: null,
    passthrough: false,
  };
}

async function parseUpstreamError(response: Response): Promise<{ status: number; message: string; type?: string; code?: string }> {
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep text
  }
  const details = extractErrorDetails(parsed);
  return {
    status: response.status,
    message: details.message,
    ...(details.type ? { type: details.type } : {}),
    ...(details.code ? { code: details.code } : {}),
  };
}

type BuiltUpstreamRequest = ReturnType<typeof buildUpstreamRequest>;

async function fetchUpstreamWithRectifiers(
  fetchImpl: typeof globalThis.fetch,
  request: Request,
  model: ModelConfig,
  upstreamRequest: BuiltUpstreamRequest,
  downstreamKey: string | null
): Promise<Response> {
  if (upstreamRequest.upstreamFormat === "claude" && upstreamRequest.renderedBody) {
    rectifyBillingHeader(upstreamRequest.renderedBody);
  }

  const send = async (): Promise<Response> => {
    const upstreamHeaders = buildUpstreamRequestHeaders(
      request,
      model,
      upstreamRequest.upstreamUrl,
      upstreamRequest.renderedBody !== null,
      downstreamKey
    );

    if (
      upstreamRequest.upstreamFormat === "claude" &&
      requiresClaudeCompactionBeta(upstreamRequest.renderedBody)
    ) {
      ensureAnthropicBeta(upstreamHeaders, "compact-2026-01-12");
    }

    return fetchImpl(upstreamRequest.upstreamUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      ...(upstreamRequest.renderedBody
        ? { body: JSON.stringify(upstreamRequest.renderedBody) }
        : {}),
    });
  };

  const retryState = {
    thinkingBudgetRetried: false,
    thinkingSignatureRetried: false,
    openAiMaxCompletionTokensRetried: false,
    streamRequiredRetried: false,
    unsupportedOptionalParametersRetried: new Set<string>(),
  };

  while (true) {
    const response = await send();

    if (!upstreamRequest.renderedBody || response.status !== 400) {
      return response;
    }

    const error = await parseUpstreamError(response.clone());

    const unsupportedParameterPath = extractUnsupportedParameterPath(error.message);
    if (
      unsupportedParameterPath &&
      !retryState.unsupportedOptionalParametersRetried.has(unsupportedParameterPath) &&
      rectifyUnsupportedOptionalParameter(upstreamRequest.renderedBody, unsupportedParameterPath)
    ) {
      retryState.unsupportedOptionalParametersRetried.add(unsupportedParameterPath);
      continue;
    }

    if (
      !retryState.streamRequiredRetried &&
      detectStreamRequiredRectifierTrigger(error.message, upstreamRequest.renderedBody) &&
      rectifyBufferedStreamRequirement(upstreamRequest)
    ) {
      retryState.streamRequiredRetried = true;
      continue;
    }

    if (
      upstreamRequest.upstreamFormat === "openai" &&
      !retryState.openAiMaxCompletionTokensRetried &&
      detectOpenAiMaxCompletionTokensRectifierTrigger(error.message, upstreamRequest.renderedBody) &&
      rectifyOpenAiMaxCompletionTokens(upstreamRequest.renderedBody)
    ) {
      retryState.openAiMaxCompletionTokensRetried = true;
      continue;
    }

    if (upstreamRequest.upstreamFormat !== "claude") {
      return response;
    }

    if (!retryState.thinkingBudgetRetried && detectThinkingBudgetRectifierTrigger(error.message) && rectifyThinkingBudget(upstreamRequest.renderedBody)) {
      retryState.thinkingBudgetRetried = true;
      continue;
    }

    if (
      !retryState.thinkingSignatureRetried &&
      detectThinkingSignatureRectifierTrigger(error.message, upstreamRequest.renderedBody) &&
      rectifyThinkingSignature(upstreamRequest.renderedBody)
    ) {
      retryState.thinkingSignatureRetried = true;
      continue;
    }

    return response;
  }
}

export interface UniversalForwarder {
  readonly config: ForwarderConfig;
  handle(request: Request): Promise<Response>;
  handleDetailed(request: Request): Promise<ForwarderHandleResult>;
}

export function createUniversalForwarder(options: CreateForwarderOptions): UniversalForwarder {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    config: options.config,
    async handle(request: Request): Promise<Response> {
      const result = await this.handleDetailed(request);
      return result.response;
    },
    async handleDetailed(request: Request): Promise<ForwarderHandleResult> {
      const url = new URL(request.url);
      const endpoint = detectEndpoint(url);

      const authValidation = validateDownstreamApiKeys(request.headers, url);
      if (!authValidation.ok) {
        return {
          passthrough: false,
          response: buildErrorResponse(endpoint.format, 401, authValidation.message, {
            type: "authentication_error",
            code: "invalid_api_key",
          }),
        };
      }

      if (endpoint.operation === "unsupported") {
        return {
          passthrough: false,
          response: buildErrorResponse(endpoint.format, 404, `Unsupported endpoint: ${endpoint.pathname}`),
        };
      }

      if (endpoint.operation === "models") {
        return { passthrough: false, response: buildModelsResponse(options.config) };
      }

      let requestBody: unknown;
      try {
        requestBody = await extractRequestBody(request);
      } catch (error) {
        return {
          passthrough: false,
          response: buildErrorResponse(
            endpoint.format,
            400,
            `Invalid JSON request body: ${error instanceof Error ? error.message : String(error)}`,
            {
              type: "invalid_request_error",
              code: "invalid_json",
            }
          ),
        };
      }

      if (endpoint.format === "response" || endpoint.operation === "compact") {
        rectifyResponseInputShape(requestBody);
      }

      if (endpoint.format === "claude") {
        rectifyBillingHeader(asRecord(requestBody));
      }

      const payload = requestBody as Record<string, unknown>;
      const requestedModel =
        endpoint.pathModel ||
        (typeof payload.model === "string" ? payload.model : undefined) ||
        (typeof (payload.request as Record<string, unknown> | undefined)?.model === "string"
          ? ((payload.request as Record<string, unknown>).model as string)
          : undefined);

      if (!requestedModel) {
        return {
          passthrough: false,
          response: buildErrorResponse(endpoint.format, 400, "Missing model name in request", {
            type: "invalid_request_error",
            code: "missing_required_fields",
          }),
        };
      }

      const model = findModelConfig(options.config, requestedModel);
      if (!model) {
        return {
          passthrough: false,
          response: buildErrorResponse(endpoint.format, 404, `Unknown model: ${requestedModel}`, {
            type: "invalid_request_error",
            code: "model_not_found",
          }),
        };
      }

      const allowDirectStream = endpoint.operation === "stream" || payload.stream === true;
      let upstreamRequest;
      try {
        upstreamRequest = buildUpstreamRequest(endpoint, requestBody, model, allowDirectStream);
      } catch (error) {
        return {
          passthrough: false,
          response: buildErrorResponse(
            endpoint.format,
            501,
            error instanceof Error ? error.message : String(error),
            {
              type: "invalid_request_error",
              code: "unsupported_operation",
            }
          ),
        };
      }

      const upstreamResponse = await fetchUpstreamWithRectifiers(
        fetchImpl,
        request,
        model,
        upstreamRequest,
        authValidation.apiKey
      );

      if (upstreamRequest.passthrough) {
        return { passthrough: true, response: upstreamResponse };
      }

      if (isEmbeddingOperation(endpoint.operation)) {
        if (!upstreamResponse.ok) {
          const error = await parseUpstreamError(upstreamResponse);
          return {
            passthrough: false,
            response: buildErrorResponse(endpoint.format, error.status, error.message, {
              type: error.type,
              code: error.code,
            }),
          };
        }

        const upstreamJson = await upstreamResponse.json();
        const normalizedEmbeddingResponse = normalizeEmbeddingResponse(
          upstreamRequest.upstreamFormat,
          upstreamJson
        );
        normalizedEmbeddingResponse.model = requestedModel;

        return {
          passthrough: false,
          response: new Response(
            JSON.stringify(
              renderEmbeddingResponse(
                endpoint,
                upstreamRequest.normalizedEmbeddingRequest ?? {
                  model: requestedModel,
                  inputs: [],
                },
                normalizedEmbeddingResponse
              )
            ),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          ),
        };
      }

      if (endpoint.operation === "count_tokens") {
        return { passthrough: false, response: upstreamResponse };
      }

      if (!upstreamResponse.ok) {
        const error = await parseUpstreamError(upstreamResponse);
        return {
          passthrough: false,
          response: buildErrorResponse(endpoint.format, error.status, error.message, {
            type: error.type,
            code: error.code,
          }),
        };
      }

      const upstreamContentType = upstreamResponse.headers.get("content-type") ?? "";

      if (upstreamRequest.bufferedStreamResponse && upstreamContentType.includes("text/event-stream")) {
        const upstreamSse = await upstreamResponse.text();
        const normalizedResponse = normalizeResponse(upstreamRequest.upstreamFormat, upstreamSse);
        normalizedResponse.model = requestedModel;

        return {
          passthrough: false,
          response: allowDirectStream
            ? renderSyntheticStream(endpoint.format, normalizedResponse)
            : new Response(JSON.stringify(renderResponse(endpoint.format, normalizedResponse)), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
        };
      }

      if (allowDirectStream && upstreamContentType.includes("text/event-stream")) {
        return {
          passthrough: false,
          response: transformStreamingResponse(
            upstreamRequest.upstreamFormat,
            endpoint.format,
            upstreamResponse,
            requestedModel
          ),
        };
      }

      const upstreamJson = await upstreamResponse.json();
      const normalizedResponse = normalizeResponse(upstreamRequest.upstreamFormat, upstreamJson);
      normalizedResponse.model = requestedModel;

      const response = allowDirectStream
        ? renderSyntheticStream(endpoint.format, normalizedResponse)
        : new Response(JSON.stringify(renderResponse(endpoint.format, normalizedResponse)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });

      return { passthrough: false, response };
    },
  };
}
