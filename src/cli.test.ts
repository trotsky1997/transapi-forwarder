import { afterEach, describe, expect, test } from "bun:test";
import { loadCliConfig, parseCliArgs } from "./cli";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("cli", () => {
  test("parses quick-start CLI args", () => {
    const options = parseCliArgs([
      "--model",
      "gpt-5.4",
      "--alias",
      "gpt54",
      "--from-openai-env",
      "--prefer-responses-for-files",
      "--port",
      "9999",
      "--header",
      "x-test=1",
    ]);

    expect(options).toMatchObject({
      model: "gpt-5.4",
      aliases: ["gpt54"],
      providerEnvPreset: "openai",
      preferResponsesForFiles: true,
      port: 9999,
      headers: { "x-test": "1" },
    });
  });

  test("builds quick-start config from OpenAI env vars", async () => {
    process.env.OPENAI_BASE_URL = "https://cc.macaron.xin/openai/v1";
    process.env.OPENAI_API_KEY = "test-key";

    const config = await loadCliConfig(
      parseCliArgs([
        "--model",
        "gpt-5.4",
        "--from-openai-env",
        "--prefer-responses-for-files",
      ])
    );

    expect(config.models).toHaveLength(1);
    expect(config.models[0]).toMatchObject({
      name: "gpt-5.4",
      upstream: {
        model: "gpt-5.4",
        baseUrl: "https://cc.macaron.xin/openai/v1",
        format: "openai",
        preferResponsesForFiles: true,
        apiKey: {
          mode: "static",
          value: "test-key",
          header: "authorization",
        },
      },
    });
  });

  test("requires model in quick mode", async () => {
    await expect(loadCliConfig(parseCliArgs(["--from-openai-env"]))).rejects.toThrow(
      "Quick mode requires --model"
    );
  });
});
