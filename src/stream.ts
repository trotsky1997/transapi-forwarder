import { normalizeResponse, renderResponse } from "./canonical";
import type { ApiFormat, NormalizedResponse, ToolCallBlock, UsageInfo, UsageIterationInfo } from "./types";

type SseFrame = {
  event: string | null;
  data: string;
};

type StreamEvent =
  | { type: "start"; id: string; model: string }
  | { type: "compaction_delta"; content: string; rawType?: string }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_arguments_delta"; id: string; delta: string }
  | { type: "usage"; usage: UsageInfo }
  | { type: "finish"; reason: string | null }
  | { type: "done" };

function mapFinishReasonToOpenAI(reason: string | null): string | null {
  if (!reason) return "stop";
  if (reason === "end_turn") return "stop";
  return reason;
}

function mapFinishReasonToClaude(reason: string | null): string {
  if (!reason) return "end_turn";
  if (reason === "stop") return "end_turn";
  return reason;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeUsageIterations(value: unknown): UsageIterationInfo[] | undefined {
  const iterations = asArray(value)
    .map((item) => {
      const record = asRecord(item);
      const iteration: UsageIterationInfo = {
        ...(asString(record.type) ? { type: asString(record.type) } : {}),
        ...(asNumber(record.input_tokens) !== undefined
          ? { inputTokens: asNumber(record.input_tokens) }
          : {}),
        ...(asNumber(record.output_tokens) !== undefined
          ? { outputTokens: asNumber(record.output_tokens) }
          : {}),
      };

      return Object.keys(iteration).length > 0 ? iteration : null;
    })
    .filter((item): item is UsageIterationInfo => item !== null);

  return iterations.length > 0 ? iterations : undefined;
}

function usageFromRecord(value: Record<string, unknown>): UsageInfo {
  const usage: UsageInfo = {
    ...(asNumber(value.input_tokens) ?? asNumber(value.prompt_tokens) !== undefined
      ? { inputTokens: asNumber(value.input_tokens) ?? asNumber(value.prompt_tokens) }
      : {}),
    ...(asNumber(value.output_tokens) ?? asNumber(value.completion_tokens) !== undefined
      ? { outputTokens: asNumber(value.output_tokens) ?? asNumber(value.completion_tokens) }
      : {}),
    ...(asNumber(value.total_tokens) !== undefined ? { totalTokens: asNumber(value.total_tokens) } : {}),
    ...(asNumber(value.cache_read_input_tokens) !== undefined
      ? { cacheReadInputTokens: asNumber(value.cache_read_input_tokens) }
      : {}),
    ...(asNumber(value.cache_creation_input_tokens) !== undefined
      ? { cacheCreationInputTokens: asNumber(value.cache_creation_input_tokens) }
      : {}),
  };

  const promptDetails = asRecord(value.prompt_tokens_details);
  const inputDetails = asRecord(value.input_tokens_details);
  const completionDetails = asRecord(value.completion_tokens_details);
  const outputDetails = asRecord(value.output_tokens_details);

  if (usage.cacheReadInputTokens === undefined) {
    usage.cacheReadInputTokens =
      asNumber(promptDetails.cached_tokens) ?? asNumber(inputDetails.cached_tokens);
  }
  if (usage.cacheCreationInputTokens === undefined) {
    usage.cacheCreationInputTokens =
      asNumber(promptDetails.cache_write_tokens) ?? asNumber(inputDetails.cache_write_tokens);
  }
  if (usage.reasoningTokens === undefined) {
    usage.reasoningTokens =
      asNumber(completionDetails.reasoning_tokens) ?? asNumber(outputDetails.reasoning_tokens);
  }

  usage.inputAudioTokens =
    asNumber(promptDetails.audio_tokens) ?? asNumber(inputDetails.audio_tokens) ?? usage.inputAudioTokens;
  usage.outputAudioTokens =
    asNumber(completionDetails.audio_tokens) ?? asNumber(outputDetails.audio_tokens) ?? usage.outputAudioTokens;
  usage.inputImageTokens =
    asNumber(promptDetails.image_tokens) ?? asNumber(inputDetails.image_tokens) ?? usage.inputImageTokens;
  usage.outputImageTokens =
    asNumber(completionDetails.image_tokens) ?? asNumber(outputDetails.image_tokens) ?? usage.outputImageTokens;
  usage.inputVideoTokens =
    asNumber(promptDetails.video_tokens) ?? asNumber(inputDetails.video_tokens) ?? usage.inputVideoTokens;
  usage.outputVideoTokens =
    asNumber(completionDetails.video_tokens) ?? asNumber(outputDetails.video_tokens) ?? usage.outputVideoTokens;

  const iterations = normalizeUsageIterations(value.iterations);
  if (iterations) {
    usage.iterations = iterations;
  }

  return usage;
}

function renderUsageIterations(
  iterations: UsageIterationInfo[] | undefined
): Record<string, unknown>[] | undefined {
  if (!iterations || iterations.length === 0) {
    return undefined;
  }

  return iterations.map((iteration) => ({
    ...(iteration.type ? { type: iteration.type } : {}),
    ...(iteration.inputTokens !== undefined ? { input_tokens: iteration.inputTokens } : {}),
    ...(iteration.outputTokens !== undefined ? { output_tokens: iteration.outputTokens } : {}),
  }));
}

function renderClaudeUsage(usage: UsageInfo | undefined): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }

  const iterations = renderUsageIterations(usage.iterations);

  return {
    ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
    ...(usage.cacheCreationInputTokens !== undefined
      ? { cache_creation_input_tokens: usage.cacheCreationInputTokens }
      : {}),
    ...(usage.cacheReadInputTokens !== undefined
      ? { cache_read_input_tokens: usage.cacheReadInputTokens }
      : {}),
    ...(iterations ? { iterations } : {}),
  };
}

