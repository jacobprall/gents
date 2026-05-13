import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParams, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { AnthropicMessage, AnthropicSystemBlock, AnthropicToolDef } from "@gents/agent-ctx";
import type { AssistantMessage, TokenUsage } from "./types";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "complete"; message: AssistantMessage; usage: TokenUsage };

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function assistantFromMessage(message: Message): AssistantMessage {
  const textParts: string[] = [];
  const toolCalls: AssistantMessage["toolCalls"] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, input: asRecord(block.input) });
    }
  }

  const joined = textParts.join("");
  return {
    content: joined.length > 0 ? joined : null,
    toolCalls,
  };
}

function usageFromMessage(message: Message): TokenUsage {
  const u = message.usage;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadInputTokens: u.cache_read_input_tokens ?? undefined,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? undefined,
  };
}

function systemForSdk(blocks: AnthropicSystemBlock[]): string | TextBlockParam[] {
  if (blocks.length === 0) return "";
  return blocks.map((b) => ({
    type: "text" as const,
    text: b.text,
    ...(b.cache_control ? { cache_control: b.cache_control } : {}),
  }));
}

/** Stream a Messages completion and emit text deltas plus a final structured assistant message. */
export async function* streamCompletion(
  client: Anthropic,
  params: {
    model: string;
    system: AnthropicSystemBlock[];
    messages: AnthropicMessage[];
    tools: AnthropicToolDef[];
    maxTokens?: number;
  },
): AsyncGenerator<StreamEvent> {
  const body: MessageCreateParams = {
    model: params.model,
    system: systemForSdk(params.system),
    messages: params.messages as MessageCreateParams["messages"],
    max_tokens: params.maxTokens ?? 8192,
    ...(params.tools.length > 0 ? { tools: params.tools as MessageCreateParams["tools"] } : {}),
  };

  const stream = client.messages.stream(body);

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield { type: "text_delta" as const, text: event.delta.text };
    }
  }

  const final = await stream.finalMessage();
  yield { type: "complete" as const, message: assistantFromMessage(final), usage: usageFromMessage(final) };
}
