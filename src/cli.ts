#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadForwarderConfigFromFile, parseForwarderConfig } from "./config";
import { createUniversalForwarder } from "./handler";
import type { ApiKeyHeader, ConfigApiFormat, ForwarderConfig, ForwarderConfigInput } from "./types";
import { createKeepAliveFetch } from "./upstream-fetch";

type ProviderEnvPreset = "openai" | "anthropic" | "gemini";

export interface CliOptions {
  configPath?: string;
  host: string;
  port: number;
  model?: string;
  aliases: string[];
  upstreamModel?: string;
  upstreamFormat?: ConfigApiFormat;
  upstreamBaseUrl?: string;
  apiKey?: string;
  apiKeyMode?: "static" | "pass-through" | "none";
  apiKeyHeader?: ApiKeyHeader;
  preferResponsesForFiles: boolean;
  headers: Record<string, string>;
  providerEnvPreset?: ProviderEnvPreset;
  quiet: boolean;
  help: boolean;
}

function printHelp(): void {
  console.log(`transapi-forwarder

Start a local HTTP server that exposes the forwarder over a simple CLI.

Usage:
  transapi-forwarder --config ./models.yaml [--host 127.0.0.1] [--port 8787]
  transapi-forwarder --model gpt-5.4 --from-openai-env [--prefer-responses-for-files]
  transapi-forwarder --model claude-proxy --upstream-format claude --upstream-base-url https://api.anthropic.com --api-key sk-...\n
Options:
  --config <path>                 Load a YAML model registry from disk
  --host <host>                   Bind host (default: 127.0.0.1 or TRANSAPI_HOST)
  --port <port>                   Bind port (default: 8787 or TRANSAPI_PORT)
  --model <name>                  Exposed downstream model name for quick single-model mode
  --alias <name>                  Additional alias for quick single-model mode (repeatable)
  --upstream-model <name>         Upstream model name (defaults to --model)
  --upstream-format <format>      claude | openai | response | gemini | gemini-cli
  --upstream-base-url <url>       Upstream base URL
  --api-key <value>               Static upstream API key
  --api-key-mode <mode>           static | pass-through | none (default: static when key exists, else pass-through)
  --api-key-header <header>       authorization | x-api-key | x-goog-api-key | query:key
  --header <name=value>           Extra upstream header (repeatable)
  --prefer-responses-for-files    Prefer Responses routing for file-bearing OpenAI-compatible requests
  --from-openai-env               Fill quick-mode upstream settings from OPENAI_BASE_URL / OPENAI_API_KEY
  --from-anthropic-env            Fill quick-mode upstream settings from ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
  --from-gemini-env               Fill quick-mode upstream settings from GEMINI_BASE_URL / GEMINI_API_KEY
  --quiet                         Suppress per-request logs
  -h, --help                      Show this help

Examples:
  transapi-forwarder --config ./models.yaml
  transapi-forwarder --model gpt-5.4 --from-openai-env --prefer-responses-for-files
  transapi-forwarder --model claude-via-router --upstream-format claude --upstream-base-url https://router.example/v1 --api-key ... --api-key-header x-api-key
`);
}

function parseInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flag}: ${value}`);
  }
  return parsed;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    host: process.env.TRANSAPI_HOST ?? "127.0.0.1",
    port: parseInteger(process.env.TRANSAPI_PORT ?? "8787", "TRANSAPI_PORT"),
    aliases: [],
    preferResponsesForFiles: false,
    headers: {},
    quiet: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "serve") {
      continue;
    }

    const next = (): string => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${argument}`);
      }
      index += 1;
      return value;
    };

    switch (argument) {
      case "--config":
        options.configPath = next();
        break;
      case "--host":
        options.host = next();
        break;
      case "--port":
        options.port = parseInteger(next(), "--port");
        break;
      case "--model":
        options.model = next();
        break;
      case "--alias":
        options.aliases.push(next());
        break;
      case "--upstream-model":
        options.upstreamModel = next();
        break;
      case "--upstream-format": {
        const value = next();
        if (
          value !== "claude" &&
          value !== "openai" &&
          value !== "openai-compatible" &&
          value !== "response" &&
          value !== "codex" &&
          value !== "gemini" &&
          value !== "gemini-cli"
        ) {
          throw new Error(`Unsupported --upstream-format: ${value}`);
        }
        options.upstreamFormat = value;
        break;
      }
      case "--upstream-base-url":
        options.upstreamBaseUrl = next();
        break;
      case "--api-key":
        options.apiKey = next();
        break;
      case "--api-key-mode": {
        const value = next();
        if (value !== "static" && value !== "pass-through" && value !== "none") {
          throw new Error(`Unsupported --api-key-mode: ${value}`);
        }
        options.apiKeyMode = value;
        break;
      }
      case "--api-key-header": {
        const value = next();
        if (
          value !== "authorization" &&
          value !== "x-api-key" &&
          value !== "x-goog-api-key" &&
          value !== "query:key"
        ) {
          throw new Error(`Unsupported --api-key-header: ${value}`);
        }
        options.apiKeyHeader = value;
        break;
      }
      case "--header": {
        const value = next();
        const separator = value.indexOf("=");
        if (separator <= 0) {
          throw new Error(`Headers must use name=value format: ${value}`);
        }
        const name = value.slice(0, separator).trim();
        const headerValue = value.slice(separator + 1).trim();
        if (!name) {
          throw new Error(`Headers must include a name: ${value}`);
        }
        options.headers[name] = headerValue;
        break;
      }
      case "--prefer-responses-for-files":
        options.preferResponsesForFiles = true;
        break;
      case "--from-openai-env":
        options.providerEnvPreset = "openai";
        break;
      case "--from-anthropic-env":
        options.providerEnvPreset = "anthropic";
        break;
      case "--from-gemini-env":
        options.providerEnvPreset = "gemini";
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function applyProviderEnvPreset(options: CliOptions): void {
  switch (options.providerEnvPreset) {
    case "openai":
      options.upstreamFormat ??= "openai";
      options.upstreamBaseUrl ??= process.env.OPENAI_BASE_URL;
      options.apiKey ??= process.env.OPENAI_API_KEY;
      options.apiKeyHeader ??= "authorization";
      break;
    case "anthropic":
      options.upstreamFormat ??= "claude";
      options.upstreamBaseUrl ??= process.env.ANTHROPIC_BASE_URL;
      options.apiKey ??= process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
      options.apiKeyHeader ??= "x-api-key";
      break;
    case "gemini":
      options.upstreamFormat ??= "gemini";
      options.upstreamBaseUrl ??= process.env.GEMINI_BASE_URL;
      options.apiKey ??= process.env.GEMINI_API_KEY;
      options.apiKeyHeader ??= "x-goog-api-key";
      break;
    default:
      break;
  }
}

export async function loadCliConfig(options: CliOptions): Promise<ForwarderConfig> {
  if (options.configPath) {
    return loadForwarderConfigFromFile(options.configPath);
  }

  applyProviderEnvPreset(options);

  if (!options.model) {
    throw new Error("Quick mode requires --model when --config is not provided");
  }
  if (!options.upstreamFormat) {
    throw new Error("Quick mode requires --upstream-format, or a provider preset such as --from-openai-env");
  }
  if (!options.upstreamBaseUrl) {
    throw new Error("Quick mode requires --upstream-base-url, or a provider preset environment variable");
  }

  const apiKeyMode = options.apiKeyMode ?? (options.apiKey ? "static" : "pass-through");
  const input: ForwarderConfigInput = {
    models: [
      {
        name: options.model,
        ...(options.aliases.length > 0 ? { aliases: options.aliases } : {}),
        upstream: {
          model: options.upstreamModel ?? options.model,
          format: options.upstreamFormat,
          baseUrl: options.upstreamBaseUrl,
          preferResponsesForFiles: options.preferResponsesForFiles,
          headers: options.headers,
          apiKey:
            apiKeyMode === "none"
              ? { mode: "none" }
              : apiKeyMode === "pass-through"
                ? {
                    mode: "pass-through",
                    ...(options.apiKeyHeader ? { header: options.apiKeyHeader } : {}),
                  }
                : {
                    mode: "static",
                    value: options.apiKey ?? "",
                    ...(options.apiKeyHeader ? { header: options.apiKeyHeader } : {}),
                  },
        },
      },
    ],
  };

  if (apiKeyMode === "static" && !options.apiKey) {
    throw new Error("Static API key mode requires --api-key or a provider preset API key env var");
  }

  return parseForwarderConfig(input);
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks);
  return body.length > 0 ? body : undefined;
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }
    headers.set(key, value);
  }

  const protocol = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
  const host = request.headers.host ?? "127.0.0.1";
  const url = `${protocol}://${host}${request.url ?? "/"}`;
  const body = await readRequestBody(request);

  return new Request(url, {
    method: request.method,
    headers,
    ...(body ? { body } : {}),
  });
}

async function writeWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  target.statusMessage = response.statusText;

  for (const [key, value] of response.headers.entries()) {
    target.setHeader(key, value);
  }

  if (!response.body) {
    target.end();
    return;
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    Readable.fromWeb(response.body as never).pipe(target);
    target.on("finish", () => resolvePromise());
    target.on("error", (error) => rejectPromise(error));
  });
}

export async function startCliServer(options: CliOptions): Promise<void> {
  const config = await loadCliConfig(options);
  const pooledFetch = createKeepAliveFetch();
  const forwarder = createUniversalForwarder({ config, fetch: pooledFetch });

  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    try {
      const webRequest = await toWebRequest(request);
      const webResponse = await forwarder.handle(webRequest);
      await writeWebResponse(webResponse, response);

      if (!options.quiet) {
        console.log(
          `${request.method ?? "GET"} ${request.url ?? "/"} ${webResponse.status} ${Date.now() - startedAt}ms`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { message } }));
      console.error(`Request failed: ${message}`);
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port, options.host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const modelNames = config.models.map((model) => model.name).join(", ");
  console.log(`transapi-forwarder listening on http://${options.host}:${options.port}`);
  console.log(`Models: ${modelNames}`);

  const shutdown = () => {
    pooledFetch.close();
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  await startCliServer(options);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
