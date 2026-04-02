import { describe, expect, test } from "bun:test";
import { normalizeRequest, normalizeResponse, renderCountTokensRequest, renderRequest, renderResponse } from "./canonical";

describe("normalizeResponse", () => {
  test("parses response api sse text wrapped as a string", () => {
    const normalized = normalizeResponse(
      "response",
      [
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_1"}}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5.1-codex","output":[{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
        '',
      ].join('\n')
    );

    expect(normalized.id).toBe("resp_1");
    expect(normalized.text).toBe("ok");
    expect(normalized.usage?.inputTokens).toBe(10);
    expect(normalized.usage?.outputTokens).toBe(2);
  });

  test("does not treat reasoning text as assistant output", () => {
    const normalized = normalizeResponse("openai", {
      id: "chatcmpl_1",
      model: "openrouter/free",
      choices: [
        {
          index: 0,
          finish_reason: "length",
          message: {
            role: "assistant",
            content: null,
            reasoning: "thinking aloud",
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });

    expect(normalized.text).toBe("");
    expect(normalized.finishReason).toBe("length");
  });

  test("captures response api reasoning summaries separately from text output", () => {
    const normalized = normalizeResponse("response", {
      id: "resp_2",
      model: "gpt-5.1-codex",
      status: "completed",
      output: [
        {
          id: "rs_1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thinking" }],
        },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok" }],
        },
      ],
    });

    expect(normalized.reasoningText).toBe("thinking");
    expect(renderResponse("response", normalized)).toMatchObject({
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thinking" }],
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "ok" }],
        },
      ],
    });
  });

  test("maps claude compaction blocks into response compaction items", () => {
    const normalized = normalizeResponse("claude", {
      id: "msg_cmp_1",
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      content: [
        { type: "compaction", content: "opaque-summary-token" },
        { type: "text", text: "ok" },
      ],
    });

    expect(normalized.compactionBlocks).toEqual([
      { type: "compaction", content: "opaque-summary-token" },
    ]);
    expect(renderResponse("response", normalized)).toMatchObject({
      output: [
        { type: "compaction", encrypted_content: "opaque-summary-token" },
        { type: "message", content: [{ type: "output_text", text: "ok" }] },
      ],
    });
  });

  test("maps response compaction items into claude compaction blocks", () => {
    const normalized = normalizeResponse("response", {
      id: "resp_cmp_1",
      model: "gpt-5.4",
      status: "completed",
      output: [
        { id: "cmp_1", type: "compaction_summary", encrypted_content: "opaque-summary-token" },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok" }],
        },
      ],
    });

    expect(normalized.compactionBlocks).toEqual([
      { type: "compaction", content: "opaque-summary-token", rawType: "compaction_summary" },
    ]);
    expect(renderResponse("claude", normalized)).toMatchObject({
      content: [
        { type: "compaction", content: "opaque-summary-token" },
        { type: "text", text: "ok" },
      ],
    });
  });

  test("preserves openai response metadata and richer usage details", () => {
    const normalized = normalizeResponse("openai", {
      id: "chatcmpl_2",
      object: "chat.completion",
      created: 123,
      model: "gpt-4.1",
      provider: "OpenRouter",
      system_fingerprint: "fp_123",
      service_tier: "priority",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "ok" },
        },
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 5, image_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 4, audio_tokens: 1 },
      },
    });

    expect(normalized.createdAt).toBe(123);
    expect(normalized.provider).toBe("OpenRouter");
    expect(normalized.systemFingerprint).toBe("fp_123");
    expect(normalized.serviceTier).toBe("priority");
    expect(normalized.usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 5,
      inputImageTokens: 2,
      reasoningTokens: 4,
      outputAudioTokens: 1,
    });

    expect(renderResponse("openai", normalized)).toMatchObject({
      created: 123,
      provider: "OpenRouter",
      system_fingerprint: "fp_123",
      service_tier: "priority",
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 5, image_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 4, audio_tokens: 1 },
      },
    });
  });

  test("maps gemini usage metadata into normalized usage details", () => {
    const normalized = normalizeResponse("gemini", {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "ok" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 9,
        candidatesTokenCount: 5,
        totalTokenCount: 14,
        cachedContentTokenCount: 2,
        thoughtsTokenCount: 1,
        promptTokensDetails: [{ modality: "IMAGE", tokenCount: 3 }],
        candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 4 }],
      },
    });

    expect(normalized.usage).toMatchObject({
      inputTokens: 9,
      outputTokens: 5,
      totalTokens: 14,
      cacheReadInputTokens: 2,
      reasoningTokens: 1,
      inputImageTokens: 3,
      outputAudioTokens: 4,
    });

    expect(renderResponse("gemini", normalized)).toMatchObject({
      usageMetadata: {
        promptTokenCount: 9,
        candidatesTokenCount: 5,
        totalTokenCount: 14,
        cachedContentTokenCount: 2,
        thoughtsTokenCount: 1,
        promptTokensDetails: [{ modality: "IMAGE", tokenCount: 3 }],
        candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 4 }],
      },
    });
  });

  test("maps claude usage cache fields into openai usage details", () => {
    const normalized = normalizeResponse("claude", {
      id: "msg_1",
      model: "claude-sonnet-4",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: "STOP",
      usage: {
        input_tokens: 10,
        output_tokens: 6,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 3,
      },
    });

    expect(normalized.stopSequence).toBe("STOP");
    expect(normalized.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 6,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 3,
    });

    expect(renderResponse("openai", normalized)).toMatchObject({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 6,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 },
      },
    });
  });

  test("maps claude compaction usage iterations into response usage", () => {
    const normalized = normalizeResponse("claude", {
      id: "msg_compact_1",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 23000,
        output_tokens: 1000,
        iterations: [
          { type: "compaction", input_tokens: 180000, output_tokens: 3500 },
          { type: "message", input_tokens: 23000, output_tokens: 1000 },
        ],
      },
    });

    expect(normalized.usage).toMatchObject({
      inputTokens: 23000,
      outputTokens: 1000,
      totalTokens: 24000,
      iterations: [
        { type: "compaction", inputTokens: 180000, outputTokens: 3500 },
        { type: "message", inputTokens: 23000, outputTokens: 1000 },
      ],
    });

    expect(renderResponse("response", normalized)).toMatchObject({
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
});

describe("normalizeRequest", () => {
  test("supports response api top-level input_text items", () => {
    const normalized = normalizeRequest(
      { format: "response", operation: "generate", pathname: "/v1/responses" },
      {
        model: "gpt-5.1-codex",
        input: [{ type: "input_text", text: "hello" }],
      }
    );

    expect(normalized.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ]);
  });

  test("preserves response api control fields", () => {
    const normalized = normalizeRequest(
      { format: "response", operation: "generate", pathname: "/v1/responses" },
      {
        model: "gpt-5.1-codex",
        instructions: "Be exact",
        input: [{ type: "input_text", text: "hello" }],
        metadata: { trace: "1" },
        user: "u_1",
        parallel_tool_calls: false,
        previous_response_id: "resp_prev",
        reasoning: { effort: "high" },
        service_tier: "priority",
        truncation: "disabled",
        store: true,
        tools: [
          {
            type: "function",
            function: {
              name: "Read",
              parameters: { type: "object" },
              strict: true,
            },
          },
        ],
        context_management: [{ type: "compaction", compact_threshold: 200000 }],
      }
    );

    expect(normalized.metadata).toEqual({ trace: "1" });
    expect(normalized.user).toBe("u_1");
    expect(normalized.parallelToolCalls).toBe(false);
    expect(normalized.previousResponseId).toBe("resp_prev");
    expect(normalized.reasoning).toEqual({ effort: "high" });
    expect(normalized.serviceTier).toBe("priority");
    expect(normalized.truncation).toBe("disabled");
    expect(normalized.store).toBe(true);
    expect(normalized.compaction).toEqual({ triggerTokens: 200000 });
    expect(normalized.tools).toEqual([
      {
        kind: "function",
        name: "Read",
        inputSchema: { type: "object" },
        strict: true,
      },
    ]);

    expect(renderRequest("response", normalized)).toMatchObject({
      metadata: { trace: "1" },
      user: "u_1",
      parallel_tool_calls: false,
      previous_response_id: "resp_prev",
      reasoning: { effort: "high" },
      service_tier: "priority",
      truncation: "disabled",
      store: true,
      context_management: [{ type: "compaction", compact_threshold: 200000 }],
      tools: [
        {
          type: "function",
          function: {
            name: "Read",
            parameters: { type: "object" },
            strict: true,
          },
        },
      ],
    });
  });

  test("maps claude compaction config and blocks to response requests", () => {
    const normalized = normalizeRequest(
      { format: "claude", operation: "generate", pathname: "/v1/messages" },
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: "Keep track of the coding state.",
        messages: [
          { role: "user", content: "Start the task." },
          {
            role: "assistant",
            content: [
              { type: "compaction", content: "opaque-summary-token" },
              { type: "text", text: "Continuing now." },
            ],
          },
        ],
        context_management: {
          edits: [
            {
              type: "compact_20260112",
              trigger: { type: "input_tokens", value: 180000 },
              instructions: "Preserve key code decisions.",
              pause_after_compaction: true,
            },
          ],
        },
      }
    );

    expect(normalized.compaction).toEqual({
      triggerTokens: 180000,
      instructions: "Preserve key code decisions.",
      pauseAfterCompaction: true,
    });
    expect(renderRequest("response", normalized)).toMatchObject({
      instructions: "Keep track of the coding state.",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Start the task." }] },
        { type: "compaction", encrypted_content: "opaque-summary-token" },
        { role: "assistant", content: [{ type: "output_text", text: "Continuing now." }] },
      ],
      context_management: [{ type: "compaction", compact_threshold: 180000 }],
    });
  });

  test("maps response compaction config and items to claude requests", () => {
    const normalized = normalizeRequest(
      { format: "response", operation: "generate", pathname: "/v1/responses" },
      {
        model: "gpt-5.4",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Start the task." }] },
          { id: "cmp_1", type: "compaction_summary", encrypted_content: "opaque-summary-token" },
          { role: "user", content: [{ type: "input_text", text: "Continue." }] },
        ],
        context_management: [{ type: "compaction", compact_threshold: 220000 }],
      }
    );

    expect(normalized.compaction).toEqual({ triggerTokens: 220000 });
    expect(renderRequest("claude", normalized)).toMatchObject({
      messages: [
        { role: "user", content: [{ type: "text", text: "Start the task." }] },
        { role: "assistant", content: [{ type: "compaction", content: "opaque-summary-token" }] },
        { role: "user", content: [{ type: "text", text: "Continue." }] },
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
  });

  test("preserves claude compaction config on count_tokens requests", () => {
    const normalized = normalizeRequest(
      { format: "claude", operation: "count_tokens", pathname: "/v1/messages/count_tokens" },
      {
        model: "claude-sonnet-4-6",
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
      }
    );

    expect(renderCountTokensRequest("claude", normalized)).toEqual({
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
  });

  test("preserves openai built-in web search tools across openai and claude rendering", () => {
    const normalized = normalizeRequest(
      { format: "openai", operation: "generate", pathname: "/v1/chat/completions" },
      {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "search something" }],
        tools: [{ type: "web_search_preview", search_context_size: "medium" }],
        tool_choice: { type: "web_search_preview" },
      }
    );

    expect(normalized.tools).toEqual([
      {
        kind: "builtin",
        name: "web_search",
        toolType: "web_search",
        raw: { type: "web_search_preview", search_context_size: "medium" },
      },
    ]);

    expect(renderRequest("openai", normalized)).toMatchObject({
      tools: [{ type: "web_search_preview", search_context_size: "medium" }],
      tool_choice: { type: "web_search_preview" },
    });

    expect(renderRequest("claude", normalized)).toMatchObject({
      tools: [{ type: "web_search_20250305", name: "web_search", search_context_size: "medium" }],
      tool_choice: { type: "web_search_20250305", name: "web_search" },
    });
  });

  test("maps additional built-in tools between openai and claude families", () => {
    const normalized = normalizeRequest(
      { format: "openai", operation: "generate", pathname: "/v1/chat/completions" },
      {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "run tools" }],
        tools: [
          { type: "code_interpreter" },
          { type: "image_generation" },
          { type: "file_search" },
          { type: "computer_use_preview" },
        ],
      }
    );

    expect(normalized.tools).toEqual([
      { kind: "builtin", name: "code_interpreter", toolType: "code_interpreter", raw: { type: "code_interpreter" } },
      { kind: "builtin", name: "image_generation", toolType: "image_generation", raw: { type: "image_generation" } },
      { kind: "builtin", name: "file_search", toolType: "file_search", raw: { type: "file_search" } },
      { kind: "builtin", name: "computer", toolType: "computer", raw: { type: "computer_use_preview" } },
    ]);

    expect(renderRequest("openai", normalized)).toMatchObject({
      tools: [
        { type: "code_interpreter" },
        { type: "image_generation" },
        { type: "file_search" },
        { type: "computer_use_preview" },
      ],
    });

    expect(renderRequest("claude", normalized)).toMatchObject({
      tools: [
        { type: "code_execution_20260120", name: "code_execution" },
        { type: "image_generation" },
        { type: "file_search" },
        {
          type: "computer_20250124",
          name: "computer",
          display_width_px: 1024,
          display_height_px: 768,
        },
      ],
    });
  });

  test("preserves explicit computer-use geometry when rendering to claude", () => {
    const normalized = normalizeRequest(
      { format: "openai", operation: "generate", pathname: "/v1/chat/completions" },
      {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "use computer" }],
        tools: [
          {
            type: "computer_use_preview",
            display_width_px: 1440,
            display_height_px: 900,
            display_number: 2,
            enable_zoom: true,
          },
        ],
      }
    );

    expect(renderRequest("claude", normalized)).toMatchObject({
      tools: [
        {
          type: "computer_20250124",
          name: "computer",
          display_width_px: 1440,
          display_height_px: 900,
          display_number: 2,
          enable_zoom: true,
        },
      ],
    });
  });

  test("normalizes anthropic built-in server tools into canonical families", () => {
    const normalized = normalizeRequest(
      { format: "claude", operation: "generate", pathname: "/v1/messages" },
      {
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          { type: "bash_20250124", name: "bash" },
          { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
          { type: "code_execution_20260120", name: "code_execution" },
        ],
      }
    );

    expect(normalized.tools).toEqual([
      { kind: "builtin", name: "bash", toolType: "bash", raw: { type: "bash_20250124", name: "bash" } },
      {
        kind: "builtin",
        name: "str_replace_based_edit_tool",
        toolType: "text_editor",
        raw: { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
      },
      {
        kind: "builtin",
        name: "code_execution",
        toolType: "code_execution",
        raw: { type: "code_execution_20260120", name: "code_execution" },
      },
    ]);

    expect(renderRequest("openai", normalized)).toMatchObject({
      tools: [{ type: "code_interpreter" }, { type: "code_interpreter" }, { type: "code_interpreter" }],
    });
  });

  test("captures built-in response output items such as web_search_call", () => {
    const normalized = normalizeResponse("response", {
      id: "resp_builtin",
      model: "gpt-5.4",
      status: "completed",
      output: [
        {
          id: "ws_1",
          type: "web_search_call",
          name: "web_search",
          arguments: "{\"query\":\"hello\"}",
        },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok" }],
        },
      ],
    });

    expect(normalized.toolCalls).toEqual([
      {
        type: "tool-call",
        id: "ws_1",
        name: "web_search",
        arguments: { query: "hello" },
        toolType: "web_search",
        raw: {
          id: "ws_1",
          type: "web_search_call",
          name: "web_search",
          arguments: "{\"query\":\"hello\"}",
        },
      },
    ]);

    const rendered = renderResponse("response", normalized) as Record<string, any>;
    expect(rendered.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ws_1",
          type: "web_search_call",
          name: "web_search",
          arguments: "{\"query\":\"hello\"}",
        }),
      ])
    );
  });

  test("captures built-in response output items such as computer_call", () => {
    const normalized = normalizeResponse("response", {
      id: "resp_computer",
      model: "gpt-5.4",
      status: "completed",
      output: [
        {
          id: "cmp_1",
          type: "computer_call",
          name: "computer",
          arguments: "{\"action\":\"screenshot\"}",
          display_width_px: 1280,
          display_height_px: 720,
        },
      ],
    });

    expect(normalized.toolCalls).toEqual([
      {
        type: "tool-call",
        id: "cmp_1",
        name: "computer",
        arguments: { action: "screenshot" },
        toolType: "computer",
        raw: {
          id: "cmp_1",
          type: "computer_call",
          name: "computer",
          arguments: "{\"action\":\"screenshot\"}",
          display_width_px: 1280,
          display_height_px: 720,
        },
      },
    ]);

    const rendered = renderResponse("response", normalized) as Record<string, any>;
    expect(rendered.output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cmp_1",
          type: "computer_call",
          name: "computer",
          arguments: "{\"action\":\"screenshot\"}",
          display_width_px: 1280,
          display_height_px: 720,
        }),
      ])
    );
  });

  test("converts openai image_url content into gemini fileData and preserves detail for openai round-trip", () => {
    const normalized = normalizeRequest(
      { format: "openai", operation: "generate", pathname: "/v1/chat/completions" },
      {
        model: "vision-model",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              {
                type: "image_url",
                image_url: {
                  url: "https://example.com/cat.png",
                  detail: "high",
                },
              },
            ],
          },
        ],
      }
    );

    expect(normalized.messages[0]?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", url: "https://example.com/cat.png", detail: "high" },
    ]);

    expect(renderRequest("openai", normalized)).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image_url",
              image_url: { url: "https://example.com/cat.png", detail: "high" },
            },
          ],
        },
      ],
    });

    expect(renderRequest("gemini", normalized)).toMatchObject({
      contents: [
        {
          role: "user",
          parts: [
            { text: "look" },
            { fileData: { fileUri: "https://example.com/cat.png" } },
          ],
        },
      ],
    });
  });

  test("preserves gemini functionResponse objects and fileData images across round-trip", () => {
    const normalized = normalizeRequest(
      { format: "gemini", operation: "generate", pathname: "/v1beta/models/gemini:generateContent" },
      {
        contents: [
          {
            role: "user",
            parts: [
              { fileData: { mimeType: "image/png", fileUri: "https://example.com/cat.png" } },
              { functionResponse: { name: "Read", response: { path: "a.ts", ok: true } } },
            ],
          },
        ],
      }
    );

    expect(normalized.messages[0]?.content).toEqual([
      { type: "image", mediaType: "image/png", url: "https://example.com/cat.png" },
      {
        type: "tool-result",
        toolCallId: "Read",
        name: "Read",
        content: JSON.stringify({ path: "a.ts", ok: true }),
        value: { path: "a.ts", ok: true },
      },
    ]);

    expect(renderRequest("gemini", normalized)).toMatchObject({
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { mimeType: "image/png", fileUri: "https://example.com/cat.png" } },
            { functionResponse: { id: "Read", name: "Read", response: { path: "a.ts", ok: true } } },
          ],
        },
      ],
    });

    expect(renderRequest("openai", normalized)).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "Read",
          content: JSON.stringify({ path: "a.ts", ok: true }),
        },
      ],
    });
  });

  test("converts openai file content into claude documents, response input_file, and gemini inlineData", () => {
    const normalized = normalizeRequest(
      { format: "openai", operation: "generate", pathname: "/v1/chat/completions" },
      {
        model: "file-model",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize this" },
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
      }
    );

    expect(normalized.messages[0]?.content).toEqual([
      { type: "text", text: "summarize this" },
      {
        type: "file",
        filename: "paper.pdf",
        mediaType: "application/pdf",
        data: "JVBERi0xLjQK",
      },
    ]);

    expect(renderRequest("response", normalized)).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "summarize this" },
            {
              type: "input_file",
              filename: "paper.pdf",
              file_data: "data:application/pdf;base64,JVBERi0xLjQK",
            },
          ],
        },
      ],
    });

    expect(renderRequest("gemini", normalized)).toMatchObject({
      contents: [
        {
          role: "user",
          parts: [
            { text: "summarize this" },
            { inlineData: { mimeType: "application/pdf", data: "JVBERi0xLjQK" } },
          ],
        },
      ],
    });

    expect(renderRequest("claude", normalized)).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize this" },
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
  });

  test("converts response input_file URLs into openai file content and claude documents", () => {
    const normalized = normalizeRequest(
      { format: "response", operation: "generate", pathname: "/v1/responses" },
      {
        model: "file-model",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "read this" },
              {
                type: "input_file",
                filename: "paper.pdf",
                file_url: "https://example.com/paper.pdf",
              },
            ],
          },
        ],
      }
    );

    expect(normalized.messages[0]?.content).toEqual([
      { type: "text", text: "read this" },
      {
        type: "file",
        filename: "paper.pdf",
        mediaType: "application/pdf",
        url: "https://example.com/paper.pdf",
      },
    ]);

    expect(renderRequest("openai", normalized)).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read this" },
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

    expect(renderRequest("claude", normalized)).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read this" },
            {
              type: "document",
              title: "paper.pdf",
              source: {
                type: "url",
                url: "https://example.com/paper.pdf",
              },
            },
          ],
        },
      ],
    });
  });

  test("treats gemini pdf file parts as files instead of images", () => {
    const normalized = normalizeRequest(
      { format: "gemini", operation: "generate", pathname: "/v1beta/models/gemini:generateContent" },
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: "summarize this pdf" },
              { fileData: { mimeType: "application/pdf", fileUri: "https://example.com/a.pdf" } },
            ],
          },
        ],
      }
    );

    expect(normalized.messages[0]?.content).toEqual([
      { type: "text", text: "summarize this pdf" },
      {
        type: "file",
        filename: "a.pdf",
        mediaType: "application/pdf",
        url: "https://example.com/a.pdf",
      },
    ]);

    expect(renderRequest("response", normalized)).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "summarize this pdf" },
            { type: "input_file", filename: "a.pdf", file_url: "https://example.com/a.pdf" },
          ],
        },
      ],
    });
  });

  test("synthesizes a default filename for inline pdf files when rendering to responses", () => {
    const normalized = normalizeRequest(
      { format: "gemini", operation: "generate", pathname: "/v1beta/models/gemini:generateContent" },
      {
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "application/pdf", data: "JVBERi0xLjQK" } },
              { text: "summarize" },
            ],
          },
        ],
      }
    );

    expect(renderRequest("response", normalized)).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            { type: "input_file", filename: "document.pdf", file_data: "data:application/pdf;base64,JVBERi0xLjQK" },
            { type: "input_text", text: "summarize" },
          ],
        },
      ],
    });
  });

  test("rejects provider file IDs when converting openai files to gemini", () => {
    const normalized = normalizeRequest(
      { format: "openai", operation: "generate", pathname: "/v1/chat/completions" },
      {
        model: "file-model",
        messages: [
          {
            role: "user",
            content: [{ type: "file", file: { file_id: "file_123" } }],
          },
        ],
      }
    );

    expect(() => renderRequest("gemini", normalized)).toThrow(
      "Gemini parts do not support provider file IDs"
    );
    expect(() => renderRequest("claude", normalized)).toThrow(
      "Claude document blocks do not support provider file IDs"
    );
  });
});