class OpenAIStreamParser {
  private started = false;
  private toolIdsByIndex = new Map<number, string>();
  private toolNamesByIndex = new Map<number, string>();

  consume(frame: SseFrame): StreamEvent[] {
    if (frame.data === "[DONE]") {
      return [{ type: "done" }];
    }

    const parsed = parseJson(frame.data);
    const record = asRecord(parsed);
    const choice = asRecord(asArray(record.choices)[0]);
    const delta = asRecord(choice.delta);
    const events: StreamEvent[] = [];
    const id = asString(record.id) ?? `chatcmpl_${Date.now()}`;
    const model = asString(record.model) ?? "";

    if (!this.started) {
      this.started = true;
      events.push({ type: "start", id, model });
    }

    const text = asString(delta.content);
    if (text) {
      events.push({ type: "text_delta", text });
    }

    const reasoning =
      asString(delta.reasoning) ||
      asArray(delta.reasoning_details)
        .map((item) => asString(asRecord(item).text) ?? "")
        .filter(Boolean)
        .join("");
    if (reasoning) {
      events.push({ type: "reasoning_delta", text: reasoning });
    }

    for (const toolCall of asArray(delta.tool_calls)) {
      const toolRecord = asRecord(toolCall);
      const index = asNumber(toolRecord.index) ?? 0;
      const functionRecord = asRecord(toolRecord.function);
      const idValue = asString(toolRecord.id) ?? this.toolIdsByIndex.get(index) ?? `call_${index}`;
      const nameValue =
        asString(functionRecord.name) ?? this.toolNamesByIndex.get(index) ?? `tool_${index}`;

      if (!this.toolIdsByIndex.has(index)) {
        this.toolIdsByIndex.set(index, idValue);
        this.toolNamesByIndex.set(index, nameValue);
        events.push({ type: "tool_call_start", id: idValue, name: nameValue });
      }

      const argumentsDelta = asString(functionRecord.arguments);
      if (argumentsDelta) {
        events.push({ type: "tool_call_arguments_delta", id: idValue, delta: argumentsDelta });
      }
    }

    const finishReason = asString(choice.finish_reason);
    if (finishReason !== undefined) {
      events.push({ type: "finish", reason: finishReason });
    }

    const usage = usageFromRecord(asRecord(record.usage));
    if (Object.keys(usage).length > 0) {
      events.push({ type: "usage", usage });
    }

    return events;
  }
}

