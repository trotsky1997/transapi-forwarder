import { readFile } from "node:fs/promises";
import {
  type ApiFormat,
  type ForwarderConfig,
  type ForwarderConfigInput,
  type ModelConfig,
  type ModelConfigInput,
  type UpstreamConfig,
} from "./types";
import { parseYaml } from "./yaml";

function normalizeFormat(format: string): ApiFormat {
  switch (format) {
    case "claude":
      return "claude";
    case "openai":
    case "openai-compatible":
      return "openai";
    case "response":
    case "codex":
      return "response";
    case "gemini":
      return "gemini";
    case "gemini-cli":
      return "gemini-cli";
    default:
      throw new Error(`Unsupported API format: ${format}`);
  }
}

function normalizeUpstreamConfig(input: ModelConfigInput): UpstreamConfig {
  if (!input.upstream || typeof input.upstream !== "object") {
    throw new Error(`Model ${input.name} is missing an upstream config`);
  }

  if (!input.upstream.baseUrl) {
    throw new Error(`Model ${input.name} is missing upstream.baseUrl`);
  }

  const format = normalizeFormat(input.upstream.format);

  return {
    baseUrl: input.upstream.baseUrl,
    model: input.upstream.model || input.name,
    format,
    preferResponsesForFiles: input.upstream.preferResponsesForFiles === true,
    apiKey: input.upstream.apiKey ?? { mode: "pass-through" },
    headers: { ...(input.upstream.headers ?? {}) },
  };
}

function normalizeModel(input: ModelConfigInput): ModelConfig {
  if (!input.name) {
    throw new Error("Each model entry must include a name");
  }

  return {
    name: input.name,
    aliases: input.aliases ?? [],
    upstream: normalizeUpstreamConfig(input),
  };
}

export function parseForwarderConfig(input: unknown): ForwarderConfig {
  if (!input || typeof input !== "object") {
    throw new Error("Forwarder config must be an object");
  }

  const value = input as ForwarderConfigInput;
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new Error("Forwarder config must include at least one model");
  }

  return {
    models: value.models.map((model) => normalizeModel(model)),
  };
}

export function loadForwarderConfigFromYaml(text: string): ForwarderConfig {
  return parseForwarderConfig(parseYaml(text));
}

export async function loadForwarderConfigFromFile(path: string): Promise<ForwarderConfig> {
  const text = await readFile(path, "utf8");
  return loadForwarderConfigFromYaml(text);
}

export function findModelConfig(config: ForwarderConfig, modelName: string): ModelConfig | null {
  return (
    config.models.find((model) => model.name === modelName || model.aliases.includes(modelName)) ??
    null
  );
}
