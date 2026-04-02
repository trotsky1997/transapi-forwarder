import type {
  ApiFormat,
  DetectedEndpoint,
  EndpointOperation,
  NormalizedEmbeddingInput,
  NormalizedEmbeddingRequest,
  NormalizedEmbeddingResponse,
  UsageInfo,
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

function normalizeUsage(value: Record<string, unknown>): UsageInfo | undefined {
  const inputTokens = asNumber(value.prompt_tokens) ?? asNumber(value.promptTokenCount);
  const totalTokens = asNumber(value.total_tokens) ?? asNumber(value.totalTokenCount);
  if (inputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function parseNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    return null;
  }
  return value as number[];
}

function parseOpenAIInputs(value: unknown): NormalizedEmbeddingInput[] {
  if (typeof value === "string") {
    return [{ kind: "text", text: value }];
  }

  const numberArray = parseNumberArray(value);
  if (numberArray) {
    return [{ kind: "tokens", tokens: numberArray }];
  }

  if (!Array.isArray(value)) {
    throw new Error("Unsupported OpenAI embeddings input shape");
  }

  if (value.every((item) => typeof item === "string")) {
    return value.map((item) => ({ kind: "text", text: item as string }));
  }

  if (value.every((item) => parseNumberArray(item))) {
    return value.map((item) => ({ kind: "tokens", tokens: item as number[] }));
  }

  throw new Error("Unsupported OpenAI embeddings input shape");
}

function normalizeGeminiOutputDimensionality(record: Record<string, unknown>): number | undefined {
  return asNumber(record.output_dimensionality) ?? asNumber(record.outputDimensionality);
}

function normalizeGeminiContentLike(value: unknown): NormalizedEmbeddingInput {
  if (typeof value === "string") {
    return { kind: "text", text: value };
  }

  const record = asRecord(value);
  if (record.parts && Array.isArray(record.parts)) {
    return { kind: "content", content: record };
  }

  if (
    typeof record.text === "string" ||
    record.inline_data ||
    record.inlineData ||
    record.file_data ||
    record.fileData
  ) {
    return { kind: "content", content: { parts: [record] } };
  }

  throw new Error("Unsupported Gemini embeddings content shape");
}

function normalizeGeminiInputOptions(record: Record<string, unknown>): Pick<
  NormalizedEmbeddingInput,
  "taskType" | "title" | "outputDimensionality"
> {
  return {
    ...(asString(record.taskType) ? { taskType: asString(record.taskType) } : {}),
    ...(asString(record.title) ? { title: asString(record.title) } : {}),
    ...(normalizeGeminiOutputDimensionality(record) !== undefined
      ? { outputDimensionality: normalizeGeminiOutputDimensionality(record) }
      : {}),
  };
}

function extractTextParts(content: Record<string, unknown>): string[] | null {
  const parts = asArray(content.parts);
  const texts: string[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (typeof record.text !== "string") {
      return null;
    }
    texts.push(record.text);
  }
  return texts;
}

function convertEmbeddingInputToOpenAIValue(input: NormalizedEmbeddingInput): string | number[] {
  if (input.kind === "text") {
    return input.text ?? "";
  }
  if (input.kind === "tokens") {
    return input.tokens ?? [];
  }

  const content = input.content ?? {};
  const texts = extractTextParts(content);
  if (!texts || texts.length === 0) {
    throw new Error("Gemini multimodal embeddings cannot be converted to OpenAI /v1/embeddings");
  }
  return texts.join("\n\n");
}

function renderGeminiContent(input: NormalizedEmbeddingInput): Record<string, unknown> {
  if (input.kind === "text") {
    return { parts: [{ text: input.text ?? "" }] };
  }
  if (input.kind === "content") {
    return JSON.parse(JSON.stringify(input.content ?? {})) as Record<string, unknown>;
  }
  throw new Error("OpenAI token-array embeddings cannot be converted to Gemini embeddings");
}

function assertOpenAICompatibleEmbeddingRequest(request: NormalizedEmbeddingRequest): void {
  if (request.taskType || request.title) {
    throw new Error("Gemini-only embedding task metadata cannot be converted to OpenAI /v1/embeddings");
  }

  for (const input of request.inputs) {
    if (input.taskType || input.title) {
      throw new Error("Per-item Gemini embedding task metadata cannot be converted to OpenAI /v1/embeddings");
    }
  }
}

function detectGeminiEmbeddingOperation(request: NormalizedEmbeddingRequest): EndpointOperation {
  return request.inputs.length > 1 ? "batch_embeddings" : "embeddings";
}

function normalizeGeminiBatchModel(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function parseGeminiEmbeddingItems(payload: Record<string, unknown>): Array<number[]> {
  const singular = parseNumberArray(asRecord(payload.embedding).values);
  if (singular) {
    return [singular];
  }

  const embeddings = asArray(payload.embeddings)
    .map((item) => {
      const record = asRecord(item);
      return parseNumberArray(record.values) ?? parseNumberArray(asRecord(record.embedding).values);
    })
    .filter((item): item is number[] => Boolean(item));

  if (embeddings.length > 0) {
    return embeddings;
  }

  throw new Error("Unsupported Gemini embeddings response shape");
}

export function isEmbeddingOperation(operation: EndpointOperation): boolean {
  return operation === "embeddings" || operation === "batch_embeddings";
}

export function normalizeEmbeddingRequest(
  endpoint: DetectedEndpoint,
  body: unknown
): NormalizedEmbeddingRequest {
  const payload = asRecord(body);

  switch (endpoint.format) {
    case "openai":
      return {
        model: asString(payload.model) ?? endpoint.pathModel ?? "",
        inputs: parseOpenAIInputs(payload.input),
        ...(asNumber(payload.dimensions) !== undefined ? { dimensions: asNumber(payload.dimensions) } : {}),
        ...(asString(payload.encoding_format) ? { encodingFormat: asString(payload.encoding_format) } : {}),
        ...(asString(payload.user) ? { user: asString(payload.user) } : {}),
      };
    case "gemini": {
      if (endpoint.operation === "batch_embeddings") {
        const inputs = asArray(payload.requests).map((item) => {
          const record = asRecord(item);
          const normalized = normalizeGeminiContentLike(record.content);
          return {
            ...normalized,
            ...normalizeGeminiInputOptions(record),
          } satisfies NormalizedEmbeddingInput;
        });

        return {
          model: endpoint.pathModel ?? asString(payload.model) ?? "",
          inputs,
        };
      }

      const contentSource = payload.content ?? payload.contents;
      const inputs = Array.isArray(payload.contents)
        ? asArray(payload.contents).map((item) => normalizeGeminiContentLike(item))
        : [normalizeGeminiContentLike(contentSource)];

      return {
        model: endpoint.pathModel ?? asString(payload.model) ?? "",
        inputs,
        ...(asString(payload.taskType) ? { taskType: asString(payload.taskType) } : {}),
        ...(asString(payload.title) ? { title: asString(payload.title) } : {}),
        ...(normalizeGeminiOutputDimensionality(payload) !== undefined
          ? { outputDimensionality: normalizeGeminiOutputDimensionality(payload) }
          : {}),
      };
    }
    default:
      throw new Error(`Embeddings are not supported for ${endpoint.format} requests`);
  }
}

export function renderEmbeddingRequest(
  format: ApiFormat,
  request: NormalizedEmbeddingRequest
): { operation: EndpointOperation; body: Record<string, unknown> } {
  switch (format) {
    case "openai": {
      assertOpenAICompatibleEmbeddingRequest(request);
      const inputValues = request.inputs.map((input) => convertEmbeddingInputToOpenAIValue(input));
      return {
        operation: "embeddings",
        body: {
          model: request.model,
          input:
            inputValues.length === 1
              ? inputValues[0]
              : inputValues,
          ...(request.outputDimensionality !== undefined
            ? { dimensions: request.outputDimensionality }
            : request.dimensions !== undefined
              ? { dimensions: request.dimensions }
              : {}),
          ...(request.encodingFormat ? { encoding_format: request.encodingFormat } : {}),
          ...(request.user ? { user: request.user } : {}),
        },
      };
    }
    case "gemini": {
      if (request.encodingFormat && request.encodingFormat !== "float") {
        throw new Error("OpenAI embedding encoding_format other than float cannot be converted to Gemini embeddings");
      }

      const operation = detectGeminiEmbeddingOperation(request);
      const outputDimensionality = request.outputDimensionality ?? request.dimensions;

      if (operation === "embeddings") {
        return {
          operation,
          body: {
            content: renderGeminiContent(request.inputs[0] ?? { kind: "text", text: "" }),
            ...(request.taskType ? { taskType: request.taskType } : {}),
            ...(request.title ? { title: request.title } : {}),
            ...(outputDimensionality !== undefined
              ? { output_dimensionality: outputDimensionality }
              : {}),
          },
        };
      }

      return {
        operation,
        body: {
          requests: request.inputs.map((input) => ({
            model: normalizeGeminiBatchModel(request.model),
            content: renderGeminiContent(input),
            ...(input.taskType ?? request.taskType ? { taskType: input.taskType ?? request.taskType } : {}),
            ...(input.title ?? request.title ? { title: input.title ?? request.title } : {}),
            ...((input.outputDimensionality ?? outputDimensionality) !== undefined
              ? { output_dimensionality: input.outputDimensionality ?? outputDimensionality }
              : {}),
          })),
        },
      };
    }
    default:
      throw new Error(`Embeddings are not supported for ${format} upstreams`);
  }
}

export function normalizeEmbeddingResponse(
  format: ApiFormat,
  body: unknown
): NormalizedEmbeddingResponse {
  const payload = asRecord(body);

  switch (format) {
    case "openai": {
      const data = asArray(payload.data).map((item, index) => {
        const record = asRecord(item);
        const embedding = parseNumberArray(record.embedding) ?? asString(record.embedding);
        if (embedding === undefined || embedding === null) {
          throw new Error("Unsupported OpenAI embeddings response shape");
        }
        return {
          index: asNumber(record.index) ?? index,
          embedding,
        };
      });

      return {
        model: asString(payload.model) ?? "",
        data,
        ...(normalizeUsage(asRecord(payload.usage)) ? { usage: normalizeUsage(asRecord(payload.usage)) } : {}),
      };
    }
    case "gemini": {
      const items = parseGeminiEmbeddingItems(payload);
      return {
        model: asString(payload.model) ?? "",
        data: items.map((embedding, index) => ({ index, embedding })),
        ...(normalizeUsage(asRecord(payload.usageMetadata))
          ? { usage: normalizeUsage(asRecord(payload.usageMetadata)) }
          : {}),
      };
    }
    default:
      throw new Error(`Embeddings are not supported for ${format} responses`);
  }
}

export function renderEmbeddingResponse(
  endpoint: DetectedEndpoint,
  request: NormalizedEmbeddingRequest,
  response: NormalizedEmbeddingResponse
): Record<string, unknown> {
  switch (endpoint.format) {
    case "openai":
      return {
        object: "list",
        data: response.data.map((item) => ({
          object: "embedding",
          index: item.index,
          embedding: item.embedding,
        })),
        model: response.model,
        ...(response.usage
          ? {
              usage: {
                ...(response.usage.inputTokens !== undefined
                  ? { prompt_tokens: response.usage.inputTokens }
                  : {}),
                ...(response.usage.totalTokens !== undefined
                  ? { total_tokens: response.usage.totalTokens }
                  : {}),
              },
            }
          : {}),
      };
    case "gemini": {
      const values = response.data.map((item) => {
        if (!Array.isArray(item.embedding)) {
          throw new Error("OpenAI base64 embeddings cannot be converted to Gemini responses");
        }
        return { values: item.embedding };
      });

      return {
        ...(endpoint.operation === "batch_embeddings" || values.length > 1
          ? { embeddings: values }
          : { embedding: values[0] ?? { values: [] } }),
        ...(response.usage
          ? {
              usageMetadata: {
                ...(response.usage.inputTokens !== undefined
                  ? { promptTokenCount: response.usage.inputTokens }
                  : {}),
                ...(response.usage.totalTokens !== undefined
                  ? { totalTokenCount: response.usage.totalTokens }
                  : {}),
              },
            }
          : {}),
      };
    }
    default:
      throw new Error(`Embeddings are not supported for ${endpoint.format} responses`);
  }
}

export function rewriteEmbeddingRequestBodyModel(
  endpoint: DetectedEndpoint,
  body: Record<string, unknown>,
  upstreamModel: string
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

  if (endpoint.format === "openai") {
    clone.model = upstreamModel;
    return clone;
  }

  if (endpoint.format === "gemini") {
    if (endpoint.operation === "batch_embeddings") {
      clone.requests = asArray(clone.requests).map((item) => {
        const record = asRecord(item);
        return {
          ...record,
          ...(typeof record.model === "string"
            ? { model: normalizeGeminiBatchModel(upstreamModel) }
            : {}),
        };
      });
      return clone;
    }

    if (typeof clone.model === "string") {
      clone.model = normalizeGeminiBatchModel(upstreamModel);
    }
    return clone;
  }

  return clone;
}