class ClaudeStreamParser {
  private started = false;
  private toolIdsByIndex = new Map<number, string>();

  consume(frame: SseFrame): StreamEvent[] {
    const parsed = parseJson(frame.data);
    const record = asRecord(parsed);
    const events: StreamEvent[] = [];

    if (frame.event === "message_start") {
      const message = asRecord(record.message);
      const id = asString(message.id) ?? `msg_${Date.now()}`;
      const model = asString(message.model) ?? "";
      this.started = true;
      return [{ type: "start", id, model }];
    }

    if (!this.started) {
      this.started = true;
      events.push({ type: "start", id: `msg_${Date.now()}`, model: "" });
    }

    if (frame.event === "content_block_start") {
      const contentBlock = asRecord(record.content_block);
      const index = asNumber(record.index) ?? 0;
      if (contentBlock.type === "tool_use") {
        const id = asString(contentBlock.id) ?? `tool_${index}`;
        const name = asString(contentBlock.name) ?? `tool_${index}`;
        this.toolIdsByIndex.set(index, id);
        events.push({ type: "tool_call_start", id, name });
      }
      return events;
    }

    if (frame.event === "content_block_delta") {
      const delta = asRecord(record.delta);
      if (delta.type === "compaction_delta") {
        const content = asString(delta.content);
        if (content) events.push({ type: "compaction_delta", content });
      }
      if (delta.type === "text_delta") {
        const text = asString(delta.text);
        if (text) events.push({ type: "text_delta", text });
      }
      if (delta.type === "thinking_delta") {
        const text = asString(delta.text) ?? asString(delta.thinking);
        if (text) events.push({ type: "reasoning_delta", text });
      }
      if (delta.type === "input_json_delta") {
        const index = asNumber(record.index) ?? 0;
        const id = this.toolIdsByIndex.get(index) ?? `tool_${index}`;
        const partialJson = asString(delta.partial_json) ?? asString(delta.text);
        if (partialJson) {
          events.push({ type: "tool_call_arguments_delta", id, delta: partialJson });
        }
      }
      return events;
    }

    if (frame.event === "message_delta") {
      const delta = asRecord(record.delta);
      if (Object.keys(asRecord(record.usage)).length > 0) {
        events.push({ type: "usage", usage: usageFromRecord(asRecord(record.usage)) });
      }
      if (delta.stop_reason !== undefined) {
        events.push({ type: "finish", reason: asString(delta.stop_reason) ?? null });
      }
      return events;
    }

    if (frame.event === "message_stop") {
      events.push({ type: "done" });
    }

    return events;
  }
}

class ResponseApiStreamParser {
  private started = false;
  private emittedText = "";
  private emittedReasoning = "";
  private emittedToolIds = new Set<string>();
  private emittedToolArgumentIds = new Set<string>();
  private emittedCompactionKeys = new Set<string>();
  private toolIdsByItemId = new Map<string, string>();

