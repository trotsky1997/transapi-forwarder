import { describe, expect, test } from "bun:test";
import { loadForwarderConfigFromYaml } from "./config";

describe("loadForwarderConfigFromYaml", () => {
  test("parses the forwarding registry from yaml", () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: claude-via-openai
    aliases: [claude-sonnet-4]
    upstream:
      model: claude-sonnet-4-20250514
      baseUrl: https://api.anthropic.com
      format: claude
      preferResponsesForFiles: true
      apiKey:
        mode: pass-through
      headers:
        anthropic-version: "2023-06-01"
`);

    expect(config.models).toHaveLength(1);
    expect(config.models[0]?.name).toBe("claude-via-openai");
    expect(config.models[0]?.aliases).toEqual(["claude-sonnet-4"]);
    expect(config.models[0]?.upstream.format).toBe("claude");
    expect(config.models[0]?.upstream.preferResponsesForFiles).toBe(true);
    expect(config.models[0]?.upstream.headers["anthropic-version"]).toBe("2023-06-01");
  });
});
