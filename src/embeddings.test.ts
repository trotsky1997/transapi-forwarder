import { describe, expect, test } from "bun:test";
import {
  normalizeEmbeddingRequest,
  normalizeEmbeddingResponse,
  renderEmbeddingRequest,
  renderEmbeddingResponse,
} from "./embeddings";
import type { DetectedEndpoint } from "./types";

describe("embeddings", () => {
  test("maps OpenAI embeddings requests to Gemini batch embeddings", () => {
    const endpoint: DetectedEndpoint = {
      format: "openai",
      operation: "embeddings",
      pathname: "/v1/embeddings",
    };

    const normalized = normalizeEmbeddingRequest(endpoint, {
      model: "text-embedding-3-large",
      input: ["alpha", "beta"],
      dimensions: 256,
    });

    const rendered = renderEmbeddingRequest("gemini", normalized);
    expect(rendered.operation).toBe("batch_embeddings");
    expect(rendered.body).toEqual({
      requests: [
        {
          model: "models/text-embedding-3-large",
          content: { parts: [{ text: "alpha" }] },
          output_dimensionality: 256,
        },
        {
          model: "models/text-embedding-3-large",
          content: { parts: [{ text: "beta" }] },
          output_dimensionality: 256,
        },
      ],
    });
  });

  test("maps Gemini embedContent requests to OpenAI embeddings requests when text-only", () => {
    const endpoint: DetectedEndpoint = {
      format: "gemini",
      operation: "embeddings",
      pathname: "/v1beta/models/gemini-embedding-001:embedContent",
      pathModel: "gemini-embedding-001",
    };

    const normalized = normalizeEmbeddingRequest(endpoint, {
      content: {
        parts: [{ text: "first" }, { text: "second" }],
      },
      output_dimensionality: 768,
    });

    const rendered = renderEmbeddingRequest("openai", normalized);
    expect(rendered).toEqual({
      operation: "embeddings",
      body: {
        model: "gemini-embedding-001",
        input: "first\n\nsecond",
        dimensions: 768,
      },
    });
  });

  test("normalizes Gemini embeddings responses and renders OpenAI embeddings responses", () => {
    const endpoint: DetectedEndpoint = {
      format: "openai",
      operation: "embeddings",
      pathname: "/v1/embeddings",
    };

    const normalized = normalizeEmbeddingResponse("gemini", {
      embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }],
      usageMetadata: { promptTokenCount: 12, totalTokenCount: 12 },
    });
    normalized.model = "text-embedding-3-large";

    expect(
      renderEmbeddingResponse(
        endpoint,
        { model: "text-embedding-3-large", inputs: [{ kind: "text", text: "alpha" }] },
        normalized
      )
    ).toEqual({
      object: "list",
      data: [
        { object: "embedding", index: 0, embedding: [0.1, 0.2] },
        { object: "embedding", index: 1, embedding: [0.3, 0.4] },
      ],
      model: "text-embedding-3-large",
      usage: { prompt_tokens: 12, total_tokens: 12 },
    });
  });

  test("renders Gemini singular embedding responses for embedContent clients", () => {
    const endpoint: DetectedEndpoint = {
      format: "gemini",
      operation: "embeddings",
      pathname: "/v1beta/models/gemini-embedding-001:embedContent",
      pathModel: "gemini-embedding-001",
    };

    const normalized = normalizeEmbeddingResponse("openai", {
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: "text-embedding-3-large",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    expect(
      renderEmbeddingResponse(
        endpoint,
        { model: "gemini-embedding-001", inputs: [{ kind: "text", text: "hello" }] },
        normalized
      )
    ).toEqual({
      embedding: { values: [0.1, 0.2, 0.3] },
      usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 },
    });
  });
});
