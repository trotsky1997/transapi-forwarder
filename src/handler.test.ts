import { describe, expect, test } from "bun:test";
import { loadForwarderConfigFromYaml } from "./config";
import { createUniversalForwarder } from "./handler";

describe("createUniversalForwarder", () => {
  test("converts OpenAI chat requests into Claude upstream requests", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: claude-via-openai
    upstream:
      model: claude-sonnet-4-20250514
      baseUrl: https://api.anthropic.com
      format: claude
      apiKey:
        mode: pass-through
      headers:
        anthropic-version: "2023-06-01"
`);

    let capturedUrl = "";
    let capturedHeaders = new Headers();
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));

        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [{ type: "text", text: "hi from claude" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 12, output_tokens: 6 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-via-openai",
          messages: [
            { role: "system", content: "You are precise." },
            { role: "user", content: "Say hi" },
          ],
        }),
      })
    );

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedHeaders.get("x-api-key")).toBe("downstream-key");
    expect(capturedHeaders.get("anthropic-version")).toBe("2023-06-01");
    expect(capturedBody.model).toBe("claude-sonnet-4-20250514");
    expect(capturedBody.system).toBe("You are precise.");
    expect(capturedBody.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Say hi" }],
      },
    ]);

    const json = (await response.json()) as Record<string, any>;
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("hi from claude");
    expect(json.usage.prompt_tokens).toBe(12);
    expect(json.usage.completion_tokens).toBe(6);
  });

  test("converts Claude requests into Responses API upstream requests", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: codex-via-claude
    upstream:
      model: gpt-5.1-codex
      baseUrl: https://api.openai.com
      format: response
      apiKey:
        mode: pass-through
`);

    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders = new Headers();

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            created: 1,
            model: "gpt-5.1-codex",
            status: "completed",
            output: [
              {
                id: "out_1",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "done" }],
              },
            ],
            usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codex-via-claude",
          max_tokens: 1024,
          system: "You are helpful.",
          messages: [{ role: "user", content: "Write code" }],
        }),
      })
    );

    expect(capturedHeaders.get("authorization")).toBe("Bearer downstream-key");
    expect(capturedBody.model).toBe("gpt-5.1-codex");
    expect(capturedBody.instructions).toBe("You are helpful.");
    expect(capturedBody.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "Write code" }],
      },
    ]);

    const json = (await response.json()) as Record<string, any>;
    expect(json.type).toBe("message");
    expect(json.content[0].text).toBe("done");
    expect(json.usage.input_tokens).toBe(20);
    expect(json.usage.output_tokens).toBe(4);
  });

  test("maps Claude compaction requests onto Responses upstream compaction fields", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: codex-compact-via-claude
    upstream:
      model: gpt-5.1-codex
      baseUrl: https://api.openai.com
      format: response
      apiKey:
        mode: pass-through
`);

    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            model: "gpt-5.1-codex",
            status: "completed",
            output: [
              { id: "cmp_1", type: "compaction_summary", encrypted_content: "opaque-summary-token" },
              {
                id: "msg_1",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "done" }],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codex-compact-via-claude",
          max_tokens: 1024,
          messages: [
            { role: "user", content: "Start the task" },
            {
              role: "assistant",
              content: [
                { type: "compaction", content: "opaque-summary-token" },
                { type: "text", text: "Continuing now" },
              ],
            },
          ],
          context_management: {
            edits: [
              {
                type: "compact_20260112",
                trigger: { type: "input_tokens", value: 180000 },
                pause_after_compaction: true,
              },
            ],
          },
        }),
      })
    );

    expect(capturedBody).toEqual({
      model: "gpt-5.1-codex",
      stream: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "Start the task" }] },
        { type: "compaction", encrypted_content: "opaque-summary-token" },
        { role: "assistant", content: [{ type: "output_text", text: "Continuing now" }] },
      ],
      max_output_tokens: 1024,
      context_management: [{ type: "compaction", compact_threshold: 180000 }],
    });

    expect((await response.json()) as Record<string, any>).toMatchObject({
      type: "message",
      content: [
        { type: "compaction", content: "opaque-summary-token" },
        { type: "text", text: "done" },
      ],
    });
  });

  test("routes Claude compaction requests to responses upstream when provider is openai-compatible", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: macaron-claude-compact
    upstream:
      model: gpt-5.4
      baseUrl: https://cc.macaron.xin/openai/v1
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ object: "response", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "macaron-claude-compact",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Start the task" }],
          context_management: {
            edits: [
              {
                type: "compact_20260112",
                trigger: { type: "input_tokens", value: 180000 },
              },
            ],
          },
        }),
      })
    );

    expect(result.passthrough).toBe(false);
    expect(capturedUrl).toBe("https://cc.macaron.xin/openai/v1/responses");
    expect(capturedBody).toMatchObject({
      model: "gpt-5.4",
      stream: true,
      context_management: [{ type: "compaction", compact_threshold: 180000 }],
    });
  });

  test("maps Responses compaction requests onto Claude upstream blocks and beta header", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: claude-compact-via-response
    upstream:
      model: claude-sonnet-4-6
      baseUrl: https://api.anthropic.com
      format: claude
      apiKey:
        mode: pass-through
      headers:
        anthropic-version: "2023-06-01"
`);

    let capturedHeaders = new Headers();
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            content: [
              { type: "compaction", content: "opaque-summary-token" },
              { type: "text", text: "done" },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-compact-via-response",
          input: [
            { role: "user", content: [{ type: "input_text", text: "Start the task" }] },
            { id: "cmp_1", type: "compaction_summary", encrypted_content: "opaque-summary-token" },
            { role: "user", content: [{ type: "input_text", text: "Continue" }] },
          ],
          context_management: [{ type: "compaction", compact_threshold: 220000 }],
        }),
      })
    );

    expect(capturedHeaders.get("anthropic-beta")).toContain("compact-2026-01-12");
    expect(capturedBody).toEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "Start the task" }] },
        { role: "assistant", content: [{ type: "compaction", content: "opaque-summary-token" }] },
        { role: "user", content: [{ type: "text", text: "Continue" }] },
      ],
      context_management: {
        edits: [
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 220000 },
          },
        ],
      },
    });

    expect((await response.json()) as Record<string, any>).toMatchObject({
      object: "response",
      output: [
        { type: "compaction" },
        { type: "message", content: [{ type: "output_text", text: "done" }] },
      ],
    });
  });

  test("preserves Claude compaction usage iterations on Responses downstream payloads", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: claude-compact-usage-via-response
    upstream:
      model: claude-sonnet-4-6
      baseUrl: https://api.anthropic.com
      format: claude
      apiKey:
        mode: pass-through
      headers:
        anthropic-version: "2023-06-01"
`);

    const forwarder = createUniversalForwarder({
      config,
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: "msg_usage_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "done" }],
            usage: {
              input_tokens: 23000,
              output_tokens: 1000,
              iterations: [
                { type: "compaction", input_tokens: 180000, output_tokens: 3500 },
                { type: "message", input_tokens: 23000, output_tokens: 1000 },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        ),
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-compact-usage-via-response",
          input: [{ role: "user", content: [{ type: "input_text", text: "Continue" }] }],
        }),
      })
    );

    expect((await response.json()) as Record<string, any>).toMatchObject({
      usage: {
        input_tokens: 23000,
        output_tokens: 1000,
        total_tokens: 24000,
        iterations: [
          { type: "compaction", input_tokens: 180000, output_tokens: 3500 },
          { type: "message", input_tokens: 23000, output_tokens: 1000 },
        ],
      },
    });
  });

  test("passes through same-format streaming responses", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: openai-direct
    upstream:
      model: gpt-4.1
      baseUrl: https://api.openai.com
      format: openai
      apiKey:
        mode: pass-through
`);

    const forwarder = createUniversalForwarder({
      config,
      fetch: async () =>
        new Response("data: {\"ok\":true}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    const result = await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "openai-direct",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
    );

    expect(result.passthrough).toBe(true);
    expect(await result.response.text()).toBe("data: {\"ok\":true}\n\n");
  });

  test("rejects conflicting downstream credentials", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: openai-direct
    upstream:
      model: gpt-4.1
      baseUrl: https://api.openai.com
      format: openai
      apiKey:
        mode: pass-through
`);

    const forwarder = createUniversalForwarder({
      config,
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/chat/completions?key=query-key", {
        method: "POST",
        headers: {
          authorization: "Bearer header-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "openai-direct",
          messages: [{ role: "user", content: "hello" }],
        }),
      })
    );

    expect(response.status).toBe(401);
    const json = (await response.json()) as Record<string, any>;
    expect(json.error.message).toContain("Conflicting API credentials");
    expect(json.error.code).toBe("invalid_api_key");
  });

  test("supports claude count_tokens passthrough for claude upstreams", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: claude-direct
    upstream:
      model: claude-sonnet-4-20250514
      baseUrl: https://api.anthropic.com
      format: claude
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ input_tokens: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/messages/count_tokens", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-direct",
          system: "Be exact",
          messages: [{ role: "user", content: "hello" }],
        }),
      })
    );

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    expect(capturedBody).toEqual({
      model: "claude-sonnet-4-20250514",
      system: "Be exact",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    expect(await response.json()).toEqual({ input_tokens: 42 });
  });

  test("preserves claude compaction count_tokens fields and beta header", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: claude-direct
    upstream:
      model: claude-sonnet-4-6
      baseUrl: https://api.anthropic.com
      format: claude
      apiKey:
        mode: pass-through
      headers:
        anthropic-version: "2023-06-01"
`);

    let capturedHeaders = new Headers();
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            input_tokens: 42000,
            context_management: { original_input_tokens: 180000 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/messages/count_tokens", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-direct",
          system: "Keep state tight.",
          messages: [
            {
              role: "assistant",
              content: [{ type: "compaction", content: "opaque-summary-token" }],
            },
            { role: "user", content: "Continue." },
          ],
          context_management: {
            edits: [
              {
                type: "compact_20260112",
                trigger: { type: "input_tokens", value: 175000 },
                instructions: "Preserve code-level details.",
                pause_after_compaction: true,
              },
            ],
          },
        }),
      })
    );

    expect(capturedHeaders.get("anthropic-beta")).toContain("compact-2026-01-12");
    expect(capturedBody).toEqual({
      model: "claude-sonnet-4-6",
      system: "Keep state tight.",
      messages: [
        {
          role: "assistant",
          content: [{ type: "compaction", content: "opaque-summary-token" }],
        },
        { role: "user", content: [{ type: "text", text: "Continue." }] },
      ],
      context_management: {
        edits: [
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 175000 },
            instructions: "Preserve code-level details.",
            pause_after_compaction: true,
          },
        ],
      },
    });
    expect(await response.json()).toEqual({
      input_tokens: 42000,
      context_management: { original_input_tokens: 180000 },
    });
  });

  test("rectifies response input strings before passthrough", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: response-direct
    upstream:
      model: gpt-5.1-codex
      baseUrl: https://api.openai.com
      format: response
      apiKey:
        mode: pass-through
`);

    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ object: "response", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "response-direct",
          input: "hello",
        }),
      })
    );

    expect(result.passthrough).toBe(true);
    expect(capturedBody).toEqual({
      model: "gpt-5.1-codex",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    });
  });

  test("strips Claude billing header blocks before forwarding", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: claude-direct
    upstream:
      model: claude-sonnet-4-20250514
      baseUrl: https://api.anthropic.com
      format: claude
      apiKey:
        mode: pass-through
`);

    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    await forwarder.handle(
      new Request("https://forwarder.local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-direct",
          max_tokens: 64,
          system: [
            { type: "text", text: "x-anthropic-billing-header: team=alpha" },
            { type: "text", text: "Keep answers short." },
          ],
          messages: [{ role: "user", content: "hello" }],
        }),
      })
    );

    expect(capturedBody).toEqual({
      model: "claude-sonnet-4-20250514",
      max_tokens: 64,
      system: [{ type: "text", text: "Keep answers short." }],
      messages: [{ role: "user", content: "hello" }],
    });
  });

  test("retries Claude requests after rectifying low thinking budgets", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: claude-direct
    upstream:
      model: claude-sonnet-4-20250514
      baseUrl: https://api.anthropic.com
      format: claude
      apiKey:
        mode: pass-through
`);

    const capturedBodies: Array<Record<string, unknown>> = [];

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedBodies.push(JSON.parse(String(init?.body ?? "{}")));

        if (capturedBodies.length === 1) {
          return new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "thinking budget_tokens must be greater than or equal to 1024",
              },
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            }
          );
        }

        return new Response(
          JSON.stringify({
            id: "msg_retry_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-direct",
          max_tokens: 4096,
          thinking: { type: "enabled", budget_tokens: 512 },
          messages: [{ role: "user", content: "hello" }],
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[0]).toMatchObject({
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 512 },
    });
    expect(capturedBodies[1]).toMatchObject({
      max_tokens: 64000,
      thinking: { type: "enabled", budget_tokens: 32000 },
    });
  });

  test("retries Claude requests after rectifying thinking signature issues", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: claude-direct
    upstream:
      model: claude-sonnet-4-20250514
      baseUrl: https://api.anthropic.com
      format: claude
      apiKey:
        mode: pass-through
`);

    const capturedBodies: Array<Record<string, unknown>> = [];

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedBodies.push(JSON.parse(String(init?.body ?? "{}")));

        if (capturedBodies.length === 1) {
          return new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "messages.0.content.0.signature: Field required",
              },
            }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            }
          );
        }

        return new Response(
          JSON.stringify({
            id: "msg_retry_2",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-direct",
          max_tokens: 256,
          thinking: { type: "enabled", budget_tokens: 2048 },
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "secret", signature: "sig_a" },
                { type: "redacted_thinking", data: "encrypted" },
                { type: "tool_use", id: "tool_1", name: "Read", input: {}, signature: "sig_b" },
              ],
            },
          ],
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[1]).toEqual({
      model: "claude-sonnet-4-20250514",
      max_tokens: 256,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_1", name: "Read", input: {} }],
        },
      ],
    });
  });

  test("passes through same-format non-stream requests and preserves vendor fields", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: openai-direct
    upstream:
      model: gpt-4.1
      baseUrl: https://api.openai.com
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "chatcmpl_1",
            object: "chat.completion",
            model: "gpt-4.1",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            vendor_field: "kept",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "openai-direct",
          messages: [{ role: "user", content: "hello" }],
          metadata: { trace: "1" },
          response_format: { type: "json_schema" },
        }),
      })
    );

    expect(capturedBody).toMatchObject({
      model: "gpt-4.1",
      metadata: { trace: "1" },
      response_format: { type: "json_schema" },
    });
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      vendor_field: "kept",
      model: "gpt-4.1",
    });
  });

  test("passes through response compact requests for response upstreams", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: codex-compact
    upstream:
      model: gpt-5.1-codex
      baseUrl: https://api.openai.com
      format: response
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const rawResponse = JSON.stringify({
      id: "resp_cmp_1",
      object: "response.compaction",
      output: [
        { id: "msg_1", type: "message", role: "user", status: "completed", content: [{ type: "input_text", text: "hello" }] },
        { id: "cmp_1", type: "compaction_summary", encrypted_content: "opaque-token" },
      ],
    });

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(rawResponse, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "codex-compact",
          input: [
            { role: "user", content: "hello" },
            {
              id: "msg_prev",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "hi" }],
            },
          ],
        }),
      })
    );

    expect(result.passthrough).toBe(true);
    expect(capturedUrl).toBe("https://api.openai.com/v1/responses/compact");
    expect(capturedBody).toEqual({
      model: "gpt-5.1-codex",
      input: [
        { role: "user", content: "hello" },
        {
          id: "msg_prev",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hi" }],
        },
      ],
    });
    const json = (await result.response.json()) as Record<string, any>;
    expect(json.object).toBe("response.compaction");
    expect(Array.isArray(json.output)).toBe(true);
    expect(json.output.some((item: Record<string, any>) => item.type === "compaction_summary" && item.encrypted_content === "opaque-token")).toBe(true);
  });

  test("routes response compact requests to responses/compact for openai-compatible upstreams", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: macaron-compact
    upstream:
      model: gpt-5.4
      baseUrl: https://cc.macaron.xin/openai/v1
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ object: "response.compaction", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "macaron-compact",
          input: [{ role: "user", content: "compact this" }],
        }),
      })
    );

    expect(result.passthrough).toBe(true);
    expect(capturedUrl).toBe("https://cc.macaron.xin/openai/v1/responses/compact");
    expect(capturedBody).toEqual({
      model: "gpt-5.4",
      input: [{ role: "user", content: "compact this" }],
    });
  });

  test("routes response requests with context_management to native responses upstream for openai-compatible providers", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: macaron-context-managed
    upstream:
      model: gpt-5.4
      baseUrl: https://cc.macaron.xin/openai/v1
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const rawResponse = JSON.stringify({
      id: "resp_1",
      object: "response",
      output: [{ id: "cmp_1", type: "compaction_summary", encrypted_content: "opaque-token" }],
    });

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(rawResponse, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "macaron-context-managed",
          input: [{ role: "user", content: "Start a long task" }],
          context_management: [{ type: "compaction", compact_threshold: 200000 }],
          store: false,
        }),
      })
    );

    expect(result.passthrough).toBe(false);
    expect(capturedUrl).toBe("https://cc.macaron.xin/openai/v1/responses");
    expect(capturedBody).toEqual({
      model: "gpt-5.4",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "Start a long task" }] }],
      context_management: [{ type: "compaction", compact_threshold: 200000 }],
      store: false,
    });
    expect((await result.response.json()) as Record<string, any>).toMatchObject({
      object: "response",
      output: [{ type: "compaction_summary", encrypted_content: "opaque-token" }],
    });
  });

  test("routes response requests with compaction items to native responses upstream for openai-compatible providers", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: macaron-compacted-history
    upstream:
      model: gpt-5.4
      baseUrl: https://cc.macaron.xin/openai/v1
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ object: "response", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "macaron-compacted-history",
          input: [
            { role: "user", content: "Continue" },
            { id: "cmp_1", type: "compaction_summary", encrypted_content: "opaque-token" },
          ],
        }),
      })
    );

    expect(result.passthrough).toBe(false);
    expect(capturedUrl).toBe("https://cc.macaron.xin/openai/v1/responses");
    expect(capturedBody).toEqual({
      model: "gpt-5.4",
      stream: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "Continue" }] },
        { type: "compaction_summary", encrypted_content: "opaque-token" },
      ],
    });
  });

  test("converts openai chat-shaped compact requests into responses compact input", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: compact-openai-source
    upstream:
      model: gpt-5.4
      baseUrl: https://api.openai.com
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ object: "response.compaction", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "compact-openai-source",
          messages: [
            { role: "system", content: "Be concise." },
            { role: "user", content: "Summarize this conversation." },
          ],
          max_tokens: 512,
        }),
      })
    );

    expect(result.passthrough).toBe(true);
    expect(capturedBody).toEqual({
      model: "gpt-5.4",
      instructions: "Be concise.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Summarize this conversation." }],
        },
      ],
    });
  });

  test("converts claude-shaped compact requests into responses compact input", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: compact-claude-source
    upstream:
      model: gpt-5.4
      baseUrl: https://api.openai.com
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ object: "response.compaction", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "compact-claude-source",
          system: "Keep only the essential state.",
          max_tokens: 256,
          messages: [{ role: "user", content: "Compact this thread." }],
        }),
      })
    );

    expect(capturedBody).toEqual({
      model: "gpt-5.4",
      instructions: "Keep only the essential state.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Compact this thread." }],
        },
      ],
    });
  });

  test("converts gemini-shaped compact requests into responses compact input", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: compact-gemini-source
    upstream:
      model: gpt-5.4
      baseUrl: https://api.openai.com
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ object: "response.compaction", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "compact-gemini-source",
          systemInstruction: { parts: [{ text: "Preserve the coding plan." }] },
          contents: [
            { role: "user", parts: [{ text: "Summarize the current coding context." }] },
          ],
        }),
      })
    );

    expect(capturedBody).toEqual({
      model: "gpt-5.4",
      instructions: "Preserve the coding plan.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Summarize the current coding context." }],
        },
      ],
    });
  });

  test("rejects response compact requests for non-responses upstreams", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: claude-compact
    upstream:
      model: claude-sonnet-4-20250514
      baseUrl: https://api.anthropic.com
      format: claude
      apiKey:
        mode: pass-through
`);

    const forwarder = createUniversalForwarder({
      config,
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/responses/compact", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-compact",
          input: [{ role: "user", content: "compact this" }],
        }),
      })
    );

    expect(response.status).toBe(501);
    expect((await response.json()) as Record<string, any>).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "unsupported_operation",
        message: "Compaction is only supported for Responses/OpenAI-compatible upstreams",
      },
    });
  });

  test("passes through OpenRouter PDF chat payloads and annotations on same-format OpenAI routes", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: openrouter-pdf-direct
    upstream:
      model: anthropic/claude-sonnet-4
      baseUrl: https://openrouter.ai/api/v1
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "chatcmpl_pdf_1",
            object: "chat.completion",
            model: "anthropic/claude-sonnet-4",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "The document discusses Bitcoin.",
                  annotations: [
                    {
                      type: "file",
                      file: {
                        hash: "abc123",
                        name: "document.pdf",
                        content: [{ type: "text", text: "Bitcoin: A Peer-to-Peer Electronic Cash System" }],
                      },
                    },
                  ],
                },
                finish_reason: "stop",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const result = await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "openrouter-pdf-direct",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Summarize this PDF" },
                {
                  type: "file",
                  file: {
                    filename: "document.pdf",
                    file_data: "https://bitcoin.org/bitcoin.pdf",
                  },
                },
              ],
            },
          ],
          plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }],
        }),
      })
    );

    expect(result.passthrough).toBe(true);
    expect(capturedBody).toEqual({
      model: "anthropic/claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize this PDF" },
            {
              type: "file",
              file: {
                filename: "document.pdf",
                file_data: "https://bitcoin.org/bitcoin.pdf",
              },
            },
          ],
        },
      ],
      plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }],
    });
    expect((await result.response.json()) as Record<string, any>).toMatchObject({
      choices: [
        {
          message: {
            annotations: [
              {
                type: "file",
                file: {
                  hash: "abc123",
                  name: "document.pdf",
                },
              },
            ],
          },
        },
      ],
    });
  });

  test("prefers response upstream for file-bearing OpenAI requests when configured", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: macaron-files-via-openai
    upstream:
      model: gpt-5.4
      baseUrl: https://cc.macaron.xin/openai/v1
      format: openai
      preferResponsesForFiles: true
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            model: "gpt-5.4",
            status: "completed",
            output: [
              {
                id: "msg_1",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "Dummy PDF file" }],
              },
            ],
            usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "macaron-files-via-openai",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Read this PDF" },
                {
                  type: "file",
                  file: {
                    filename: "paper.pdf",
                    file_data: "data:application/pdf;base64,JVBERi0xLjQK",
                  },
                },
              ],
            },
          ],
        }),
      })
    );

    expect(capturedUrl).toBe("https://cc.macaron.xin/openai/v1/responses");
    expect(capturedBody).toEqual({
      model: "gpt-5.4",
      stream: true,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Read this PDF" },
            {
              type: "input_file",
              filename: "paper.pdf",
              file_data: "data:application/pdf;base64,JVBERi0xLjQK",
            },
          ],
        },
      ],
    });
    expect((await response.json()) as Record<string, any>).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "Dummy PDF file" } }],
    });
  });

  test("prefers response upstream for file-bearing Claude requests when configured", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: macaron-files-via-claude
    upstream:
      model: gpt-5.4
      baseUrl: https://cc.macaron.xin/openai/v1
      format: openai
      preferResponsesForFiles: true
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            model: "gpt-5.4",
            status: "completed",
            output: [
              {
                id: "msg_1",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "summary" }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "macaron-files-via-claude",
          max_tokens: 64,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  title: "paper.pdf",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: "JVBERi0xLjQK",
                  },
                },
                { type: "text", text: "Summarize this PDF" },
              ],
            },
          ],
        }),
      })
    );

    expect(capturedUrl).toBe("https://cc.macaron.xin/openai/v1/responses");
    expect(capturedBody).toEqual({
      model: "gpt-5.4",
      stream: true,
      max_output_tokens: 64,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "paper.pdf",
              file_data: "data:application/pdf;base64,JVBERi0xLjQK",
            },
            { type: "input_text", text: "Summarize this PDF" },
          ],
        },
      ],
    });
    expect((await response.json()) as Record<string, any>).toMatchObject({
      type: "message",
      content: [{ text: "summary" }],
    });
  });

  test("buffers streamed response upstream back into non-stream OpenAI output when file preference is enabled", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: macaron-files-buffered
    upstream:
      model: gpt-5.4
      baseUrl: https://cc.macaron.xin/openai/v1
      format: openai
      preferResponsesForFiles: true
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          [
            'event: response.created',
            'data: {"type":"response.created","response":{"id":"resp_1"}}',
            '',
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Dummy PDF file"}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5.4","output":[{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Dummy PDF file"}]}],"usage":{"input_tokens":8,"output_tokens":3,"total_tokens":11}}}',
            '',
          ].join('\n'),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "macaron-files-buffered",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Read this PDF" },
                {
                  type: "file",
                  file: {
                    filename: "paper.pdf",
                    file_data: "data:application/pdf;base64,JVBERi0xLjQK",
                  },
                },
              ],
            },
          ],
        }),
      })
    );

    expect(capturedUrl).toBe("https://cc.macaron.xin/openai/v1/responses");
    expect(capturedBody).toEqual({
      model: "gpt-5.4",
      stream: true,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Read this PDF" },
            {
              type: "input_file",
              filename: "paper.pdf",
              file_data: "data:application/pdf;base64,JVBERi0xLjQK",
            },
          ],
        },
      ],
    });

    expect((await response.json()) as Record<string, any>).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "Dummy PDF file" } }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    });
  });

  test("buffers streamed response upstream back into non-stream Claude output when file preference is enabled", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: macaron-claude-buffered
    upstream:
      model: gpt-5.4
      baseUrl: https://cc.macaron.xin/openai/v1
      format: openai
      preferResponsesForFiles: true
      apiKey:
        mode: pass-through
`);

    const forwarder = createUniversalForwarder({
      config,
      fetch: async () =>
        new Response(
          [
            'event: response.created',
            'data: {"type":"response.created","response":{"id":"resp_1"}}',
            '',
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Dummy PDF file"}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5.4","output":[{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Dummy PDF file"}]}],"usage":{"input_tokens":9,"output_tokens":3,"total_tokens":12}}}',
            '',
          ].join('\n'),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }
        ),
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "macaron-claude-buffered",
          max_tokens: 64,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  title: "paper.pdf",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: "JVBERi0xLjQK",
                  },
                },
                { type: "text", text: "Summarize this PDF" },
              ],
            },
          ],
        }),
      })
    );

    expect((await response.json()) as Record<string, any>).toMatchObject({
      type: "message",
      content: [{ text: "Dummy PDF file" }],
      usage: { input_tokens: 9, output_tokens: 3 },
    });
  });

  test("buffers streamed response upstream back into non-stream Claude output for compaction interop", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: macaron-claude-compact-buffered
    upstream:
      model: gpt-5.4
      baseUrl: https://cc.macaron.xin/openai/v1
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          [
            'event: response.created',
            'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4"}}',
            '',
            'event: response.output_item.added',
            'data: {"type":"response.output_item.added","item":{"id":"cmp_1","type":"compaction_summary","encrypted_content":"opaque-summary-token"}}',
            '',
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"done"}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5.4","output":[{"id":"cmp_1","type":"compaction_summary","encrypted_content":"opaque-summary-token"},{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done"}]}],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
            '',
          ].join('\n'),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "macaron-claude-compact-buffered",
          max_tokens: 64,
          messages: [{ role: "user", content: "Continue the task" }],
          context_management: {
            edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 180000 } }],
          },
        }),
      })
    );

    expect(capturedUrl).toBe("https://cc.macaron.xin/openai/v1/responses");
    expect(capturedBody).toMatchObject({
      model: "gpt-5.4",
      stream: true,
      context_management: [{ type: "compaction", compact_threshold: 180000 }],
    });
    expect((await response.json()) as Record<string, any>).toMatchObject({
      type: "message",
      content: [
        { type: "compaction", content: "opaque-summary-token" },
        { type: "text", text: "done" },
      ],
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  });

  test("keeps chat-completions passthrough for non-file OpenAI requests even when file preference is enabled", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: macaron-openai-default
    upstream:
      model: gpt-5.4
      baseUrl: https://cc.macaron.xin/openai/v1
      format: openai
      preferResponsesForFiles: true
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "chatcmpl_1",
            object: "chat.completion",
            model: "gpt-5.4",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const result = await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "macaron-openai-default",
          messages: [{ role: "user", content: "hello" }],
        }),
      })
    );

    expect(result.passthrough).toBe(true);
    expect(capturedUrl).toBe("https://cc.macaron.xin/openai/v1/chat/completions");
    expect(capturedBody).toEqual({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  test("converts OpenAI file content into Claude document blocks", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: claude-files-via-openai
    upstream:
      model: claude-sonnet-4-20250514
      baseUrl: https://api.anthropic.com
      format: claude
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [{ type: "text", text: "summary" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 12, output_tokens: 4 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-files-via-openai",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Summarize this PDF" },
                {
                  type: "file",
                  file: {
                    filename: "paper.pdf",
                    file_data: "data:application/pdf;base64,JVBERi0xLjQK",
                  },
                },
              ],
            },
          ],
        }),
      })
    );

    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedBody).toEqual({
      model: "claude-sonnet-4-20250514",
      stream: false,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize this PDF" },
            {
              type: "document",
              title: "paper.pdf",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "JVBERi0xLjQK",
              },
            },
          ],
        },
      ],
    });

    expect((await response.json()) as Record<string, any>).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "summary" } }],
    });
  });

  test("converts Gemini PDF file parts into OpenAI file content", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: openai-files-via-gemini
    upstream:
      model: gpt-5.1
      baseUrl: https://api.openai.com
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            id: "chatcmpl_1",
            object: "chat.completion",
            model: "gpt-5.1",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "done" },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1beta/models/openai-files-via-gemini:generateContent", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": "downstream-key",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: "Read this" },
                { fileData: { mimeType: "application/pdf", fileUri: "https://example.com/paper.pdf" } },
              ],
            },
          ],
        }),
      })
    );

    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(capturedBody).toEqual({
      model: "gpt-5.1",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read this" },
            {
              type: "file",
              file: {
                filename: "paper.pdf",
                file_data: "https://example.com/paper.pdf",
              },
            },
          ],
        },
      ],
    });

    expect((await response.json()) as Record<string, any>).toMatchObject({
      candidates: [{ content: { parts: [{ text: "done" }] } }],
    });
  });

  test("rejects OpenAI provider file IDs when converting to Gemini file parts", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: gemini-files-via-openai
    upstream:
      model: gemini-2.5-flash
      baseUrl: https://generativelanguage.googleapis.com/v1beta
      format: gemini
      apiKey:
        mode: pass-through
`);

    const forwarder = createUniversalForwarder({
      config,
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gemini-files-via-openai",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "file",
                  file: {
                    file_id: "file_123",
                  },
                },
              ],
            },
          ],
        }),
      })
    );

    expect(response.status).toBe(501);
    expect((await response.json()) as Record<string, any>).toMatchObject({
      error: {
        message: "Gemini parts do not support provider file IDs",
        code: "unsupported_operation",
      },
    });
  });

  test("passes through same-format gemini countTokens requests", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: gemini-direct
    upstream:
      model: gemini-2.5-flash
      baseUrl: https://generativelanguage.googleapis.com/v1beta
      format: gemini
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedHeaders = new Headers();

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ totalTokens: 7 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1beta/models/gemini-direct:countTokens?key=test-key", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        }),
      })
    );

    expect(capturedUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:countTokens"
    );
    expect(capturedHeaders.get("x-goog-api-key")).toBe("test-key");
    expect(await response.json()).toEqual({ totalTokens: 7 });
  });

  test("passes through same-format OpenAI embeddings requests", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: openai-embeddings-direct
    upstream:
      model: text-embedding-3-large
      baseUrl: https://api.openai.com
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
            model: "text-embedding-3-large",
            usage: { prompt_tokens: 2, total_tokens: 2 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const result = await forwarder.handleDetailed(
      new Request("https://forwarder.local/v1/embeddings", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "openai-embeddings-direct",
          input: "hello",
          encoding_format: "base64",
        }),
      })
    );

    expect(result.passthrough).toBe(true);
    expect(capturedUrl).toBe("https://api.openai.com/v1/embeddings");
    expect(capturedBody).toEqual({
      model: "text-embedding-3-large",
      input: "hello",
      encoding_format: "base64",
    });
  });

  test("converts OpenAI embeddings requests into Gemini batch embeddings", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: gemini-embeddings-via-openai
    upstream:
      model: gemini-embedding-001
      baseUrl: https://generativelanguage.googleapis.com/v1beta
      format: gemini
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }],
            usageMetadata: { promptTokenCount: 6, totalTokenCount: 6 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request("https://forwarder.local/v1/embeddings", {
        method: "POST",
        headers: {
          authorization: "Bearer downstream-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gemini-embeddings-via-openai",
          input: ["alpha", "beta"],
          dimensions: 256,
        }),
      })
    );

    expect(capturedUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents"
    );
    expect(capturedBody).toEqual({
      requests: [
        {
          model: "models/gemini-embedding-001",
          content: { parts: [{ text: "alpha" }] },
          output_dimensionality: 256,
        },
        {
          model: "models/gemini-embedding-001",
          content: { parts: [{ text: "beta" }] },
          output_dimensionality: 256,
        },
      ],
    });

    expect((await response.json()) as Record<string, unknown>).toEqual({
      object: "list",
      data: [
        { object: "embedding", index: 0, embedding: [0.1, 0.2] },
        { object: "embedding", index: 1, embedding: [0.3, 0.4] },
      ],
      model: "gemini-embeddings-via-openai",
      usage: { prompt_tokens: 6, total_tokens: 6 },
    });
  });

  test("converts Gemini embedContent requests into OpenAI embeddings", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: openai-embeddings-via-gemini
    upstream:
      model: text-embedding-3-large
      baseUrl: https://api.openai.com
      format: openai
      apiKey:
        mode: pass-through
`);

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const forwarder = createUniversalForwarder({
      config,
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: [0.9, 0.8] }],
            model: "text-embedding-3-large",
            usage: { prompt_tokens: 4, total_tokens: 4 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    const response = await forwarder.handle(
      new Request(
        "https://forwarder.local/v1beta/models/openai-embeddings-via-gemini:embedContent?key=test-key",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            content: {
              parts: [{ text: "hello" }, { text: "world" }],
            },
            output_dimensionality: 512,
          }),
        }
      )
    );

    expect(capturedUrl).toBe("https://api.openai.com/v1/embeddings");
    expect(capturedBody).toEqual({
      model: "text-embedding-3-large",
      input: "hello\n\nworld",
      dimensions: 512,
    });

    expect((await response.json()) as Record<string, unknown>).toEqual({
      embedding: { values: [0.9, 0.8] },
      usageMetadata: { promptTokenCount: 4, totalTokenCount: 4 },
    });
  });

  test("rejects Gemini multimodal embeddings when converting to OpenAI embeddings", async () => {
    const config = loadForwarderConfigFromYaml(`
models:
  - name: openai-embeddings-via-gemini
    upstream:
      model: text-embedding-3-large
      baseUrl: https://api.openai.com
      format: openai
      apiKey:
        mode: pass-through
`);

    const forwarder = createUniversalForwarder({
      config,
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });

    const response = await forwarder.handle(
      new Request(
        "https://forwarder.local/v1beta/models/openai-embeddings-via-gemini:embedContent?key=test-key",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            content: {
              parts: [
                {
                  inline_data: {
                    mime_type: "image/png",
                    data: "AAAA",
                  },
                },
              ],
            },
          }),
        }
      )
    );

    expect(response.status).toBe(501);
    expect((await response.json()) as Record<string, any>).toMatchObject({
      error: {
        message: "Gemini multimodal embeddings cannot be converted to OpenAI /v1/embeddings",
        code: 501,
        status: "INTERNAL",
      },
    });
  });
});