  consume(frame: SseFrame): StreamEvent[] {
    const parsed = parseJson(frame.data);
    const record = asRecord(parsed);
    const responseRecord = asRecord(record.response);
    const source = Object.keys(responseRecord).length > 0 ? responseRecord : record;
    const events: StreamEvent[] = [];
    const eventType = frame.event ?? asString(record.type) ?? null;

    if (eventType === "response.created") {
      this.started = true;
      events.push({
        type: "start",
        id: asString(source.id) ?? `resp_${Date.now()}`,
        model: asString(source.model) ?? "",
      });
      return events;
    }

    if (eventType === "response.reasoning_summary_text.delta") {
      const text = asString(record.delta);
      if (text) {
        this.emittedReasoning += text;
        events.push({ type: "reasoning_delta", text });
      }
      return events;
    }

    if (eventType === "response.reasoning_summary_text.done") {
      const text = asString(record.text);
      if (text && !this.emittedReasoning) {
        this.emittedReasoning = text;
        events.push({ type: "reasoning_delta", text });
      }
      return events;
    }

    if (eventType === "response.content_part.added" || eventType === "response.content_part.done") {
      const part = asRecord(record.part);
      if (part.type === "output_text") {
        const text = asString(part.text);
        if (text) {
          this.emittedText += text;
          events.push({ type: "text_delta", text });
        }
      }
      if (part.type === "reasoning_text" || part.type === "summary_text") {
        const text = asString(part.text);
        if (text) {
          this.emittedReasoning += text;
          events.push({ type: "reasoning_delta", text });
        }
      }
      return events;
    }

    if (eventType === "response.output_text.delta") {
      const text = asString(record.delta);
      if (text) {
        this.emittedText += text;
        events.push({ type: "text_delta", text });
      }
      return events;
    }

    if (eventType === "response.output_item.added") {
      const item = asRecord(record.item);
      if (typeof item.type !== "string") {
        return events;
      }
      if (item.type === "compaction" || item.type === "compaction_summary") {
        const content = asString(item.encrypted_content);
        if (content) {
          const key = `${item.type}:${content}`;
          this.emittedCompactionKeys.add(key);
          events.push({ type: "compaction_delta", content, rawType: item.type });
        }
        return events;
      }
      if (item.type !== "function_call" && !item.type.endsWith("_call")) {
        return events;
      }
      const itemId = asString(item.id);
      const id = asString(item.call_id) ?? itemId ?? `tool_${Date.now()}`;
      if (itemId) {
        this.toolIdsByItemId.set(itemId, id);
      }
      const name = asString(item.name) ?? asString(item.type) ?? "tool";
      this.emittedToolIds.add(id);
      events.push({ type: "tool_call_start", id, name });
      return events;
    }

    if (eventType === "response.function_call_arguments.delta") {
      const itemId = asString(record.item_id);
      const id = (itemId ? this.toolIdsByItemId.get(itemId) : undefined) ?? itemId ?? `tool_${Date.now()}`;
      const delta = asString(record.delta);
      if (delta) {
        this.emittedToolArgumentIds.add(id);
        events.push({ type: "tool_call_arguments_delta", id, delta });
      }
      return events;
    }

    if (eventType === "response.completed") {
      const normalized = normalizeResponse("response", source);
      if (!this.started) {
        this.started = true;
        events.push({ type: "start", id: normalized.id, model: normalized.model });
      }
      if (normalized.reasoningText && !this.emittedReasoning) {
        this.emittedReasoning = normalized.reasoningText;
        events.push({ type: "reasoning_delta", text: normalized.reasoningText });
      }
      if (normalized.text && !this.emittedText) {
        this.emittedText = normalized.text;
        events.push({ type: "text_delta", text: normalized.text });
      }
      for (const block of normalized.compactionBlocks ?? []) {
        const key = `${block.rawType ?? "compaction"}:${block.content}`;
        if (!this.emittedCompactionKeys.has(key)) {
          this.emittedCompactionKeys.add(key);
          events.push({ type: "compaction_delta", content: block.content, rawType: block.rawType });
        }
      }
      for (const toolCall of normalized.toolCalls) {
        if (!this.emittedToolIds.has(toolCall.id)) {
          this.emittedToolIds.add(toolCall.id);
          events.push({ type: "tool_call_start", id: toolCall.id, name: toolCall.name });
        }
        if (!this.emittedToolArgumentIds.has(toolCall.id) && Object.keys(toolCall.arguments).length > 0) {
          this.emittedToolArgumentIds.add(toolCall.id);
          events.push({
            type: "tool_call_arguments_delta",
            id: toolCall.id,
            delta: JSON.stringify(toolCall.arguments),
          });
        }
      }
      if (normalized.usage) {
        events.push({ type: "usage", usage: normalized.usage });
      }
      events.push({ type: "finish", reason: normalized.finishReason });
      events.push({ type: "done" });
      return events;
    }

    return events;
  }
}

