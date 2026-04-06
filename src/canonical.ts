import type {
  ApiFormat,
  DetectedEndpoint,
  NormalizedContentBlock,
  NormalizedCompactionConfig,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedTool,
  ToolCallBlock,
  ToolChoice,
  UsageIterationInfo,
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

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value.filter((item): item is string => typeof item === "string");
  return values.length > 0 ? values : undefined;
}

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
};

const MEDIA_TYPE_TO_DEFAULT_FILENAME: Record<string, string> = {
  "application/json": "document.json",
  "application/pdf": "document.pdf",
  "application/xml": "document.xml",
  "image/gif": "image.gif",
  "image/jpeg": "image.jpg",
  "image/png": "image.png",
  "image/webp": "image.webp",
  "text/csv": "document.csv",
  "text/html": "document.html",
  "text/markdown": "document.md",
  "text/plain": "document.txt",
};

function filenameFromUrl(value?: string): string | undefined {
  if (!value || !isHttpUrl(value)) {
    return undefined;
  }

  try {
    const pathname = new URL(value).pathname;
    const name = pathname.split("/").filter(Boolean).at(-1);
    return name && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function parseDataUrl(value: string): { mediaType?: string; data: string } | null {
  const match = value.match(/^data:([^;,]+)?(?:;[^,]*)?,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    ...(match[1] ? { mediaType: match[1] } : {}),
    data: match[2] ?? "",
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function inferMediaType(filename?: string, value?: string): string | undefined {
  if (value) {
    const dataUrl = parseDataUrl(value);
    if (dataUrl?.mediaType) {
      return dataUrl.mediaType;
    }
  }

  const candidates: string[] = [];
  if (filename) {
    candidates.push(filename);
  }
  if (value && isHttpUrl(value)) {
    try {
      candidates.push(new URL(value).pathname);
    } catch {
      // ignore invalid URL parsing edge cases
    }
  }

  for (const candidate of candidates) {
    const cleaned = candidate.split(/[?#]/, 1)[0] ?? candidate;
    const extension = cleaned.includes(".") ? cleaned.slice(cleaned.lastIndexOf(".") + 1).toLowerCase() : "";
    if (extension && EXTENSION_TO_MEDIA_TYPE[extension]) {
      return EXTENSION_TO_MEDIA_TYPE[extension];
    }
  }

  return undefined;
}

function resolveFilename(mediaType?: string, filename?: string, url?: string): string | undefined {
  return filename ?? filenameFromUrl(url) ?? (mediaType ? MEDIA_TYPE_TO_DEFAULT_FILENAME[mediaType] : undefined);
}

function isImageMediaType(mediaType: string | undefined): boolean {
  return typeof mediaType === "string" && mediaType.toLowerCase().startsWith("image/");
}

function isPdfMediaType(mediaType: string | undefined): boolean {
  return mediaType?.toLowerCase() === "application/pdf";
}

function buildDataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`;
}

function normalizeOpenAIFileLike(value: unknown): NormalizedContentBlock | null {
  const record = asRecord(value);
  const file = asRecord(record.file);

  const filename =
    asString(file.filename) ??
    asString(record.filename) ??
    filenameFromUrl(asString(file.file_data) ?? asString(record.file_url));

  const fileId = asString(file.file_id) ?? asString(file.fileId) ?? asString(record.file_id) ?? asString(record.fileId);
  const fileValue =
    asString(file.file_data) ??
    asString(file.fileData) ??
    asString(record.file_data) ??
    asString(record.fileData) ??
    asString(record.file_url) ??
    asString(record.fileUrl);
  const mediaType = inferMediaType(filename, fileValue);

  if (fileValue) {
    const dataUrl = parseDataUrl(fileValue);
    if (dataUrl) {
      const resolvedMediaType = dataUrl.mediaType ?? mediaType;
      if (isImageMediaType(resolvedMediaType)) {
        return {
          type: "image",
          ...(resolvedMediaType ? { mediaType: resolvedMediaType } : {}),
          data: dataUrl.data,
          url: fileValue,
        };
      }
      return {
        type: "file",
        ...(resolvedMediaType ? { mediaType: resolvedMediaType } : {}),
        ...(filename ? { filename } : {}),
        data: dataUrl.data,
      };
    }

    if (isHttpUrl(fileValue)) {
      if (isImageMediaType(mediaType)) {
        return {
          type: "image",
          ...(mediaType ? { mediaType } : {}),
          url: fileValue,
        };
      }
      return {
        type: "file",
        ...(mediaType ? { mediaType } : {}),
        ...(filename ? { filename } : {}),
        url: fileValue,
      };
    }

    if (isImageMediaType(mediaType)) {
      return {
        type: "image",
        ...(mediaType ? { mediaType } : {}),
        data: fileValue,
      };
    }

    return {
      type: "file",
      ...(mediaType ? { mediaType } : {}),
      ...(filename ? { filename } : {}),
      data: fileValue,
    };
  }

  if (fileId) {
    return {
      type: "file",
      ...(mediaType ? { mediaType } : {}),
      ...(filename ? { filename } : {}),
      fileId,
    };
  }

  return null;
}

function addModalityTokenDetails(
  usage: UsageInfo,
  details: unknown,
  direction: "input" | "output"
): void {
  for (const item of asArray(details)) {
    const record = asRecord(item);
    const modality = asString(record.modality);
    const tokenCount = asNumber(record.tokenCount);
    if (!modality || tokenCount === undefined) continue;

    switch (modality.toUpperCase()) {
      case "AUDIO":
        if (direction === "input") usage.inputAudioTokens = tokenCount;
        else usage.outputAudioTokens = tokenCount;
        break;
      case "IMAGE":
        if (direction === "input") usage.inputImageTokens = tokenCount;
        else usage.outputImageTokens = tokenCount;
        break;
      case "VIDEO":
        if (direction === "input") usage.inputVideoTokens = tokenCount;
        else usage.outputVideoTokens = tokenCount;
        break;
      default:
        break;
    }
  }
}

function normalizeUsageIterations(value: unknown): UsageIterationInfo[] | undefined {
  const iterations = asArray(value)
    .map((item) => {
      const record = asRecord(item);
      const iteration: UsageIterationInfo = {
        ...(asString(record.type) ? { type: asString(record.type) } : {}),
        ...(asNumber(record.input_tokens) !== undefined
          ? { inputTokens: asNumber(record.input_tokens) }
          : {}),
        ...(asNumber(record.output_tokens) !== undefined
          ? { outputTokens: asNumber(record.output_tokens) }
          : {}),
      };

      return Object.keys(iteration).length > 0 ? iteration : null;
    })
    .filter((item): item is UsageIterationInfo => item !== null);

  return iterations.length > 0 ? iterations : undefined;
}

function buildUsageFromFlatRecord(value: Record<string, unknown>): UsageInfo | undefined {
  const usage: UsageInfo = {
    ...(asNumber(value.prompt_tokens) ?? asNumber(value.input_tokens) !== undefined
      ? { inputTokens: asNumber(value.prompt_tokens) ?? asNumber(value.input_tokens) }
      : {}),
    ...(asNumber(value.completion_tokens) ?? asNumber(value.output_tokens) !== undefined
      ? { outputTokens: asNumber(value.completion_tokens) ?? asNumber(value.output_tokens) }
      : {}),
    ...(asNumber(value.total_tokens) !== undefined ? { totalTokens: asNumber(value.total_tokens) } : {}),
    ...(asNumber(value.cache_read_input_tokens) !== undefined
      ? { cacheReadInputTokens: asNumber(value.cache_read_input_tokens) }
      : {}),
    ...(asNumber(value.cache_creation_input_tokens) !== undefined
      ? { cacheCreationInputTokens: asNumber(value.cache_creation_input_tokens) }
      : {}),
  };

  const promptDetails = asRecord(value.prompt_tokens_details);
  const inputDetails = asRecord(value.input_tokens_details);
  const completionDetails = asRecord(value.completion_tokens_details);
  const outputDetails = asRecord(value.output_tokens_details);

  if (usage.cacheReadInputTokens === undefined) {
    usage.cacheReadInputTokens =
      asNumber(promptDetails.cached_tokens) ?? asNumber(inputDetails.cached_tokens);
  }
  if (usage.cacheCreationInputTokens === undefined) {
    usage.cacheCreationInputTokens =
      asNumber(promptDetails.cache_write_tokens) ?? asNumber(inputDetails.cache_write_tokens);
  }
  if (usage.reasoningTokens === undefined) {
    usage.reasoningTokens =
      asNumber(completionDetails.reasoning_tokens) ?? asNumber(outputDetails.reasoning_tokens);
  }

  usage.inputAudioTokens =
    asNumber(promptDetails.audio_tokens) ?? asNumber(inputDetails.audio_tokens) ?? usage.inputAudioTokens;
  usage.outputAudioTokens =
    asNumber(completionDetails.audio_tokens) ?? asNumber(outputDetails.audio_tokens) ?? usage.outputAudioTokens;
  usage.inputImageTokens =
    asNumber(promptDetails.image_tokens) ?? asNumber(inputDetails.image_tokens) ?? usage.inputImageTokens;
  usage.outputImageTokens =
    asNumber(completionDetails.image_tokens) ?? asNumber(outputDetails.image_tokens) ?? usage.outputImageTokens;
  usage.inputVideoTokens =
    asNumber(promptDetails.video_tokens) ?? asNumber(inputDetails.video_tokens) ?? usage.inputVideoTokens;
  usage.outputVideoTokens =
    asNumber(completionDetails.video_tokens) ?? asNumber(outputDetails.video_tokens) ?? usage.outputVideoTokens;

  const iterations = normalizeUsageIterations(value.iterations);
  if (iterations) {
    usage.iterations = iterations;
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const record = asRecord(item);
        return asString(record.text) ?? "";
      })
      .join("");
  }
  const record = asRecord(value);
  return asString(record.text) ?? "";
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return asRecord(parsed);
    } catch {
      return {};
    }
  }
  return asRecord(value);
}

function tryParseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringifyToolResult(block: Extract<NormalizedContentBlock, { type: "tool-result" }>): string {
  if (typeof block.content === "string" && block.content.length > 0) {
    return block.content;
  }
  if (block.value !== undefined) {
    return typeof block.value === "string" ? block.value : JSON.stringify(block.value);
  }
  return "";
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const record = asRecord(item);
        return asString(record.text) ?? asString(record.content) ?? JSON.stringify(item);
      })
      .join("\n");
  }
  if (value == null) return "";
  return JSON.stringify(value);
}

function normalizeToolChoice(value: unknown): ToolChoice | undefined {
  if (value === "auto") return { type: "auto" };
  if (value === "required" || value === "any") return { type: "any" };
  if (value === "none") return { type: "none" };

  const record = asRecord(value);
  if (record.type === "tool" && typeof record.name === "string") {
    return { type: "tool", name: record.name };
  }
  if (record.type === "function") {
    const nestedFunctionRecord = asRecord(record.function);
    const functionRecord = Object.keys(nestedFunctionRecord).length > 0 ? nestedFunctionRecord : record;
    if (typeof functionRecord.name === "string") {
      return { type: "tool", name: functionRecord.name };
    }
  }
  if (typeof record.type === "string") {
    return { type: "builtin", toolType: normalizeBuiltInToolType(record.type), raw: record };
  }
  return undefined;
}

function normalizeBuiltInToolType(toolType: string): string {
  if (toolType.startsWith("web_search")) return "web_search";
  if (toolType === "openrouter:web_search") return "web_search";
  if (toolType.startsWith("image_generation")) return "image_generation";
  if (toolType.startsWith("code_interpreter")) return "code_interpreter";
  if (toolType.startsWith("code_execution")) return "code_execution";
  if (toolType.startsWith("file_search")) return "file_search";
  if (toolType.startsWith("computer_use") || toolType.startsWith("computer_")) return "computer";
  if (toolType.startsWith("bash_")) return "bash";
  if (toolType.startsWith("text_editor_")) return "text_editor";
  return toolType;
}

function renderOpenAIBuiltInToolChoice(toolType: string, raw?: Record<string, unknown>): Record<string, unknown> {
  switch (toolType) {
    case "web_search":
      return {
        ...(raw?.search_context_size ? { search_context_size: raw.search_context_size } : {}),
        type: "web_search_preview",
      };
    case "image_generation":
      return { type: "image_generation" };
    case "code_execution":
    case "code_interpreter":
    case "bash":
    case "text_editor":
      return { type: "code_interpreter" };
    case "file_search":
      return { type: "file_search" };
    case "computer":
      return { type: "computer_use_preview" };
    default:
      return raw ?? { type: toolType };
  }
}

function renderClaudeBuiltInToolChoice(toolType: string, raw?: Record<string, unknown>): Record<string, unknown> {
  switch (toolType) {
    case "web_search":
      return {
        ...(raw?.search_context_size ? { search_context_size: raw.search_context_size } : {}),
        type: "web_search_20250305",
        name: "web_search",
      };
    case "code_execution":
    case "code_interpreter":
      return { type: "code_execution_20260120", name: "code_execution" };
    case "bash":
      return { type: "bash_20250124", name: "bash" };
    case "text_editor":
      return { type: "text_editor_20250728", name: "str_replace_based_edit_tool" };
    case "computer":
      return {
        type: "computer_20250124",
        name: "computer",
        display_width_px:
          typeof raw?.display_width_px === "number" ? raw.display_width_px : 1024,
        display_height_px:
          typeof raw?.display_height_px === "number" ? raw.display_height_px : 768,
        ...(typeof raw?.display_number === "number" ? { display_number: raw.display_number } : {}),
        ...(typeof raw?.enable_zoom === "boolean" ? { enable_zoom: raw.enable_zoom } : {}),
      };
    default:
      return raw ?? { type: toolType };
  }
}

function renderOpenAIBuiltInTool(tool: NormalizedTool): Record<string, unknown> {
  const toolType = tool.toolType ?? tool.name;
  return renderOpenAIBuiltInToolChoice(toolType, tool.raw);
}

function renderClaudeBuiltInTool(tool: NormalizedTool): Record<string, unknown> {
  const toolType = tool.toolType ?? tool.name;
  return renderClaudeBuiltInToolChoice(toolType, tool.raw);
}

function renderOpenAIToolChoice(value: ToolChoice | undefined): unknown {
  if (!value || value.type === "auto") return "auto";
  if (value.type === "any") return "required";
  if (value.type === "none") return "none";
  if (value.type === "builtin") {
    return renderOpenAIBuiltInToolChoice(value.toolType, value.raw);
  }
  return { type: "function", function: { name: value.name } };
}

function renderClaudeToolChoice(value: ToolChoice | undefined): unknown {
  if (!value || value.type === "auto") return { type: "auto" };
  if (value.type === "any") return { type: "any" };
  if (value.type === "tool") return { type: "tool", name: value.name };
  if (value.type === "builtin") {
    return renderClaudeBuiltInToolChoice(value.toolType, value.raw);
  }
  return undefined;
}

function normalizeToolList(value: unknown): NormalizedTool[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const tools: NormalizedTool[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (typeof record.type === "string" && record.type !== "function") {
      const toolType = normalizeBuiltInToolType(record.type);
      tools.push({
        kind: "builtin",
        name: asString(record.name) ?? toolType,
        toolType,
        raw: record,
      });
      continue;
    }
    const nestedFunctionRecord = asRecord(record.function);
    const functionRecord =
      record.type === "function" && Object.keys(nestedFunctionRecord).length > 0
        ? nestedFunctionRecord
        : record;
    const name = asString(functionRecord.name);
    if (!name) continue;

    const inputSchema = Object.keys(asRecord(functionRecord.input_schema)).length
      ? asRecord(functionRecord.input_schema)
      : Object.keys(asRecord(functionRecord.parameters)).length > 0
        ? asRecord(functionRecord.parameters)
        : undefined;

    tools.push({
      name,
      kind: "function",
      ...(asString(functionRecord.description)
        ? { description: asString(functionRecord.description) }
        : {}),
      ...(inputSchema ? { inputSchema } : {}),
      ...(asBoolean(functionRecord.strict) !== undefined
        ? { strict: asBoolean(functionRecord.strict) }
        : {}),
    });
  }

  return tools.length > 0 ? tools : undefined;
}

function renderOpenAITools(value: NormalizedTool[] | undefined): unknown {
  if (!value || value.length === 0) return undefined;
  return value.map((tool) => {
    if (tool.kind === "builtin" || tool.toolType) {
      return renderOpenAIBuiltInTool(tool);
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { parameters: tool.inputSchema } : {}),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    };
  });
}

function renderResponseTools(value: NormalizedTool[] | undefined): unknown {
  if (!value || value.length === 0) return undefined;
  return value.map((tool) => {
    const toolType = tool.toolType ?? tool.name;
    if (tool.kind === "builtin" || tool.toolType) {
      if (toolType === "web_search") {
        return {
          type: "web_search",
          ...(tool.raw?.search_context_size ? { search_context_size: tool.raw.search_context_size } : {}),
        };
      }

      if (toolType === "computer") {
        return {
          type: "function",
          name: "computer",
          description:
            "Control the computer. Use action=screenshot to capture the screen, or other actions to click, move, type, press keys, drag, or scroll.",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string" },
              coordinate: {
                type: "array",
                items: { type: "number" },
              },
              start_coordinate: {
                type: "array",
                items: { type: "number" },
              },
              text: { type: "string" },
              key: { type: "string" },
              scroll_amount: { type: "number" },
              duration_ms: { type: "number" },
            },
            required: ["action"],
          },
        };
      }

      return renderOpenAIBuiltInTool(tool);
    }
    return {
      type: "function",
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema ? { parameters: tool.inputSchema } : {}),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    };
  });
}

function renderResponseToolChoice(value: ToolChoice | undefined): unknown {
  if (!value || value.type === "auto") return "auto";
  if (value.type === "any") return "required";
  if (value.type === "none") return "none";
  if (value.type === "builtin") {
    if (value.toolType === "web_search") {
      return {
        type: "web_search",
        ...(value.raw?.search_context_size ? { search_context_size: value.raw.search_context_size } : {}),
      };
    }

    if (value.toolType === "computer") {
      return { type: "function", name: "computer" };
    }

    return renderOpenAIBuiltInToolChoice(value.toolType, value.raw);
  }
  return { type: "function", name: value.name };
}

function renderClaudeTools(value: NormalizedTool[] | undefined): unknown {
  if (!value || value.length === 0) return undefined;
  return value.map((tool) => {
    if (tool.kind === "builtin" || tool.toolType) {
      return renderClaudeBuiltInTool(tool);
    }
    return {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema ? { input_schema: tool.inputSchema } : {}),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    };
  });
}

function renderGeminiTools(value: NormalizedTool[] | undefined): unknown {
  if (!value || value.length === 0) return undefined;
  return [
    {
      functionDeclarations: value.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { parameters: tool.inputSchema } : {}),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      })),
    },
  ];
}

function normalizeClaudeBlocks(content: unknown): NormalizedContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  const blocks: NormalizedContentBlock[] = [];
  for (const item of asArray(content)) {
    const record = asRecord(item);
    switch (record.type) {
      case "text":
        blocks.push({ type: "text", text: asString(record.text) ?? "" });
        break;
      case "image": {
        const source = asRecord(record.source);
        blocks.push({
          type: "image",
          ...(asString(source.media_type) ? { mediaType: asString(source.media_type) } : {}),
          ...(asString(source.data) ? { data: asString(source.data) } : {}),
          ...(asString(source.url) ? { url: asString(source.url) } : {}),
        });
        break;
      }
      case "document": {
        const source = asRecord(record.source);
        const sourceType = asString(source.type);

        if (sourceType === "content") {
          blocks.push(...normalizeClaudeBlocks(source.content));
          break;
        }

        if (sourceType === "text") {
          const text = asString(source.data);
          if (text) {
            blocks.push({ type: "text", text });
          }
          break;
        }

        blocks.push({
          type: "file",
          ...(asString(source.media_type) ? { mediaType: asString(source.media_type) } : {}),
          ...(asString(source.data) ? { data: asString(source.data) } : {}),
          ...(asString(source.url) ? { url: asString(source.url) } : {}),
          ...(asString(record.title) ? { filename: asString(record.title) } : {}),
        });
        break;
      }
      case "tool_use":
        blocks.push({
          type: "tool-call",
          id: asString(record.id) ?? `tool_${Math.random().toString(36).slice(2)}`,
          name: asString(record.name) ?? "tool",
          arguments: asRecord(record.input),
        });
        break;
      case "tool_result":
        blocks.push({
          type: "tool-result",
          toolCallId: asString(record.tool_use_id) ?? "tool",
          content: stringifyContent(record.content),
          ...(record.content !== undefined && typeof record.content !== "string"
            ? { value: record.content }
            : {}),
        });
        break;
      case "compaction":
        blocks.push({
          type: "compaction",
          content: asString(record.content) ?? "",
        });
        break;
      default:
        break;
    }
  }
  return blocks;
}

function normalizeOpenAIBlocks(content: unknown): NormalizedContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  const blocks: NormalizedContentBlock[] = [];
  for (const item of asArray(content)) {
    const record = asRecord(item);
    if (record.type === "text") {
      blocks.push({ type: "text", text: asString(record.text) ?? "" });
      continue;
    }
    if (record.type === "image_url") {
      const imageUrl = asRecord(record.image_url);
      const url = asString(imageUrl.url);
      if (url?.startsWith("data:")) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        blocks.push({
          type: "image",
          ...(match?.[1] ? { mediaType: match[1] } : {}),
          ...(match?.[2] ? { data: match[2] } : {}),
          ...(url ? { url } : {}),
          ...(asString(imageUrl.detail)
            ? { detail: asString(imageUrl.detail) as "low" | "high" | "auto" }
            : {}),
        });
      } else {
        blocks.push({
          type: "image",
          ...(url ? { url } : {}),
          ...(asString(imageUrl.detail)
            ? { detail: asString(imageUrl.detail) as "low" | "high" | "auto" }
            : {}),
        });
      }
      continue;
    }
    if (record.type === "file") {
      const block = normalizeOpenAIFileLike(record);
      if (block) {
        blocks.push(block);
      }
    }
  }
  return blocks;
}

function normalizeResponseInputBlocks(content: unknown): NormalizedContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  const blocks: NormalizedContentBlock[] = [];
  for (const item of asArray(content)) {
    const record = asRecord(item);
    if (record.type === "input_text" || record.type === "output_text") {
      blocks.push({ type: "text", text: asString(record.text) ?? "" });
      continue;
    }
    if (record.type === "input_image") {
      const url = asString(record.image_url);
      if (url?.startsWith("data:")) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        blocks.push({
          type: "image",
          ...(match?.[1] ? { mediaType: match[1] } : {}),
          ...(match?.[2] ? { data: match[2] } : {}),
          ...(url ? { url } : {}),
        });
      } else {
        blocks.push({
          type: "image",
          ...(url ? { url } : {}),
        });
      }
      continue;
    }
    if (record.type === "input_file") {
      const block = normalizeOpenAIFileLike(record);
      if (block) {
        blocks.push(block);
      }
    }
  }
  return blocks;
}

function normalizeGeminiParts(parts: unknown[]): NormalizedContentBlock[] {
  const blocks: NormalizedContentBlock[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (typeof record.text === "string") {
      blocks.push({ type: "text", text: record.text });
      continue;
    }
    if (record.inlineData || record.inline_data) {
      const inlineData = asRecord(record.inlineData || record.inline_data);
      const mediaType = asString(inlineData.mimeType) ?? asString(inlineData.mime_type);
      const data = asString(inlineData.data);
      blocks.push(
        isImageMediaType(mediaType)
          ? {
              type: "image",
              ...(mediaType ? { mediaType } : {}),
              ...(data ? { data } : {}),
            }
          : {
              type: "file",
              ...(mediaType ? { mediaType } : {}),
              ...(data ? { data } : {}),
            }
      );
      continue;
    }
    if (record.fileData || record.file_data) {
      const fileData = asRecord(record.fileData || record.file_data);
      const mediaType = asString(fileData.mimeType) ?? asString(fileData.mime_type);
      const url = asString(fileData.fileUri) ?? asString(fileData.file_uri);
      blocks.push(
        isImageMediaType(mediaType)
          ? {
              type: "image",
              ...(mediaType ? { mediaType } : {}),
              ...(url ? { url } : {}),
            }
          : {
              type: "file",
              ...(mediaType ? { mediaType } : {}),
              ...(resolveFilename(mediaType, undefined, url) ? { filename: resolveFilename(mediaType, undefined, url) } : {}),
              ...(url ? { url } : {}),
            }
      );
      continue;
    }
    if (record.functionCall) {
      const functionCall = asRecord(record.functionCall);
      blocks.push({
        type: "tool-call",
        id: asString(functionCall.id) ?? asString(functionCall.name) ?? "tool",
        name: asString(functionCall.name) ?? "tool",
        arguments: asRecord(functionCall.args),
      });
      continue;
    }
    if (record.functionResponse) {
      const functionResponse = asRecord(record.functionResponse);
      const responseValue = functionResponse.response;
      blocks.push({
        type: "tool-result",
        toolCallId: asString(functionResponse.id) ?? asString(functionResponse.name) ?? "tool",
        ...(asString(functionResponse.name) ? { name: asString(functionResponse.name) } : {}),
        content:
          typeof responseValue === "string"
            ? responseValue
            : JSON.stringify(responseValue ?? asRecord(functionResponse.response)),
        ...(responseValue !== undefined ? { value: responseValue } : {}),
      });
    }
  }
  return blocks;
}

export function normalizeRequest(endpoint: DetectedEndpoint, body: unknown): NormalizedRequest {
  const payload = asRecord(body);

  switch (endpoint.format) {
    case "claude": {
      const systemValue = payload.system;
      const system =
        typeof systemValue === "string"
          ? [systemValue]
          : asArray(systemValue)
              .map((item) => extractText(item))
              .filter(Boolean);
      const messages = asArray(payload.messages)
        .map((item) => {
          const record = asRecord(item);
          const role = record.role === "assistant" ? "assistant" : "user";
          return {
            role,
            content: normalizeClaudeBlocks(record.content),
          } satisfies NormalizedMessage;
        })
        .filter((message) => message.content.length > 0);

      return {
        model: asString(payload.model) ?? endpoint.pathModel ?? "",
        stream: payload.stream === true || endpoint.operation === "stream",
        system,
        messages,
        maxOutputTokens: asNumber(payload.max_tokens),
        temperature: asNumber(payload.temperature),
        topP: asNumber(payload.top_p),
        stopSequences: asStringArray(payload.stop_sequences),
        tools: normalizeToolList(payload.tools),
        toolChoice: normalizeToolChoice(payload.tool_choice),
        metadata: Object.keys(asRecord(payload.metadata)).length > 0 ? asRecord(payload.metadata) : undefined,
        compaction: (() => {
          const edit = asArray(asRecord(payload.context_management).edits)
            .map((item) => asRecord(item))
            .find((item) => item.type === "compact_20260112");
          if (!edit) return undefined;
          const trigger = asRecord(edit.trigger);
          return {
            ...(asNumber(trigger.value) !== undefined ? { triggerTokens: asNumber(trigger.value) } : {}),
            ...(asString(edit.instructions) ? { instructions: asString(edit.instructions) } : {}),
            ...(asBoolean(edit.pause_after_compaction) !== undefined
              ? { pauseAfterCompaction: asBoolean(edit.pause_after_compaction) }
              : {}),
          };
        })(),
      };
    }
    case "openai": {
      const system: string[] = [];
      const messages: NormalizedMessage[] = [];

      for (const item of asArray(payload.messages)) {
        const record = asRecord(item);
        if (record.role === "system") {
          const text = extractText(record.content);
          if (text) system.push(text);
          continue;
        }
        if (record.role === "tool") {
          messages.push({
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: asString(record.tool_call_id) ?? "tool",
                content: stringifyContent(record.content),
              },
            ],
          });
          continue;
        }

        const role = record.role === "assistant" ? "assistant" : "user";
        const content = normalizeOpenAIBlocks(record.content);

        if (role === "assistant") {
          for (const toolCall of asArray(record.tool_calls)) {
            const toolRecord = asRecord(toolCall);
            const functionRecord = asRecord(toolRecord.function);
            content.push({
              type: "tool-call",
              id: asString(toolRecord.id) ?? asString(toolRecord.call_id) ?? "tool",
              name: asString(functionRecord.name) ?? "tool",
              arguments: parseJsonObject(functionRecord.arguments),
            });
          }
        }

        messages.push({ role, content });
      }

      return {
        model: asString(payload.model) ?? endpoint.pathModel ?? "",
        stream: payload.stream === true || endpoint.operation === "stream",
        system,
        messages,
        maxOutputTokens: asNumber(payload.max_tokens),
        temperature: asNumber(payload.temperature),
        topP: asNumber(payload.top_p),
        stopSequences: asStringArray(payload.stop),
        tools: normalizeToolList(payload.tools),
        toolChoice: normalizeToolChoice(payload.tool_choice),
        metadata: Object.keys(asRecord(payload.metadata)).length > 0 ? asRecord(payload.metadata) : undefined,
        user: asString(payload.user),
        parallelToolCalls: asBoolean(payload.parallel_tool_calls),
        reasoning: Object.keys(asRecord(payload.reasoning)).length > 0 ? asRecord(payload.reasoning) : undefined,
      };
    }
    case "response": {
      const system: string[] = [];
      const messages: NormalizedMessage[] = [];

      if (typeof payload.instructions === "string" && payload.instructions) {
        system.push(payload.instructions);
      }

      for (const item of asArray(payload.input)) {
        const record = asRecord(item);
        if (record.type === "input_text") {
          messages.push({
            role: "user",
            content: [{ type: "text", text: asString(record.text) ?? "" }],
          });
          continue;
        }
        if (record.type === "output_text") {
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: asString(record.text) ?? "" }],
          });
          continue;
        }
        if (record.type === "input_image" || record.type === "input_file") {
          messages.push({
            role: "user",
            content: normalizeResponseInputBlocks([record]),
          });
          continue;
        }
        if (record.type === "compaction" || record.type === "compaction_summary") {
          messages.push({
            role: "assistant",
            content: [
              {
                type: "compaction",
                content: asString(record.encrypted_content) ?? "",
                rawType: asString(record.type),
              },
            ],
          });
          continue;
        }
        if (record.type === "function_call") {
          messages.push({
            role: "assistant",
            content: [
              {
                type: "tool-call",
                id: asString(record.call_id) ?? "tool",
                name: asString(record.name) ?? "tool",
                arguments: parseJsonObject(record.arguments),
              },
            ],
          });
          continue;
        }
        if (record.type === "function_call_output") {
          messages.push({
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: asString(record.call_id) ?? "tool",
                content: stringifyContent(record.output),
              },
            ],
          });
          continue;
        }
        if (record.type === "tool_outputs") {
          const outputs = asArray(record.outputs).map((output) => {
            const outputRecord = asRecord(output);
            return {
              type: "tool-result",
              toolCallId: asString(outputRecord.call_id) ?? "tool",
              content: stringifyContent(outputRecord.output),
            } satisfies NormalizedContentBlock;
          });
          messages.push({ role: "user", content: outputs });
          continue;
        }

        const role = record.role === "assistant" ? "assistant" : record.role === "developer" ? null : "user";
        const content = normalizeResponseInputBlocks(record.content);
        if (record.role === "developer") {
          const text = content
            .filter((block): block is Extract<NormalizedContentBlock, { type: "text" }> => block.type === "text")
            .map((block) => block.text)
            .join("\n\n");
          if (text) system.push(text);
          continue;
        }
        if (role && content.length > 0) {
          messages.push({ role, content });
        }
      }

      return {
        model: asString(payload.model) ?? endpoint.pathModel ?? "",
        stream: payload.stream === true || endpoint.operation === "stream",
        system,
        messages,
        maxOutputTokens: asNumber(payload.max_output_tokens),
        temperature: asNumber(payload.temperature),
        topP: asNumber(payload.top_p),
        tools: normalizeToolList(payload.tools),
        toolChoice: normalizeToolChoice(payload.tool_choice),
        metadata: Object.keys(asRecord(payload.metadata)).length > 0 ? asRecord(payload.metadata) : undefined,
        user: asString(payload.user),
        parallelToolCalls: asBoolean(payload.parallel_tool_calls),
        reasoning: Object.keys(asRecord(payload.reasoning)).length > 0 ? asRecord(payload.reasoning) : undefined,
        previousResponseId: asString(payload.previous_response_id),
        serviceTier: asString(payload.service_tier),
        truncation: asString(payload.truncation),
        store: asBoolean(payload.store),
        compaction: (() => {
          const edit = asArray(payload.context_management)
            .map((item) => asRecord(item))
            .find((item) => item.type === "compaction");
          if (!edit) return undefined;
          return {
            ...(asNumber(edit.compact_threshold) !== undefined
              ? { triggerTokens: asNumber(edit.compact_threshold) }
              : {}),
            ...(asString(edit.instructions) ? { instructions: asString(edit.instructions) } : {}),
            ...(asBoolean(edit.pause_after_compaction) !== undefined
              ? { pauseAfterCompaction: asBoolean(edit.pause_after_compaction) }
              : {}),
          };
        })(),
      };
    }
    case "gemini":
    case "gemini-cli": {
      const envelope = endpoint.format === "gemini-cli" ? asRecord(payload.request) : payload;
      const system = asArray(asRecord(envelope.systemInstruction).parts)
        .map((item) => asString(asRecord(item).text) ?? "")
        .filter(Boolean);
      const messages = asArray(envelope.contents)
        .map((item) => {
          const record = asRecord(item);
          return {
            role: record.role === "model" ? "assistant" : "user",
            content: normalizeGeminiParts(asArray(record.parts)),
          } satisfies NormalizedMessage;
        })
        .filter((message) => message.content.length > 0);

      const tools: NormalizedTool[] = [];
      for (const item of asArray(envelope.tools)) {
        for (const declaration of asArray(asRecord(item).functionDeclarations)) {
          const record = asRecord(declaration);
          const name = asString(record.name);
          if (!name) continue;
          tools.push({
            name,
            ...(asString(record.description) ? { description: asString(record.description) } : {}),
            ...(Object.keys(asRecord(record.parameters)).length > 0
              ? { inputSchema: asRecord(record.parameters) }
              : {}),
            ...(asBoolean(record.strict) !== undefined ? { strict: asBoolean(record.strict) } : {}),
          });
        }
      }

      const generationConfig = asRecord(envelope.generationConfig);

      return {
        model: endpoint.pathModel ?? asString(envelope.model) ?? "",
        stream: endpoint.operation === "stream" || payload.stream === true,
        system,
        messages,
        maxOutputTokens: asNumber(generationConfig.maxOutputTokens),
        temperature: asNumber(generationConfig.temperature),
        topP: asNumber(generationConfig.topP),
        stopSequences: asStringArray(generationConfig.stopSequences),
        tools: tools.length > 0 ? tools : undefined,
      };
    }
  }
}

function renderClaudeContent(blocks: NormalizedContentBlock[]): unknown[] {
  return blocks.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "image") {
      return {
        type: "image",
        source: {
          type: block.data ? "base64" : "url",
          ...(block.mediaType ? { media_type: block.mediaType } : {}),
          ...(block.data ? { data: block.data } : {}),
          ...(block.url ? { url: block.url } : {}),
        },
      };
    }
    if (block.type === "file") {
      const filename = resolveFilename(block.mediaType, block.filename, block.url);
      if (block.fileId) {
        throw new Error("Claude document blocks do not support provider file IDs");
      }
      if (!isPdfMediaType(block.mediaType)) {
        throw new Error(
          `Claude document blocks only support PDF file conversion, received ${block.mediaType ?? "unknown"}`
        );
      }
      if (block.data) {
        return {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: block.data,
          },
          ...(filename ? { title: filename } : {}),
        };
      }
      if (block.url) {
        return {
          type: "document",
          source: {
            type: "url",
            url: block.url,
          },
          ...(filename ? { title: filename } : {}),
        };
      }
      throw new Error("Claude document blocks require base64 data or a URL");
    }
    if (block.type === "compaction") {
      return {
        type: "compaction",
        content: block.content,
      };
    }
    if (block.type === "tool-call") {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.arguments,
      };
    }
    return {
      type: "tool_result",
      tool_use_id: block.toolCallId,
      content: stringifyToolResult(block),
    };
  });
}

function renderOpenAIContent(blocks: NormalizedContentBlock[]): string | unknown[] {
  const structuredBlocks = blocks.filter((block) => block.type === "image" || block.type === "file");
  if (structuredBlocks.length === 0) {
    return blocks
      .filter((block): block is Extract<NormalizedContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  const content: unknown[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      if (block.data) {
        content.push({
          type: "image_url",
          image_url: {
            url: `data:${block.mediaType ?? "image/png"};base64,${block.data}`,
            ...(block.detail ? { detail: block.detail } : {}),
          },
        });
        continue;
      }
      if (block.url) {
        content.push({
          type: "image_url",
          image_url: {
            url: block.url,
            ...(block.detail ? { detail: block.detail } : {}),
          },
        });
      }
      continue;
    }
    if (block.type === "file") {
      const filename = resolveFilename(block.mediaType, block.filename, block.url);
      const file: Record<string, unknown> = {
        ...(filename ? { filename } : {}),
      };

      if (block.fileId) {
        file.file_id = block.fileId;
      } else if (block.data) {
        file.file_data = block.mediaType ? buildDataUrl(block.mediaType, block.data) : block.data;
      } else if (block.url) {
        // OpenRouter accepts remote URLs in `file_data`; OpenAI responses uses `file_url` instead.
        file.file_data = block.url;
      } else {
        throw new Error("OpenAI file blocks require file_id, file_data, or a URL");
      }

      content.push({
        type: "file",
        file,
      });
    }
  }
  return content;
}

function splitMessageForOpenAI(message: NormalizedMessage): Record<string, unknown>[] {
  const renderableContent = message.content.filter(
    (block) => block.type === "text" || block.type === "image" || block.type === "file"
  );
  const toolCalls = message.content.filter(
    (block): block is ToolCallBlock => block.type === "tool-call"
  );
  const toolResults = message.content.filter(
    (block): block is Extract<NormalizedContentBlock, { type: "tool-result" }> =>
      block.type === "tool-result"
  );

  const result: Record<string, unknown>[] = [];

  if (message.role === "assistant") {
    if (renderableContent.length > 0 || toolCalls.length > 0) {
      result.push({
        role: "assistant",
        content: renderOpenAIContent(renderableContent),
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.arguments),
                },
              })),
            }
          : {}),
      });
    }
    return result;
  }

  if (renderableContent.length > 0) {
    result.push({
      role: "user",
      content: renderOpenAIContent(renderableContent),
    });
  }

  for (const toolResult of toolResults) {
    result.push({
      role: "tool",
      tool_call_id: toolResult.toolCallId,
      content: stringifyToolResult(toolResult),
    });
  }

  return result;
}

function renderResponseInputBlocks(blocks: NormalizedContentBlock[], role: "user" | "assistant"): unknown[] {
  const content: unknown[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      content.push({ type: role === "assistant" ? "output_text" : "input_text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      if (block.data) {
        content.push({
          type: "input_image",
          image_url: `data:${block.mediaType ?? "image/png"};base64,${block.data}`,
        });
        continue;
      }
      if (block.url) {
        content.push({ type: "input_image", image_url: block.url });
      }
      continue;
    }
    if (block.type === "file") {
      const filename = resolveFilename(block.mediaType, block.filename, block.url);
      const item: Record<string, unknown> = {
        type: "input_file",
        ...(filename ? { filename } : {}),
      };

      if (block.fileId) {
        item.file_id = block.fileId;
      } else if (block.data) {
        item.file_data = block.mediaType ? buildDataUrl(block.mediaType, block.data) : block.data;
      } else if (block.url) {
        item.file_url = block.url;
      } else {
        throw new Error("Responses file blocks require file_id, file_data, or file_url");
      }

      content.push(item);
      continue;
    }
  }
  return content;
}

function renderGeminiParts(blocks: NormalizedContentBlock[]): unknown[] {
  const parts: unknown[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ text: block.text });
      continue;
    }
    if (block.type === "image") {
      if (block.data) {
        parts.push({
          inlineData: {
            mimeType: block.mediaType ?? "image/png",
            data: block.data,
          },
        });
        continue;
      }
      if (block.url) {
        parts.push({
          fileData: {
            ...(block.mediaType ? { mimeType: block.mediaType } : {}),
            fileUri: block.url,
          },
        });
      }
      continue;
    }
    if (block.type === "file") {
      if (block.fileId) {
        throw new Error("Gemini parts do not support provider file IDs");
      }
      if (!block.mediaType) {
        throw new Error("Gemini file parts require a MIME type");
      }
      if (block.data) {
        parts.push({
          inlineData: {
            mimeType: block.mediaType,
            data: block.data,
          },
        });
        continue;
      }
      if (block.url) {
        parts.push({
          fileData: {
            mimeType: block.mediaType,
            fileUri: block.url,
          },
        });
        continue;
      }
      throw new Error("Gemini file parts require inline data or a file URI");
    }
    if (block.type === "tool-call") {
      parts.push({
        functionCall: {
          id: block.id,
          name: block.name,
          args: block.arguments,
        },
      });
      continue;
    }
    if (block.type === "tool-result") {
      const parsedValue =
        block.value !== undefined
          ? block.value
          : typeof block.content === "string"
            ? tryParseJsonValue(block.content)
            : undefined;
      parts.push({
        functionResponse: {
          id: block.toolCallId,
          name: block.name ?? block.toolCallId,
          response:
            parsedValue !== undefined && parsedValue !== null && typeof parsedValue === "object"
              ? (parsedValue as Record<string, unknown>)
              : { output: stringifyToolResult(block) },
        },
      });
    }
  }
  return parts;
}

function renderClaudeCompactionContextManagement(
  compaction: NormalizedCompactionConfig | undefined
): Record<string, unknown> | undefined {
  if (!compaction) {
    return undefined;
  }

  return {
    edits: [
      {
        type: "compact_20260112",
        ...(compaction.triggerTokens !== undefined
          ? { trigger: { type: "input_tokens", value: compaction.triggerTokens } }
          : {}),
        ...(compaction.instructions ? { instructions: compaction.instructions } : {}),
        ...(compaction.pauseAfterCompaction !== undefined
          ? { pause_after_compaction: compaction.pauseAfterCompaction }
          : {}),
      },
    ],
  };
}

export function renderRequest(format: ApiFormat, request: NormalizedRequest): Record<string, unknown> {
  switch (format) {
    case "claude": {
      const contextManagement = renderClaudeCompactionContextManagement(request.compaction);
      return {
        model: request.model,
        max_tokens: request.maxOutputTokens ?? 4096,
        stream: request.stream,
        ...(request.system.length > 0 ? { system: request.system.join("\n\n") } : {}),
        messages: request.messages.map((message) => ({
          role: message.role,
          content: renderClaudeContent(message.content),
        })),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.stopSequences ? { stop_sequences: request.stopSequences } : {}),
        ...(request.tools ? { tools: renderClaudeTools(request.tools) } : {}),
        ...(request.toolChoice ? { tool_choice: renderClaudeToolChoice(request.toolChoice) } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
        ...(contextManagement ? { context_management: contextManagement } : {}),
      };
    }
    case "openai":
      return {
        model: request.model,
        stream: request.stream,
        max_tokens: request.maxOutputTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.stopSequences
          ? { stop: request.stopSequences.length === 1 ? request.stopSequences[0] : request.stopSequences }
          : {}),
        ...(request.tools ? { tools: renderOpenAITools(request.tools) } : {}),
        ...(request.toolChoice ? { tool_choice: renderOpenAIToolChoice(request.toolChoice) } : {}),
        ...(request.user ? { user: request.user } : {}),
        ...(request.parallelToolCalls !== undefined
          ? { parallel_tool_calls: request.parallelToolCalls }
          : {}),
        ...(request.reasoning ? { reasoning: request.reasoning } : {}),
        messages: [
          ...request.system.map((text) => ({ role: "system", content: text })),
          ...request.messages.flatMap((message) => splitMessageForOpenAI(message)),
        ],
      };
    case "response": {
      const input: unknown[] = [];
      for (const message of request.messages) {
        for (const block of message.content) {
          if (block.type === "compaction") {
            input.push({
              type: block.rawType ?? "compaction",
              encrypted_content: block.content,
            });
          }
        }

        const renderableContent = message.content.filter(
          (block) => block.type === "text" || block.type === "image" || block.type === "file"
        );
        if (renderableContent.length > 0) {
          input.push({
            role: message.role,
            content: renderResponseInputBlocks(renderableContent, message.role),
          });
        }
        for (const block of message.content) {
          if (block.type === "tool-call") {
            input.push({
              type: "function_call",
              call_id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.arguments),
            });
          }
          if (block.type === "tool-result") {
            input.push({
              type: "function_call_output",
              call_id: block.toolCallId,
              output: block.content,
            });
          }
        }
      }

      return {
        model: request.model,
        stream: request.stream,
        ...(request.system.length > 0 ? { instructions: request.system.join("\n\n") } : {}),
        input,
        ...(request.maxOutputTokens !== undefined
          ? { max_output_tokens: request.maxOutputTokens }
          : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.tools ? { tools: renderResponseTools(request.tools) } : {}),
        ...(request.toolChoice ? { tool_choice: renderResponseToolChoice(request.toolChoice) } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
        ...(request.user ? { user: request.user } : {}),
        ...(request.parallelToolCalls !== undefined
          ? { parallel_tool_calls: request.parallelToolCalls }
          : {}),
        ...(request.reasoning ? { reasoning: request.reasoning } : {}),
        ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
        ...(request.serviceTier ? { service_tier: request.serviceTier } : {}),
        ...(request.truncation ? { truncation: request.truncation } : {}),
        ...(request.store !== undefined ? { store: request.store } : {}),
        ...(request.compaction
          ? {
              context_management: [
                {
                  type: "compaction",
                  compact_threshold: request.compaction.triggerTokens ?? 150000,
                },
              ],
            }
          : {}),
      };
    }
    case "gemini":
    case "gemini-cli": {
      const payload = {
        contents: request.messages.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: renderGeminiParts(message.content),
        })),
        ...(request.system.length > 0
          ? {
              systemInstruction: {
                ...(format === "gemini-cli" ? { role: "user" } : {}),
                parts: request.system.map((text) => ({ text })),
              },
            }
          : {}),
        ...(request.tools ? { tools: renderGeminiTools(request.tools) } : {}),
        generationConfig: {
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.topP !== undefined ? { topP: request.topP } : {}),
          ...(request.maxOutputTokens !== undefined
            ? { maxOutputTokens: request.maxOutputTokens }
            : {}),
          ...(request.stopSequences ? { stopSequences: request.stopSequences } : {}),
        },
      };

      return format === "gemini-cli" ? { request: payload } : payload;
    }
  }

  throw new Error(`Unsupported format: ${format}`);
}

export function renderCountTokensRequest(
  format: ApiFormat,
  request: NormalizedRequest
): Record<string, unknown> {
  if (format !== "claude") {
    throw new Error(`Count tokens is not supported for format: ${format}`);
  }

  const contextManagement = renderClaudeCompactionContextManagement(request.compaction);

  return {
    model: request.model,
    ...(request.system.length > 0 ? { system: request.system.join("\n\n") } : {}),
    messages: request.messages.map((message) => ({
      role: message.role,
      content: renderClaudeContent(message.content),
    })),
    ...(request.tools ? { tools: renderClaudeTools(request.tools) } : {}),
    ...(contextManagement ? { context_management: contextManagement } : {}),
  };
}

function normalizeUsage(value: Record<string, unknown>): UsageInfo | undefined {
  const usage = buildUsageFromFlatRecord(value);
  if (!usage) {
    return undefined;
  }

  if (
    usage.totalTokens === undefined &&
    usage.inputTokens !== undefined &&
    usage.outputTokens !== undefined
  ) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }

  return usage;
}

function mapOpenAIFinishReason(reason: string | undefined): string | null {
  if (!reason) return null;
  return reason;
}

function mapClaudeFinishReason(reason: string | undefined): string | null {
  if (!reason) return null;
  return reason;
}

function mapGeminiFinishReason(reason: string | undefined): string | null {
  if (!reason) return null;
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    default:
      return reason.toLowerCase();
  }
}

function parseSseEvents(raw: string): Array<{ event: string | null; data: string }> {
  const events: Array<{ event: string | null; data: string }> = [];
  let currentEvent: string | null = null;
  let currentData: string[] = [];

  const flush = () => {
    if (currentEvent || currentData.length > 0) {
      events.push({ event: currentEvent, data: currentData.join("\n") });
    }
    currentEvent = null;
    currentData = [];
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("event:")) {
      currentEvent = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      currentData.push(line.slice("data:".length).trim());
    }
  }
  flush();
  return events;
}

function parseOpenAIPayloadFromString(raw: string): Record<string, unknown> {
  const events = parseSseEvents(raw);
  let id = `chatcmpl_${Date.now()}`;
  let model = "";
  let text = "";
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | undefined;
  const toolIdsByIndex = new Map<number, string>();
  const toolNamesByIndex = new Map<number, string>();
  const toolArgsByIndex = new Map<number, string>();

  for (const event of events) {
    if (!event.data || event.data === "[DONE]") {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      continue;
    }

    const record = asRecord(parsed);
    id = asString(record.id) ?? id;
    model = asString(record.model) ?? model;

    const choice = asRecord(asArray(record.choices)[0]);
    const delta = asRecord(choice.delta);

    text += asString(delta.content) ?? "";

    for (const toolCall of asArray(delta.tool_calls)) {
      const toolRecord = asRecord(toolCall);
      const index = asNumber(toolRecord.index) ?? 0;
      const functionRecord = asRecord(toolRecord.function);
      const idValue = asString(toolRecord.id) ?? toolIdsByIndex.get(index) ?? `call_${index}`;
      const nameValue = asString(functionRecord.name) ?? toolNamesByIndex.get(index) ?? `tool_${index}`;

      toolIdsByIndex.set(index, idValue);
      toolNamesByIndex.set(index, nameValue);

      const argumentsDelta = asString(functionRecord.arguments);
      if (argumentsDelta) {
        toolArgsByIndex.set(index, `${toolArgsByIndex.get(index) ?? ""}${argumentsDelta}`);
      }
    }

    if (choice.finish_reason !== undefined) {
      finishReason = asString(choice.finish_reason) ?? finishReason;
    }

    const usageRecord = asRecord(record.usage);
    if (Object.keys(usageRecord).length > 0) {
      usage = usageRecord;
    }
  }

  const toolCalls = [...toolIdsByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, toolId]) => ({
      id: toolId,
      type: "function",
      function: {
        name: toolNamesByIndex.get(index) ?? `tool_${index}`,
        arguments: toolArgsByIndex.get(index) ?? "",
      },
    }));

  return {
    id,
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

function parseResponsePayloadFromString(raw: string): Record<string, unknown> {
  const events = parseSseEvents(raw);
  let fallbackText = "";
  let fallbackId = `resp_${Date.now()}`;

  for (const event of events) {
    if (!event.data) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      continue;
    }

    const record = asRecord(parsed);
    const responseRecord = asRecord(record.response);

    if (event.event === "response.output_text.delta" || record.type === "response.output_text.delta") {
      fallbackText += asString(record.delta) ?? "";
      fallbackId = asString(record.item_id) ?? fallbackId;
      continue;
    }

    if (event.event === "response.completed" || record.type === "response.completed") {
      return Object.keys(responseRecord).length > 0 ? responseRecord : record;
    }

    if ((event.event === "response.created" || record.type === "response.created") && Object.keys(responseRecord).length > 0) {
      fallbackId = asString(responseRecord.id) ?? fallbackId;
    }
  }

  return {
    id: fallbackId,
    object: "response",
    status: "completed",
    output: fallbackText
      ? [
          {
            id: `${fallbackId}_message`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: fallbackText }],
          },
        ]
      : [],
  };
}

export function normalizeResponse(format: ApiFormat, body: unknown): NormalizedResponse {
  const payload =
    format === "openai" && typeof body === "string"
      ? parseOpenAIPayloadFromString(body)
      : format === "response" && typeof body === "string"
        ? parseResponsePayloadFromString(body)
        : asRecord(body);

  switch (format) {
    case "claude": {
      const content = normalizeClaudeBlocks(payload.content);
      const reasoningText = asArray(payload.content)
        .map((item) => {
          const record = asRecord(item);
          if (record.type === "thinking") {
            return asString(record.thinking) ?? "";
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return {
        id: asString(payload.id) ?? `msg_${Date.now()}`,
        model: asString(payload.model) ?? "",
        text: content
          .filter((block): block is Extract<NormalizedContentBlock, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join(""),
        ...(reasoningText ? { reasoningText } : {}),
        ...(content.some((block) => block.type === "compaction")
          ? {
              compactionBlocks: content.filter(
                (block): block is Extract<NormalizedContentBlock, { type: "compaction" }> =>
                  block.type === "compaction"
              ),
            }
          : {}),
        toolCalls: content.filter(
          (block): block is ToolCallBlock => block.type === "tool-call"
        ),
        finishReason: mapClaudeFinishReason(asString(payload.stop_reason)),
        usage: normalizeUsage(asRecord(payload.usage)),
        ...(asString(payload.stop_sequence) ? { stopSequence: asString(payload.stop_sequence) } : {}),
      };
    }
    case "openai": {
      const choice = asRecord(asArray(payload.choices)[0]);
      const message = asRecord(choice.message);
      const content = normalizeOpenAIBlocks(message.content);
      const contentText = content
        .filter((block): block is Extract<NormalizedContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      const toolCalls = asArray(message.tool_calls).map((item) => {
        const record = asRecord(item);
        const functionRecord = asRecord(record.function);
        return {
          type: "tool-call",
          id: asString(record.id) ?? asString(record.call_id) ?? "tool",
          name: asString(functionRecord.name) ?? "tool",
          arguments: parseJsonObject(functionRecord.arguments),
          ...(typeof record.type === "string" && record.type !== "function"
            ? { toolType: normalizeBuiltInToolType(record.type) }
            : {}),
          ...(Object.keys(record).length > 0 ? { raw: record } : {}),
        } satisfies ToolCallBlock;
      });
      return {
        id: asString(payload.id) ?? `chatcmpl_${Date.now()}`,
        model: asString(payload.model) ?? "",
        text: contentText,
        toolCalls,
        finishReason: mapOpenAIFinishReason(asString(choice.finish_reason)),
        usage: normalizeUsage(asRecord(payload.usage)),
        ...(asNumber(payload.created) !== undefined ? { createdAt: asNumber(payload.created) } : {}),
        ...(asString(payload.service_tier) ? { serviceTier: asString(payload.service_tier) } : {}),
        ...(payload.system_fingerprint === null || typeof payload.system_fingerprint === "string"
          ? { systemFingerprint: (payload.system_fingerprint as string | null) ?? null }
          : {}),
        ...(asString(payload.provider) ? { provider: asString(payload.provider) } : {}),
      };
    }
    case "response": {
      const output = asArray(payload.output);
      const reasoningText = output
        .flatMap((item) => {
          const record = asRecord(item);
          if (record.type !== "reasoning") return [];
          return asArray(record.summary)
            .map((summaryItem) => asString(asRecord(summaryItem).text) ?? "")
            .filter(Boolean);
        })
        .join("\n");
      const text = output
        .flatMap((item) => {
          const record = asRecord(item);
          if (record.type !== "message") return [];
          return asArray(record.content)
            .map((contentItem) => asString(asRecord(contentItem).text) ?? "")
            .filter(Boolean);
        })
        .join("");
      const toolCalls = output.flatMap((item) => {
        const record = asRecord(item);
        if (record.type === "tool_calls") {
          return asArray(record.tool_calls).map((toolCall) => {
            const toolCallRecord = asRecord(toolCall);
            const functionRecord = asRecord(toolCallRecord.function);
            return {
              type: "tool-call",
              id: asString(toolCallRecord.id) ?? "tool",
              name: asString(functionRecord.name) ?? asString(toolCallRecord.type) ?? "tool",
              arguments: parseJsonObject(functionRecord.arguments),
              ...(typeof toolCallRecord.type === "string" && toolCallRecord.type !== "function"
                ? { toolType: normalizeBuiltInToolType(toolCallRecord.type) }
                : {}),
              ...(Object.keys(toolCallRecord).length > 0 ? { raw: toolCallRecord } : {}),
            } satisfies ToolCallBlock;
          });
        }

        if (typeof record.type === "string" && record.type.endsWith("_call")) {
          const parsedArguments =
            typeof record.arguments === "string"
              ? parseJsonObject(record.arguments)
              : Object.keys(asRecord(record.action)).length > 0
                ? asRecord(record.action)
                : {};
          return [
            {
              type: "tool-call",
              id: asString(record.call_id) ?? asString(record.id) ?? "tool",
              name: asString(record.name) ?? normalizeBuiltInToolType(record.type),
              arguments: parsedArguments,
              toolType: normalizeBuiltInToolType(record.type),
              raw: record,
            } satisfies ToolCallBlock,
          ];
        }

        return [];
      });
      const compactionBlocks = output.flatMap((item) => {
        const record = asRecord(item);
        if (record.type !== "compaction" && record.type !== "compaction_summary") {
          return [];
        }
        return [
          {
            type: "compaction",
            content: asString(record.encrypted_content) ?? "",
            rawType: asString(record.type),
          } satisfies Extract<NormalizedContentBlock, { type: "compaction" }>,
        ];
      });
      return {
        id: asString(payload.id) ?? `resp_${Date.now()}`,
        model: asString(payload.model) ?? "",
        text,
        ...(reasoningText ? { reasoningText } : {}),
        ...(compactionBlocks.length > 0 ? { compactionBlocks } : {}),
        toolCalls,
        finishReason: asString(payload.status) === "completed" ? "stop" : asString(payload.status) ?? null,
        usage: normalizeUsage(asRecord(payload.usage)),
        ...(asNumber(payload.created) ?? asNumber(payload.created_at) !== undefined
          ? { createdAt: asNumber(payload.created) ?? asNumber(payload.created_at) }
          : {}),
        ...(asString(payload.service_tier) ? { serviceTier: asString(payload.service_tier) } : {}),
        ...(asString(payload.provider) ? { provider: asString(payload.provider) } : {}),
        ...(asString(payload.status) ? { status: asString(payload.status) } : {}),
      };
    }
    case "gemini":
    case "gemini-cli": {
      const actualPayload = asRecord(payload.response).candidates ? asRecord(payload.response) : payload;
      const candidate = asRecord(asArray(actualPayload.candidates)[0]);
      const content = asRecord(candidate.content);
      const blocks = normalizeGeminiParts(asArray(content.parts));
      const usageMetadata = asRecord(actualPayload.usageMetadata);
      const usage: UsageInfo | undefined = (() => {
        if (Object.keys(usageMetadata).length === 0) return undefined;
        const result: UsageInfo = {
          ...(asNumber(usageMetadata.promptTokenCount) !== undefined
            ? { inputTokens: asNumber(usageMetadata.promptTokenCount) }
            : {}),
          ...(asNumber(usageMetadata.candidatesTokenCount) !== undefined
            ? { outputTokens: asNumber(usageMetadata.candidatesTokenCount) }
            : {}),
          ...(asNumber(usageMetadata.totalTokenCount) !== undefined
            ? { totalTokens: asNumber(usageMetadata.totalTokenCount) }
            : {}),
          ...(asNumber(usageMetadata.cachedContentTokenCount) !== undefined
            ? { cacheReadInputTokens: asNumber(usageMetadata.cachedContentTokenCount) }
            : {}),
          ...(asNumber(usageMetadata.thoughtsTokenCount) !== undefined
            ? { reasoningTokens: asNumber(usageMetadata.thoughtsTokenCount) }
            : {}),
        };
        addModalityTokenDetails(result, usageMetadata.promptTokensDetails, "input");
        addModalityTokenDetails(result, usageMetadata.candidatesTokensDetails, "output");
        return Object.keys(result).length > 0 ? result : undefined;
      })();
      return {
        id: `gemini_${Date.now()}`,
        model: "",
        text: blocks
          .filter((block): block is Extract<NormalizedContentBlock, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join(""),
        toolCalls: blocks.filter((block): block is ToolCallBlock => block.type === "tool-call"),
        finishReason: mapGeminiFinishReason(asString(candidate.finishReason)),
        usage,
        ...(asString(actualPayload.provider) ? { provider: asString(actualPayload.provider) } : {}),
      };
    }
  }

  throw new Error(`Unsupported format: ${format}`);
}

function renderUsageOpenAI(usage: UsageInfo | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    ...(usage.cacheReadInputTokens !== undefined ||
    usage.inputAudioTokens !== undefined ||
    usage.inputImageTokens !== undefined ||
    usage.inputVideoTokens !== undefined
      ? {
          prompt_tokens_details: {
            ...(usage.cacheReadInputTokens !== undefined
              ? { cached_tokens: usage.cacheReadInputTokens }
              : {}),
            ...(usage.cacheCreationInputTokens !== undefined
              ? { cache_write_tokens: usage.cacheCreationInputTokens }
              : {}),
            ...(usage.inputAudioTokens !== undefined ? { audio_tokens: usage.inputAudioTokens } : {}),
            ...(usage.inputImageTokens !== undefined ? { image_tokens: usage.inputImageTokens } : {}),
            ...(usage.inputVideoTokens !== undefined ? { video_tokens: usage.inputVideoTokens } : {}),
          },
        }
      : {}),
    ...(usage.reasoningTokens !== undefined ||
    usage.outputAudioTokens !== undefined ||
    usage.outputImageTokens !== undefined ||
    usage.outputVideoTokens !== undefined
      ? {
          completion_tokens_details: {
            ...(usage.reasoningTokens !== undefined ? { reasoning_tokens: usage.reasoningTokens } : {}),
            ...(usage.outputAudioTokens !== undefined ? { audio_tokens: usage.outputAudioTokens } : {}),
            ...(usage.outputImageTokens !== undefined ? { image_tokens: usage.outputImageTokens } : {}),
            ...(usage.outputVideoTokens !== undefined ? { video_tokens: usage.outputVideoTokens } : {}),
          },
        }
      : {}),
  };
}

function renderUsageIterations(
  iterations: UsageIterationInfo[] | undefined
): Record<string, unknown>[] | undefined {
  if (!iterations || iterations.length === 0) {
    return undefined;
  }

  return iterations.map((iteration) => ({
    ...(iteration.type ? { type: iteration.type } : {}),
    ...(iteration.inputTokens !== undefined ? { input_tokens: iteration.inputTokens } : {}),
    ...(iteration.outputTokens !== undefined ? { output_tokens: iteration.outputTokens } : {}),
  }));
}

function renderUsageClaude(usage: UsageInfo | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const iterations = renderUsageIterations(usage.iterations);
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    ...(usage.cacheCreationInputTokens !== undefined
      ? { cache_creation_input_tokens: usage.cacheCreationInputTokens }
      : {}),
    ...(usage.cacheReadInputTokens !== undefined
      ? { cache_read_input_tokens: usage.cacheReadInputTokens }
      : {}),
    ...(iterations ? { iterations } : {}),
  };
}

function renderUsageResponse(usage: UsageInfo | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const iterations = renderUsageIterations(usage.iterations);
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    ...(usage.cacheReadInputTokens !== undefined ||
    usage.inputAudioTokens !== undefined ||
    usage.inputImageTokens !== undefined ||
    usage.inputVideoTokens !== undefined
      ? {
          input_tokens_details: {
            ...(usage.cacheReadInputTokens !== undefined
              ? { cached_tokens: usage.cacheReadInputTokens }
              : {}),
            ...(usage.cacheCreationInputTokens !== undefined
              ? { cache_write_tokens: usage.cacheCreationInputTokens }
              : {}),
            ...(usage.inputAudioTokens !== undefined ? { audio_tokens: usage.inputAudioTokens } : {}),
            ...(usage.inputImageTokens !== undefined ? { image_tokens: usage.inputImageTokens } : {}),
            ...(usage.inputVideoTokens !== undefined ? { video_tokens: usage.inputVideoTokens } : {}),
          },
        }
      : {}),
    ...(usage.reasoningTokens !== undefined ||
    usage.outputAudioTokens !== undefined ||
    usage.outputImageTokens !== undefined ||
    usage.outputVideoTokens !== undefined
      ? {
          output_tokens_details: {
            ...(usage.reasoningTokens !== undefined ? { reasoning_tokens: usage.reasoningTokens } : {}),
            ...(usage.outputAudioTokens !== undefined ? { audio_tokens: usage.outputAudioTokens } : {}),
            ...(usage.outputImageTokens !== undefined ? { image_tokens: usage.outputImageTokens } : {}),
            ...(usage.outputVideoTokens !== undefined ? { video_tokens: usage.outputVideoTokens } : {}),
          },
        }
      : {}),
    ...(iterations ? { iterations } : {}),
  };
}

function mapFinishReasonToOpenAI(reason: string | null, hasToolCalls: boolean): string | null {
  if (hasToolCalls) return "tool_calls";
  if (!reason) return "stop";
  if (reason === "end_turn") return "stop";
  return reason;
}

function mapFinishReasonToClaude(reason: string | null): string {
  if (!reason) return "end_turn";
  if (reason === "stop") return "end_turn";
  return reason;
}

function mapFinishReasonToGemini(reason: string | null): string {
  if (!reason || reason === "stop") return "STOP";
  if (reason === "length") return "MAX_TOKENS";
  return reason.toUpperCase();
}

export function renderResponse(format: ApiFormat, response: NormalizedResponse): Record<string, unknown> {
  switch (format) {
    case "claude": {
      const content: unknown[] = [];
      for (const block of response.compactionBlocks ?? []) {
        content.push({ type: "compaction", content: block.content });
      }
      if (response.text) {
        content.push({ type: "text", text: response.text });
      }
      for (const toolCall of response.toolCalls) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments,
        });
      }
      return {
        id: response.id,
        type: "message",
        role: "assistant",
        model: response.model,
        content,
        stop_reason: mapFinishReasonToClaude(response.finishReason),
        ...(response.usage ? { usage: renderUsageClaude(response.usage) } : {}),
        ...(response.stopSequence !== undefined ? { stop_sequence: response.stopSequence } : {}),
      };
    }
    case "openai":
      return {
        id: response.id,
        object: "chat.completion",
        created: response.createdAt ?? Math.floor(Date.now() / 1000),
        model: response.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: response.text,
              ...(response.toolCalls.length > 0
                ? {
                    tool_calls: response.toolCalls.map((toolCall) => ({
                      id: toolCall.id,
                      type: "function",
                      function: {
                        name: toolCall.name,
                        arguments: JSON.stringify(toolCall.arguments),
                      },
                    })),
                  }
                : {}),
            },
            finish_reason: mapFinishReasonToOpenAI(
              response.finishReason,
              response.toolCalls.length > 0
            ),
          },
        ],
        ...(response.usage ? { usage: renderUsageOpenAI(response.usage) } : {}),
        ...(response.systemFingerprint !== undefined
          ? { system_fingerprint: response.systemFingerprint }
          : {}),
        ...(response.serviceTier ? { service_tier: response.serviceTier } : {}),
        ...(response.provider ? { provider: response.provider } : {}),
      };
    case "response": {
      const output: unknown[] = [];
      if (response.reasoningText) {
        output.push({
          id: `${response.id}_reasoning`,
          type: "reasoning",
          summary: [{ type: "summary_text", text: response.reasoningText }],
        });
      }
      for (const block of response.compactionBlocks ?? []) {
        output.push({
          id: `${response.id}_compaction_${output.length}`,
          type: block.rawType ?? "compaction",
          encrypted_content: block.content,
        });
      }
      if (response.text) {
        output.push({
          id: `${response.id}_message`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: response.text }],
        });
      }
      if (response.toolCalls.length > 0) {
        for (const toolCall of response.toolCalls) {
          if (toolCall.toolType && toolCall.toolType !== "function") {
            output.push(
              toolCall.raw ?? {
                id: toolCall.id,
                type: toolCall.toolType,
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments),
              }
            );
            continue;
          }

          output.push({
            id: `${response.id}_tools`,
            type: "tool_calls",
            tool_calls: [
              {
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.arguments),
                },
              },
            ],
          });
        }
      }
      return {
        id: response.id,
        object: "response",
        created: response.createdAt ?? Math.floor(Date.now() / 1000),
        model: response.model,
        status: response.status ?? "completed",
        output,
        ...(response.usage ? { usage: renderUsageResponse(response.usage) } : {}),
        ...(response.serviceTier ? { service_tier: response.serviceTier } : {}),
        ...(response.provider ? { provider: response.provider } : {}),
      };
    }
    case "gemini":
    case "gemini-cli":
      return {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                ...(response.text ? [{ text: response.text }] : []),
                ...response.toolCalls.map((toolCall) => ({
                  functionCall: {
                    id: toolCall.id,
                    name: toolCall.name,
                    args: toolCall.arguments,
                  },
                })),
              ],
            },
            finishReason: mapFinishReasonToGemini(response.finishReason),
          },
        ],
        ...(response.usage
          ? {
              usageMetadata: {
                promptTokenCount: response.usage.inputTokens ?? 0,
                candidatesTokenCount: response.usage.outputTokens ?? 0,
                totalTokenCount:
                  response.usage.totalTokens ??
                  (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0),
                ...(response.usage.cacheReadInputTokens !== undefined
                  ? { cachedContentTokenCount: response.usage.cacheReadInputTokens }
                  : {}),
                ...(response.usage.reasoningTokens !== undefined
                  ? { thoughtsTokenCount: response.usage.reasoningTokens }
                  : {}),
                ...(response.usage.inputAudioTokens !== undefined ||
                response.usage.inputImageTokens !== undefined ||
                response.usage.inputVideoTokens !== undefined
                  ? {
                      promptTokensDetails: [
                        ...(response.usage.inputAudioTokens !== undefined
                          ? [{ modality: "AUDIO", tokenCount: response.usage.inputAudioTokens }]
                          : []),
                        ...(response.usage.inputImageTokens !== undefined
                          ? [{ modality: "IMAGE", tokenCount: response.usage.inputImageTokens }]
                          : []),
                        ...(response.usage.inputVideoTokens !== undefined
                          ? [{ modality: "VIDEO", tokenCount: response.usage.inputVideoTokens }]
                          : []),
                      ],
                    }
                  : {}),
                ...(response.usage.outputAudioTokens !== undefined ||
                response.usage.outputImageTokens !== undefined ||
                response.usage.outputVideoTokens !== undefined
                  ? {
                      candidatesTokensDetails: [
                        ...(response.usage.outputAudioTokens !== undefined
                          ? [{ modality: "AUDIO", tokenCount: response.usage.outputAudioTokens }]
                          : []),
                        ...(response.usage.outputImageTokens !== undefined
                          ? [{ modality: "IMAGE", tokenCount: response.usage.outputImageTokens }]
                          : []),
                        ...(response.usage.outputVideoTokens !== undefined
                          ? [{ modality: "VIDEO", tokenCount: response.usage.outputVideoTokens }]
                          : []),
                      ],
                    }
                  : {}),
              },
            }
          : {}),
        ...(response.provider ? { provider: response.provider } : {}),
      };
  }

  throw new Error(`Unsupported format: ${format}`);
}

function createSseResponse(lines: string[], headers?: HeadersInit): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...(headers ?? {}),
    },
  });
}

export function renderSyntheticStream(format: ApiFormat, response: NormalizedResponse): Response {
  switch (format) {
    case "claude": {
      const lines = [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: response.id,
            type: "message",
            role: "assistant",
            model: response.model,
          },
        })}\n\n`,
      ];
      let nextIndex = 0;
      if (response.text) {
        lines.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: nextIndex,
            content_block: { type: "text", text: "" },
          })}\n\n`
        );
        lines.push(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: nextIndex,
            delta: { type: "text_delta", text: response.text },
          })}\n\n`
        );
        lines.push(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: nextIndex,
          })}\n\n`
        );
        nextIndex += 1;
      }
      for (const toolCall of response.toolCalls) {
        const toolIndex = nextIndex++;
        lines.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: toolIndex,
            content_block: {
              type: "tool_use",
              id: toolCall.id,
              name: toolCall.name,
              input: {},
            },
          })}\n\n`
        );
        if (Object.keys(toolCall.arguments).length > 0) {
          lines.push(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: toolIndex,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(toolCall.arguments),
              },
            })}\n\n`
          );
        }
        lines.push(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: toolIndex,
          })}\n\n`
        );
      }
      lines.push(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: mapFinishReasonToClaude(response.finishReason) },
          ...(response.usage ? { usage: renderUsageClaude(response.usage) } : {}),
        })}\n\n`
      );
      lines.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      return createSseResponse(lines);
    }
    case "openai": {
      const firstChunk = {
        id: response.id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: response.model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              ...(response.text ? { content: response.text } : {}),
              ...(response.toolCalls.length > 0
                ? {
                    tool_calls: response.toolCalls.map((toolCall) => ({
                      id: toolCall.id,
                      type: "function",
                      function: {
                        name: toolCall.name,
                        arguments: JSON.stringify(toolCall.arguments),
                      },
                    })),
                  }
                : {}),
            },
            finish_reason: null,
          },
        ],
      };
      const finalChunk = {
        id: response.id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: response.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: mapFinishReasonToOpenAI(
              response.finishReason,
              response.toolCalls.length > 0
            ),
          },
        ],
      };
      return createSseResponse([
        `data: ${JSON.stringify(firstChunk)}\n\n`,
        `data: ${JSON.stringify(finalChunk)}\n\n`,
        "data: [DONE]\n\n",
      ]);
    }
    case "response": {
      const lines = [
        `event: response.created\ndata: ${JSON.stringify({
          id: response.id,
          object: "response",
          created: Math.floor(Date.now() / 1000),
          model: response.model,
          status: "generating",
        })}\n\n`,
      ];
      if (response.reasoningText) {
        lines.push(
          `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
            type: "response.reasoning_summary_text.delta",
            item_id: `${response.id}_reasoning`,
            delta: response.reasoningText,
            output_index: 0,
            summary_index: 0,
            sequence_number: 0,
          })}\n\n`
        );
      }
      if (response.text) {
        lines.push(
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            type: "response.output_text.delta",
            item_id: `${response.id}_message`,
            delta: response.text,
          })}\n\n`
        );
      }
      for (const [index, toolCall] of response.toolCalls.entries()) {
        lines.push(
          `event: response.output_item.added\ndata: ${JSON.stringify({
            type: "response.output_item.added",
            output_index: index + (response.reasoningText ? 1 : 0) + (response.text ? 1 : 0),
            item: {
              id: toolCall.id,
              type: "function_call",
              call_id: toolCall.id,
              name: toolCall.name,
              arguments: "",
            },
          })}\n\n`
        );
        lines.push(
          `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: toolCall.id,
            delta: JSON.stringify(toolCall.arguments),
          })}\n\n`
        );
      }
      lines.push(
        `event: response.completed\ndata: ${JSON.stringify(renderResponse("response", response))}\n\n`
      );
      return createSseResponse(lines);
    }
    case "gemini":
    case "gemini-cli":
      return createSseResponse([`data: ${JSON.stringify(renderResponse(format, response))}\n\n`]);
  }

  throw new Error(`Unsupported format: ${format}`);
}
