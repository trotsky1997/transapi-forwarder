import { describe, expect, test } from "bun:test";
import { buildTargetUrl, detectEndpoint } from "./endpoints";

describe("buildTargetUrl", () => {
  test("appends to a plain host base", () => {
    expect(buildTargetUrl("https://api.example.com", "/v1/messages")).toBe(
      "https://api.example.com/v1/messages"
    );
  });

  test("reuses versioned openai base roots", () => {
    expect(buildTargetUrl("https://cc.macaron.xin/openai/v1", "/v1/chat/completions")).toBe(
      "https://cc.macaron.xin/openai/v1/chat/completions"
    );
  });

  test("reuses versioned gemini base roots", () => {
    expect(
      buildTargetUrl(
        "https://cc.macaron.xin/gemini/v1beta",
        "/v1beta/models/gemini-2.5-flash:generateContent"
      )
    ).toBe("https://cc.macaron.xin/gemini/v1beta/models/gemini-2.5-flash:generateContent");
  });

  test("keeps full endpoint bases intact", () => {
    expect(buildTargetUrl("https://api.example.com/custom/v1/messages", "/v1/messages")).toBe(
      "https://api.example.com/custom/v1/messages"
    );
  });

  test("detects claude count_tokens endpoints", () => {
    expect(detectEndpoint(new URL("https://forwarder.local/v1/messages/count_tokens"))).toEqual({
      format: "claude",
      operation: "count_tokens",
      pathname: "/v1/messages/count_tokens",
    });
  });

  test("detects gemini countTokens endpoints", () => {
    expect(
      detectEndpoint(new URL("https://forwarder.local/v1beta/models/gemini-2.5-flash:countTokens"))
    ).toEqual({
      format: "gemini",
      operation: "count_tokens",
      pathModel: "gemini-2.5-flash",
      pathname: "/v1beta/models/gemini-2.5-flash:countTokens",
    });
  });

  test("detects openai embeddings endpoints", () => {
    expect(detectEndpoint(new URL("https://forwarder.local/v1/embeddings"))).toEqual({
      format: "openai",
      operation: "embeddings",
      pathname: "/v1/embeddings",
    });
  });

  test("detects response compact endpoints", () => {
    expect(detectEndpoint(new URL("https://forwarder.local/v1/responses/compact"))).toEqual({
      format: "response",
      operation: "compact",
      pathname: "/v1/responses/compact",
    });
  });

  test("detects gemini batchEmbedContents endpoints", () => {
    expect(
      detectEndpoint(
        new URL("https://forwarder.local/v1beta/models/gemini-embedding-001:batchEmbedContents")
      )
    ).toEqual({
      format: "gemini",
      operation: "batch_embeddings",
      pathModel: "gemini-embedding-001",
      pathname: "/v1beta/models/gemini-embedding-001:batchEmbedContents",
    });
  });
});