function createParser(format: ApiFormat): {
  consume(frame: SseFrame): StreamEvent[];
} {
  switch (format) {
    case "claude":
      return new ClaudeStreamParser();
    case "openai":
      return new OpenAIStreamParser();
    case "response":
      return new ResponseApiStreamParser();
    default:
      throw new Error(`Streaming transform is not supported for upstream format: ${format}`);
  }
}

function createOpenAiChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage?: UsageInfo
): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage: {
      ...(usage.inputTokens !== undefined ? { prompt_tokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { completion_tokens: usage.outputTokens } : {}),
      ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
    } } : {}),
  })}\n\n`;
}

class OpenAIStreamEmitter {
  private id = `chatcmpl_${Date.now()}`;
  private model = "";
  private started = false;
  private finishReason: string | null = null;
  private usage: UsageInfo | undefined;
  private toolIndexes = new Map<string, number>();

  consume(event: StreamEvent): string[] {
    const lines: string[] = [];
    if (event.type === "start") {
      this.id = event.id;
      this.model = event.model;
      this.started = true;
      lines.push(createOpenAiChunk(this.id, this.model, { role: "assistant" }, null));
      return lines;
    }
    if (event.type === "usage") {
      this.usage = event.usage;
      return lines;
    }
    if (event.type === "finish") {
      this.finishReason = event.reason;
      return lines;
    }
    if (event.type === "text_delta") {
      lines.push(createOpenAiChunk(this.id, this.model, { content: event.text }, null));
      return lines;
    }
    if (event.type === "reasoning_delta") {
      lines.push(
        createOpenAiChunk(
          this.id,
          this.model,
          {
            reasoning: event.text,
            reasoning_details: [{ type: "reasoning.text", text: event.text }],
          },
          null
        )
      );
      return lines;
    }
    if (event.type === "tool_call_start") {
      const index = this.toolIndexes.size;
      this.toolIndexes.set(event.id, index);
      lines.push(
        createOpenAiChunk(
          this.id,
          this.model,
          {
            tool_calls: [
              {
                index,
                id: event.id,
                type: "function",
                function: { name: event.name, arguments: "" },
              },
            ],
          },
          null
        )
      );
      return lines;
    }
    if (event.type === "tool_call_arguments_delta") {
      const index = this.toolIndexes.get(event.id) ?? 0;
      lines.push(
        createOpenAiChunk(
          this.id,
          this.model,
          {
            tool_calls: [
              {
                index,
                function: { arguments: event.delta },
              },
            ],
          },
          null
        )
      );
      return lines;
    }
    if (event.type === "done") {
      lines.push(
        createOpenAiChunk(
          this.id,
          this.model,
          {},
          mapFinishReasonToOpenAI(this.finishReason),
          this.usage
        )
      );
      lines.push("data: [DONE]\n\n");
    }
    return lines;
  }
}

class ResponseStreamEmitter {
  private id = `resp_${Date.now()}`;
  private model = "";
  private usage: UsageInfo | undefined;
  private finishReason: string | null = null;
  private compactionBlocks: Array<{ content: string; rawType?: string }> = [];
  private text = "";
  private reasoningText = "";
  private toolCalls = new Map<string, { id: string; name: string; argumentsText: string }>();

  private toNormalized(): NormalizedResponse {
    const toolCalls: ToolCallBlock[] = [...this.toolCalls.values()].map((tool) => ({
      type: "tool-call",
      id: tool.id,
      name: tool.name,
      arguments: (() => {
        try {
          return tool.argumentsText ? (JSON.parse(tool.argumentsText) as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      })(),
    }));

    return {
      id: this.id,
      model: this.model,
      text: this.text,
      ...(this.compactionBlocks.length > 0
        ? {
            compactionBlocks: this.compactionBlocks.map((block) => ({
              type: "compaction",
              content: block.content,
              ...(block.rawType ? { rawType: block.rawType } : {}),
            })),
          }
        : {}),
      ...(this.reasoningText ? { reasoningText: this.reasoningText } : {}),
      toolCalls,
      finishReason: this.finishReason,
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  consume(event: StreamEvent): string[] {
    const lines: string[] = [];
    if (event.type === "start") {
      this.id = event.id;
      this.model = event.model;
      lines.push(
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: {
            id: this.id,
            object: "response",
            created: Math.floor(Date.now() / 1000),
            model: this.model,
            status: "generating",
          },
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "usage") {
      this.usage = event.usage;
      return lines;
    }
    if (event.type === "compaction_delta") {
      this.compactionBlocks.push({ content: event.content, rawType: event.rawType });
      lines.push(
        `event: response.output_item.added\ndata: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: this.compactionBlocks.length - 1,
          item: {
            id: `${this.id}_compaction_${this.compactionBlocks.length - 1}`,
            type: event.rawType ?? "compaction",
            encrypted_content: event.content,
          },
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "finish") {
      this.finishReason = event.reason;
      return lines;
    }
    if (event.type === "reasoning_delta") {
      const isFirst = this.reasoningText.length === 0;
      this.reasoningText += event.text;
      if (isFirst) {
        lines.push(
          `event: response.reasoning_summary_part.added\ndata: ${JSON.stringify({
            type: "response.reasoning_summary_part.added",
            item_id: `${this.id}_reasoning`,
            part: { type: "summary_text", text: "" },
            output_index: 0,
            summary_index: 0,
            sequence_number: 0,
          })}\n\n`
        );
      }
      lines.push(
        `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
          type: "response.reasoning_summary_text.delta",
          item_id: `${this.id}_reasoning`,
          delta: event.text,
          output_index: 0,
          summary_index: 0,
          sequence_number: this.reasoningText.length,
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "text_delta") {
      this.text += event.text;
      lines.push(
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          item_id: `${this.id}_message`,
          delta: event.text,
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "tool_call_start") {
      this.toolCalls.set(event.id, { id: event.id, name: event.name, argumentsText: "" });
      lines.push(
        `event: response.output_item.added\ndata: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: this.toolCalls.size,
          item: {
            id: event.id,
            type: "function_call",
            call_id: event.id,
            name: event.name,
            arguments: "",
          },
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "tool_call_arguments_delta") {
      const tool = this.toolCalls.get(event.id);
      if (tool) {
        tool.argumentsText += event.delta;
      }
      lines.push(
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: event.id,
          delta: event.delta,
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "done") {
      lines.push(
        `event: response.completed\ndata: ${JSON.stringify(renderResponse("response", this.toNormalized()))}\n\n`
      );
    }
    return lines;
  }
}

