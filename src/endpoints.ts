import type { ApiFormat, DetectedEndpoint, EndpointOperation } from "./types";

const GEMINI_RE =
  /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents)$/;
const GEMINI_CLI_RE = /^\/v1internal\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/;

export function detectEndpoint(url: URL): DetectedEndpoint {
  const { pathname } = url;

  if (pathname === "/v1/messages/count_tokens") {
    return { format: "claude", operation: "count_tokens", pathname };
  }
  if (pathname === "/v1/messages") {
    return { format: "claude", operation: "generate", pathname };
  }
  if (pathname === "/v1/chat/completions") {
    return { format: "openai", operation: "generate", pathname };
  }
  if (pathname === "/v1/embeddings") {
    return { format: "openai", operation: "embeddings", pathname };
  }
  if (pathname === "/v1/responses/compact") {
    return { format: "response", operation: "compact", pathname };
  }
  if (pathname === "/v1/responses") {
    return { format: "response", operation: "generate", pathname };
  }
  if (pathname === "/v1/models") {
    return { format: "openai", operation: "models", pathname };
  }

  const geminiMatch = pathname.match(GEMINI_RE);
  if (geminiMatch) {
    return {
      format: "gemini",
      operation:
        geminiMatch[2] === "streamGenerateContent"
          ? "stream"
          : geminiMatch[2] === "countTokens"
            ? "count_tokens"
            : geminiMatch[2] === "embedContent"
              ? "embeddings"
              : geminiMatch[2] === "batchEmbedContents"
                ? "batch_embeddings"
            : "generate",
      pathModel: decodeURIComponent(geminiMatch[1]),
      pathname,
    };
  }

  const geminiCliMatch = pathname.match(GEMINI_CLI_RE);
  if (geminiCliMatch) {
    return {
      format: "gemini-cli",
      operation:
        geminiCliMatch[2] === "streamGenerateContent"
          ? "stream"
          : geminiCliMatch[2] === "countTokens"
            ? "count_tokens"
            : "generate",
      pathModel: decodeURIComponent(geminiCliMatch[1]),
      pathname,
    };
  }

  return {
    format: "openai",
    operation: "unsupported",
    pathname,
  };
}

export function buildUpstreamPath(
  format: ApiFormat,
  model: string,
  operation: EndpointOperation
): string {
  switch (format) {
    case "claude":
      return operation === "count_tokens" ? "/v1/messages/count_tokens" : "/v1/messages";
    case "openai":
      return operation === "models"
        ? "/v1/models"
        : operation === "embeddings"
          ? "/v1/embeddings"
          : "/v1/chat/completions";
    case "response":
      return operation === "compact" ? "/v1/responses/compact" : "/v1/responses";
    case "gemini":
      if (operation === "count_tokens") {
        return `/v1beta/models/${encodeURIComponent(model)}:countTokens`;
      }
      if (operation === "embeddings") {
        return `/v1beta/models/${encodeURIComponent(model)}:embedContent`;
      }
      if (operation === "batch_embeddings") {
        return `/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`;
      }
      return `/v1beta/models/${encodeURIComponent(model)}:${
        operation === "stream" ? "streamGenerateContent" : "generateContent"
      }`;
    case "gemini-cli":
      if (operation === "count_tokens") {
        return `/v1internal/models/${encodeURIComponent(model)}:countTokens`;
      }
      return `/v1internal/models/${encodeURIComponent(model)}:${
        operation === "stream" ? "streamGenerateContent" : "generateContent"
      }`;
  }
}

export function buildTargetUrl(baseUrl: string, targetPath: string): string {
  const url = new URL(baseUrl);
  const normalizedBasePath = url.pathname.replace(/\/$/, "");
  const normalizedTargetPath = targetPath.replace(/\/$/, "") || "/";

  if (
    normalizedBasePath === normalizedTargetPath ||
    normalizedBasePath.endsWith(normalizedTargetPath)
  ) {
    url.pathname = normalizedBasePath || normalizedTargetPath;
    return url.toString();
  }

  const versionRootMatch = normalizedTargetPath.match(/^\/(v[^/]+)(\/.*)?$/);
  if (versionRootMatch) {
    const versionRoot = `/${versionRootMatch[1]}`;
    const suffix = versionRootMatch[2] ?? "";
    if (normalizedBasePath === versionRoot || normalizedBasePath.endsWith(versionRoot)) {
      url.pathname = `${normalizedBasePath}${suffix}` || "/";
      return url.toString();
    }
  }

  url.pathname = `${normalizedBasePath}${normalizedTargetPath}` || "/";
  return url.toString();
}
