import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParams, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { AnthropicSystemBlock } from "@gents/agent-ctx";
import { DEFAULT_MAX_TOKENS } from "./types";
import type { AssistantMessage, TokenUsage } from "./types";
import type { CompletionParams, LLMProvider, StreamEvent } from "./provider";

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);

function isRetryable(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    return RETRYABLE_STATUS_CODES.has((error as { status: number }).status);
  }
  return false;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Aborted")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Aborted")); }, { once: true });
  });
}

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

export function createAnthropicProvider(apiKey: string): LLMProvider {
  const client = new Anthropic({ apiKey });

  async function* stream(params: CompletionParams): AsyncGenerator<StreamEvent> {
    const body: MessageCreateParams = {
      model: params.model,
      system: systemForSdk(params.system),
      messages: params.messages as MessageCreateParams["messages"],
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(params.tools.length > 0 ? { tools: params.tools as MessageCreateParams["tools"] } : {}),
    };

    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (params.signal?.aborted) return;

      if (attempt > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.random() * 500;
        await sleep(backoff, params.signal);
      }

      try {
        const s = client.messages.stream(body, {
          signal: params.signal ?? undefined,
        });

        for await (const event of s) {
          if (params.signal?.aborted) {
            s.abort();
            return;
          }
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield { type: "text_delta" as const, text: event.delta.text };
          }
        }

        const final = await s.finalMessage();
        yield { type: "complete" as const, message: assistantFromMessage(final), usage: usageFromMessage(final) };
        return;
      } catch (e) {
        lastError = e;
        if (!isRetryable(e) || attempt === MAX_RETRIES) {
          throw e;
        }
      }
    }

    throw lastError;
  }

  return { name: "anthropic", stream };
}