class ClaudeStreamEmitter {
  private id = `msg_${Date.now()}`;
  private model = "";
  private usage: UsageInfo | undefined;
  private finishReason: string | null = null;
  private currentBlock:
    | { kind: "thinking" | "text" | "tool" | "compaction"; index: number; toolId?: string }
    | null = null;
  private nextIndex = 0;

  private closeCurrentBlock(): string[] {
    if (!this.currentBlock) return [];
    const line = `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: this.currentBlock.index,
    })}\n\n`;
    this.currentBlock = null;
    return [line];
  }

  consume(event: StreamEvent): string[] {
    const lines: string[] = [];
    if (event.type === "start") {
      this.id = event.id;
      this.model = event.model;
      lines.push(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: this.id,
            type: "message",
            role: "assistant",
            model: this.model,
          },
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "usage") {
      this.usage = event.usage;
      return lines;
    }
    if (event.type === "compaction_delta") {
      if (!this.currentBlock || this.currentBlock.kind !== "compaction") {
        lines.push(...this.closeCurrentBlock());
        this.currentBlock = { kind: "compaction", index: this.nextIndex++ };
        lines.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: this.currentBlock.index,
            content_block: { type: "compaction", content: "" },
          })}\n\n`
        );
      }
      lines.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: this.currentBlock.index,
          delta: { type: "compaction_delta", content: event.content },
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "finish") {
      this.finishReason = event.reason;
      lines.push(...this.closeCurrentBlock());
      lines.push(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: mapFinishReasonToClaude(this.finishReason) },
          ...(renderClaudeUsage(this.usage) ? { usage: renderClaudeUsage(this.usage) } : {}),
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "reasoning_delta") {
      if (!this.currentBlock || this.currentBlock.kind !== "thinking") {
        lines.push(...this.closeCurrentBlock());
        this.currentBlock = { kind: "thinking", index: this.nextIndex++ };
        lines.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: this.currentBlock.index,
            content_block: { type: "thinking", thinking: "" },
          })}\n\n`
        );
      }
      lines.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: this.currentBlock.index,
          delta: { type: "thinking_delta", thinking: event.text },
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "text_delta") {
      if (!this.currentBlock || this.currentBlock.kind !== "text") {
        lines.push(...this.closeCurrentBlock());
        this.currentBlock = { kind: "text", index: this.nextIndex++ };
        lines.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: this.currentBlock.index,
            content_block: { type: "text", text: "" },
          })}\n\n`
        );
      }
      lines.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: this.currentBlock.index,
          delta: { type: "text_delta", text: event.text },
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "tool_call_start") {
      lines.push(...this.closeCurrentBlock());
      this.currentBlock = { kind: "tool", index: this.nextIndex++, toolId: event.id };
      lines.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: this.currentBlock.index,
          content_block: {
            type: "tool_use",
            id: event.id,
            name: event.name,
            input: {},
          },
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "tool_call_arguments_delta" && this.currentBlock?.kind === "tool") {
      lines.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: this.currentBlock.index,
          delta: { type: "input_json_delta", partial_json: event.delta },
        })}\n\n`
      );
      return lines;
    }
    if (event.type === "done") {
      lines.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    }
    return lines;
  }
}

