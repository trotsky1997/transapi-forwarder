export type ApiFormat = "claude" | "openai" | "response" | "gemini" | "gemini-cli";

export type ConfigApiFormat =
  | ApiFormat
  | "openai-compatible"
  | "codex";

export type ApiKeyHeader = "authorization" | "x-api-key" | "x-goog-api-key" | "query:key";

export interface ApiKeyPassThroughConfig {
  mode?: "pass-through";
  header?: ApiKeyHeader;
}

export interface ApiKeyStaticConfig {
  mode: "static";
  value: string;
  header?: ApiKeyHeader;
}

export interface ApiKeyDisabledConfig {
  mode: "none";
}

export type ApiKeyConfig =
  | ApiKeyPassThroughConfig
  | ApiKeyStaticConfig
  | ApiKeyDisabledConfig;

export interface UpstreamConfigInput {
  baseUrl: string;
  model?: string;
  format: ConfigApiFormat;
  preferResponsesForFiles?: boolean;
  apiKey?: ApiKeyConfig;
  headers?: Record<string, string>;
}

export interface ModelConfigInput {
  name: string;
  aliases?: string[];
  upstream: UpstreamConfigInput;
}

export interface ForwarderConfigInput {
  models: ModelConfigInput[];
}

export interface UpstreamConfig {
  baseUrl: string;
  model: string;
  format: ApiFormat;
  preferResponsesForFiles: boolean;
  apiKey: ApiKeyConfig;
  headers: Record<string, string>;
}

export interface ModelConfig {
  name: string;
  aliases: string[];
  upstream: UpstreamConfig;
}

export interface ForwarderConfig {
  models: ModelConfig[];
}

export interface CreateForwarderOptions {
  config: ForwarderConfig;
  fetch?: typeof globalThis.fetch;
}

export type ToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "builtin"; toolType: string; raw?: Record<string, unknown> };

export interface NormalizedTool {
  name: string;
  kind?: "function" | "builtin";
  toolType?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  strict?: boolean;
  raw?: Record<string, unknown>;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mediaType?: string;
  data?: string;
  url?: string;
  detail?: "low" | "high" | "auto";
}

export interface FileBlock {
  type: "file";
  mediaType?: string;
  data?: string;
  url?: string;
  fileId?: string;
  filename?: string;
}

export interface CompactionBlock {
  type: "compaction";
  content: string;
  rawType?: string;
}

export interface ToolCallBlock {
  type: "tool-call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  toolType?: string;
  raw?: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool-result";
  toolCallId: string;
  name?: string;
  content: string;
  value?: unknown;
}

export type NormalizedContentBlock =
  | TextBlock
  | ImageBlock
  | FileBlock
  | CompactionBlock
  | ToolCallBlock
  | ToolResultBlock;

export interface NormalizedCompactionConfig {
  triggerTokens?: number;
  instructions?: string;
  pauseAfterCompaction?: boolean;
}

export interface NormalizedMessage {
  role: "user" | "assistant";
  content: NormalizedContentBlock[];
}

export interface NormalizedRequest {
  model: string;
  stream: boolean;
  system: string[];
  messages: NormalizedMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  tools?: NormalizedTool[];
  toolChoice?: ToolChoice;
  metadata?: Record<string, unknown>;
  user?: string;
  parallelToolCalls?: boolean;
  reasoning?: Record<string, unknown>;
  previousResponseId?: string;
  serviceTier?: string;
  truncation?: string;
  store?: boolean;
  compaction?: NormalizedCompactionConfig;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  inputImageTokens?: number;
  outputImageTokens?: number;
  inputVideoTokens?: number;
  outputVideoTokens?: number;
  iterations?: UsageIterationInfo[];
}

export interface UsageIterationInfo {
  type?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface NormalizedResponse {
  id: string;
  model: string;
  text: string;
  reasoningText?: string;
  compactionBlocks?: CompactionBlock[];
  toolCalls: ToolCallBlock[];
  finishReason: string | null;
  usage?: UsageInfo;
  createdAt?: number;
  serviceTier?: string;
  systemFingerprint?: string | null;
  stopSequence?: string | null;
  provider?: string;
  status?: string;
}

export interface NormalizedEmbeddingInput {
  kind: "text" | "tokens" | "content";
  text?: string;
  tokens?: number[];
  content?: Record<string, unknown>;
  taskType?: string;
  title?: string;
  outputDimensionality?: number;
}

export interface NormalizedEmbeddingRequest {
  model: string;
  inputs: NormalizedEmbeddingInput[];
  dimensions?: number;
  encodingFormat?: string;
  user?: string;
  taskType?: string;
  title?: string;
  outputDimensionality?: number;
}

export interface NormalizedEmbeddingItem {
  index: number;
  embedding: number[] | string;
}

export interface NormalizedEmbeddingResponse {
  model: string;
  data: NormalizedEmbeddingItem[];
  usage?: UsageInfo;
}

export type EndpointOperation =
  | "generate"
  | "stream"
  | "compact"
  | "count_tokens"
  | "models"
  | "embeddings"
  | "batch_embeddings"
  | "unsupported";

export interface DetectedEndpoint {
  format: ApiFormat;
  operation: EndpointOperation;
  pathModel?: string;
  pathname: string;
}

export interface ForwarderHandleResult {
  response: Response;
  passthrough: boolean;
}
