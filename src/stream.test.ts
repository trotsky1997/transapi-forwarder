import { describe, expect, test } from "bun:test";
import { transformStreamingResponse } from "./stream";

function makeStreamResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

describe("transformStreamingResponse", () => {
  test("maps claude stream events to response api events", async () => {
    const upstream = makeStreamResponse(
      [
        'event: message_start',
        'data: {"message":{"id":"msg_1","model":"claude-sonnet-4"}}',
        '',
        'event: content_block_start',
        'data: {"index":0,"content_block":{"type":"thinking","thinking":""}}',
        '',
        'event: content_block_delta',
        'data: {"index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}',
        '',
        'event: content_block_stop',
        'data: {"index":0}',
        '',
        'event: content_block_start',
        'data: {"index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"Read","input":{}}}',
        '',
        'event: content_block_delta',
        'data: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
        '',
        'event: content_block_stop',
        'data: {"index":1}',
        '',
        'event: content_block_start',
        'data: {"index":2,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"index":2,"delta":{"type":"text_delta","text":"ok"}}',
        '',
        'event: message_delta',
        'data: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("claude", "response", upstream, "codex-live");
    const text = await transformed.text();

    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.reasoning_summary_text.delta");
    expect(text).toContain("event: response.output_item.added");
    expect(text).toContain("event: response.function_call_arguments.delta");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.completed");
  });

  test("maps response api stream events to claude stream events", async () => {
    const upstream = makeStreamResponse(
      [
        'event: response.created',
        'data: {"response":{"id":"resp_1","model":"gpt-5.1-codex"}}',
        '',
        'event: response.reasoning_summary_text.delta',
        'data: {"item_id":"rs_1","delta":"think"}',
        '',
        'event: response.output_item.added',
        'data: {"item":{"id":"call_1","call_id":"call_1","type":"function_call","name":"Read","arguments":""}}',
        '',
        'event: response.function_call_arguments.delta',
        'data: {"item_id":"call_1","delta":"{\\"path\\":\\"a.ts\\"}"}',
        '',
        'event: response.output_text.delta',
        'data: {"item_id":"msg_1","delta":"ok"}',
        '',
        'event: response.completed',
        'data: {"response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5.1-codex","output":[{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"think"}]},{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok"}]},{"id":"tools_1","type":"tool_calls","tool_calls":[{"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("response", "claude", upstream, "claude-live");
    const text = await transformed.text();

    expect(text).toContain("event: message_start");
    expect(text).toContain('"type":"thinking_delta"');
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"type":"input_json_delta"');
    expect(text.match(/"type":"input_json_delta"/g)?.length).toBe(1);
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain("event: message_stop");
  });

  test("does not turn response message items into claude tool_use blocks", async () => {
    const upstream = makeStreamResponse(
      [
        'event: response.created',
        'data: {"response":{"id":"resp_msg_1","model":"gpt-5.4"}}',
        '',
        'event: response.output_item.added',
        'data: {"item":{"id":"msg_1","type":"message","role":"assistant"}}',
        '',
        'event: response.output_text.delta',
        'data: {"item_id":"msg_1","delta":"hello"}',
        '',
        'event: response.completed',
        'data: {"response":{"id":"resp_msg_1","object":"response","status":"completed","model":"gpt-5.4","output":[{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hello"}]}]}}',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("response", "claude", upstream, "claude-live");
    const text = await transformed.text();

    expect(text).toContain('"type":"text_delta"');
    expect(text).not.toContain('"type":"tool_use"');
    expect(text).not.toContain('"name":"message"');
  });

  test("maps claude compaction stream events to response compaction items", async () => {
    const upstream = makeStreamResponse(
      [
        'event: message_start',
        'data: {"message":{"id":"msg_cmp_1","model":"claude-sonnet-4-6"}}',
        '',
        'event: content_block_start',
        'data: {"index":0,"content_block":{"type":"compaction","content":""}}',
        '',
        'event: content_block_delta',
        'data: {"index":0,"delta":{"type":"compaction_delta","content":"opaque-summary-token"}}',
        '',
        'event: content_block_stop',
        'data: {"index":0}',
        '',
        'event: content_block_start',
        'data: {"index":1,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"index":1,"delta":{"type":"text_delta","text":"ok"}}',
        '',
        'event: message_delta',
        'data: {"delta":{"stop_reason":"end_turn"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("claude", "response", upstream, "codex-live");
    const text = await transformed.text();

    expect(text).toContain('"type":"response.output_item.added"');
    expect(text).toContain('"type":"compaction"');
    expect(text).toContain('"encrypted_content":"opaque-summary-token"');
    expect(text).toContain('"type":"response.output_text.delta"');
  });

  test("preserves claude compaction usage iterations in response stream completions", async () => {
    const upstream = makeStreamResponse(
      [
        'event: message_start',
        'data: {"message":{"id":"msg_cmp_usage_1","model":"claude-sonnet-4-6"}}',
        '',
        'event: content_block_start',
        'data: {"index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"index":0,"delta":{"type":"text_delta","text":"ok"}}',
        '',
        'event: message_delta',
        'data: {"delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":23000,"output_tokens":1000,"iterations":[{"type":"compaction","input_tokens":180000,"output_tokens":3500},{"type":"message","input_tokens":23000,"output_tokens":1000}]}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("claude", "response", upstream, "codex-live");
    const text = await transformed.text();

    expect(text).toContain('event: response.completed');
    expect(text).toContain('"iterations":[{"type":"compaction","input_tokens":180000,"output_tokens":3500},{"type":"message","input_tokens":23000,"output_tokens":1000}]');
  });

  test("maps response compaction stream items to claude compaction blocks", async () => {
    const upstream = makeStreamResponse(
      [
        'event: response.created',
        'data: {"response":{"id":"resp_cmp_1","model":"gpt-5.4"}}',
        '',
        'event: response.output_item.added',
        'data: {"item":{"id":"cmp_1","type":"compaction_summary","encrypted_content":"opaque-summary-token"}}',
        '',
        'event: response.output_text.delta',
        'data: {"item_id":"msg_1","delta":"ok"}',
        '',
        'event: response.completed',
        'data: {"response":{"id":"resp_cmp_1","object":"response","status":"completed","model":"gpt-5.4","output":[{"id":"cmp_1","type":"compaction_summary","encrypted_content":"opaque-summary-token"},{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok"}]}]}}',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("response", "claude", upstream, "claude-live");
    const text = await transformed.text();

    expect(text).toContain('"type":"compaction"');
    expect(text).toContain('"type":"compaction_delta"');
    expect(text).toContain('"content":"opaque-summary-token"');
    expect(text).toContain('"type":"text_delta","text":"ok"');
  });

  test("understands response api streams that encode the event name in data.type", async () => {
    const upstream = makeStreamResponse(
      [
        ': OPENROUTER PROCESSING',
        '',
        'data: {"type":"response.created","response":{"id":"resp_2","model":"gpt-5.1-codex"}}',
        '',
        'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"ok"}',
        '',
        'data: {"type":"response.completed","response":{"id":"resp_2","object":"response","status":"completed","model":"gpt-5.1-codex","output":[{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok"}]}]}}',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("response", "claude", upstream, "claude-live");
    const text = await transformed.text();

    expect(text).toContain("event: message_start");
    expect(text).toContain('"type":"text_delta","text":"ok"');
    expect(text).toContain("event: message_stop");
  });

  test("maps openai chunks to claude text stream", async () => {
    const upstream = makeStreamResponse(
      [
        'data: {"id":"chat_1","object":"chat.completion.chunk","model":"gpt-4.1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
        '',
        'data: {"id":"chat_1","object":"chat.completion.chunk","model":"gpt-4.1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("openai", "claude", upstream, "claude-live");
    const text = await transformed.text();

    expect(text).toContain("event: message_start");
    expect(text).toContain('"type":"text_delta","text":"ok"');
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain("event: message_stop");
  });

  test("maps openai reasoning and tool call deltas to claude thinking and input_json deltas", async () => {
    const upstream = makeStreamResponse(
      [
        'data: {"id":"chat_2","object":"chat.completion.chunk","model":"gpt-4.1","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"plan","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":""}}]},"finish_reason":null}]}',
        '',
        'data: {"id":"chat_2","object":"chat.completion.chunk","model":"gpt-4.1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":null}]}',
        '',
        'data: {"id":"chat_2","object":"chat.completion.chunk","model":"gpt-4.1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("openai", "claude", upstream, "claude-live");
    const text = await transformed.text();

    expect(text).toContain('"type":"thinking_delta"');
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"type":"input_json_delta"');
  });

  test("maps response content_part text events to claude text deltas", async () => {
    const upstream = makeStreamResponse(
      [
        'data: {"type":"response.created","response":{"id":"resp_3","model":"gpt-5.1-codex"}}',
        '',
        'data: {"type":"response.content_part.added","item_id":"msg_1","part":{"type":"output_text","text":"ok"}}',
        '',
        'data: {"type":"response.completed","response":{"id":"resp_3","object":"response","status":"completed","model":"gpt-5.1-codex","output":[{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok"}]}]}}',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("response", "claude", upstream, "claude-live");
    const text = await transformed.text();

    expect(text).toContain('"type":"text_delta","text":"ok"');
    expect(text).toContain("event: message_stop");
  });

  test("maps response built-in tool output items such as web_search_call to claude tool_use", async () => {
    const upstream = makeStreamResponse(
      [
        'data: {"type":"response.created","response":{"id":"resp_4","model":"gpt-5.4"}}',
        '',
        'data: {"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","name":"web_search"}}',
        '',
        'data: {"type":"response.completed","response":{"id":"resp_4","object":"response","status":"completed","model":"gpt-5.4","output":[{"id":"ws_1","type":"web_search_call","name":"web_search","arguments":"{\\"query\\":\\"hello\\"}"}]}}',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("response", "claude", upstream, "claude-live");
    const text = await transformed.text();

    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"name":"web_search"');
  });

  test("maps response built-in web_search action objects to claude tool_use deltas", async () => {
    const upstream = makeStreamResponse(
      [
        'data: {"type":"response.created","response":{"id":"resp_4b","model":"gpt-5.4"}}',
        '',
        'data: {"type":"response.output_item.added","item":{"id":"ws_2","type":"web_search_call","name":"web_search"}}',
        '',
        'data: {"type":"response.completed","response":{"id":"resp_4b","object":"response","status":"completed","model":"gpt-5.4","output":[{"id":"ws_2","type":"web_search_call","action":{"type":"search","query":"official Anthropic website","queries":["official Anthropic website"]}}]}}',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("response", "claude", upstream, "claude-live");
    const text = await transformed.text();

    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"name":"web_search"');
    expect(text).toContain('official Anthropic website');
    expect(text).toContain('"type":"input_json_delta"');
  });

  test("maps response built-in tool output items such as computer_call to claude tool_use", async () => {
    const upstream = makeStreamResponse(
      [
        'data: {"type":"response.created","response":{"id":"resp_5","model":"gpt-5.4"}}',
        '',
        'data: {"type":"response.output_item.added","item":{"id":"cmp_1","type":"computer_call","name":"computer"}}',
        '',
        'data: {"type":"response.completed","response":{"id":"resp_5","object":"response","status":"completed","model":"gpt-5.4","output":[{"id":"cmp_1","type":"computer_call","name":"computer","arguments":"{\\"action\\":\\"screenshot\\"}","display_width_px":1280,"display_height_px":720}]}}',
        '',
      ].join('\n')
    );

    const transformed = transformStreamingResponse("response", "claude", upstream, "claude-live");
    const text = await transformed.text();

    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"name":"computer"');
    expect(text).toContain('"partial_json":"{\\"action\\":\\"screenshot\\"}"');
  });
});