function createEmitter(format: ApiFormat): {
  consume(event: StreamEvent): string[];
} {
  switch (format) {
    case "openai":
      return new OpenAIStreamEmitter();
    case "response":
      return new ResponseStreamEmitter();
    case "claude":
      return new ClaudeStreamEmitter();
    default:
      throw new Error(`Streaming transform is not supported for target format: ${format}`);
  }
}

function contentTypeForTarget(format: ApiFormat): string {
  switch (format) {
    case "openai":
    case "response":
    case "claude":
      return "text/event-stream; charset=utf-8";
    default:
      return "text/event-stream; charset=utf-8";
  }
}

export function transformStreamingResponse(
  upstreamFormat: ApiFormat,
  targetFormat: ApiFormat,
  upstreamResponse: Response,
  modelName: string
): Response {
  const parser = createParser(upstreamFormat);
  const emitter = createEmitter(targetFormat);
  const reader = upstreamResponse.body?.getReader();

  if (!reader) {
    throw new Error("Upstream streaming response has no readable body");
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let eventName: string | null = null;
  let dataLines: string[] = [];

  const flushFrame = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!eventName && dataLines.length === 0) {
      return;
    }
    const frame: SseFrame = { event: eventName, data: dataLines.join("\n") };
    eventName = null;
    dataLines = [];
    const streamEvents = parser.consume(frame);
    for (const streamEvent of streamEvents) {
      if (streamEvent.type === "start" && !streamEvent.model) {
        streamEvent.model = modelName;
      }
      const lines = emitter.consume(streamEvent);
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line === "") {
              flushFrame(controller);
              continue;
            }
            if (line.startsWith(":")) {
              continue;
            }
            if (line.startsWith("event:")) {
              eventName = line.slice("event:".length).trim();
              continue;
            }
            if (line.startsWith("data:")) {
              dataLines.push(line.slice("data:".length).trim());
            }
          }
        }

        if (buffer) {
          const lines = buffer.split(/\r?\n/);
          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventName = line.slice("event:".length).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice("data:".length).trim());
            }
          }
        }

        flushFrame(controller);
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return new Response(stream, {
    status: upstreamResponse.status,
    headers: {
      "content-type": contentTypeForTarget(targetFormat),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
