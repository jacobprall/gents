import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionChunk,
} from "openai/resources/chat/completions/completions";
import type { ContentBlock } from "@gents/agent-ctx";
import { DEFAULT_MAX_TOKENS } from "./types";
import type { AssistantMessage, TokenUsage } from "./types";
import type { CompletionParams, LLMProvider, StreamEvent } from "./provider";

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

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

function systemBlocksToText(blocks: ContentBlock[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

function toOpenAIMessages(
  system: ContentBlock[],
  messages: CompletionParams["messages"],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];

  const sysText = systemBlocksToText(system);
  if (sysText) {
    result.push({ role: "developer", content: sysText });
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const parts: Array<{ type: "text"; text: string }> = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push({ type: "text", text: block.text });
          } else if (block.type === "tool_result") {
            result.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        }
        if (parts.length > 0) {
          result.push({ role: "user", content: parts });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const toolCalls: Array<{
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }> = [];

        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        const assistantMsg: ChatCompletionMessageParam = {
          role: "assistant",
          ...(textParts.length > 0 ? { content: textParts.join("") } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        };
        result.push(assistantMsg);
      }
    }
  }

  return result;
}

function toOpenAITools(tools: CompletionParams["tools"]): ChatCompletionTool[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

interface PartialToolCall {
  id: string;
  name: string;
  argsChunks: string[];
}

export function createOpenAIProvider(apiKey: string): LLMProvider {
  const client = new OpenAI({ apiKey });

  async function* stream(params: CompletionParams): AsyncGenerator<StreamEvent> {
    const openAIMessages = toOpenAIMessages(params.system, params.messages);
    const tools = toOpenAITools(params.tools);

    const body: ChatCompletionCreateParamsStreaming = {
      model: params.model,
      messages: openAIMessages,
      max_completion_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools ? { tools } : {}),
    };

    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (params.signal?.aborted) return;

      if (attempt > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.random() * 500;
        await sleep(backoff, params.signal);
      }

      try {
        const s = await client.chat.completions.create(body, {
          signal: params.signal ?? undefined,
        });

        let contentText = "";
        const toolCallMap = new Map<number, PartialToolCall>();
        let usage: TokenUsage | null = null;

        for await (const chunk of s as AsyncIterable<ChatCompletionChunk>) {
          if (params.signal?.aborted) return;

          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            contentText += delta.content;
            yield { type: "text_delta" as const, text: delta.content };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              let partial = toolCallMap.get(tc.index);
              if (!partial && tc.id) {
                partial = { id: tc.id, name: tc.function?.name ?? "", argsChunks: [] };
                toolCallMap.set(tc.index, partial);
              }
              if (partial) {
                if (tc.function?.name) partial.name = tc.function.name;
                if (tc.function?.arguments) partial.argsChunks.push(tc.function.arguments);
              }
            }
          }
        }

        const toolCalls: AssistantMessage["toolCalls"] = [];
        for (const [, tc] of [...toolCallMap.entries()].sort((a, b) => a[0] - b[0])) {
          const argsStr = tc.argsChunks.join("");
          let parsed: Record<string, unknown> = {};
          try {
            parsed = asRecord(JSON.parse(argsStr));
          } catch { /* keep empty */ }
          toolCalls.push({ id: tc.id, name: tc.name, input: parsed });
        }

        const message: AssistantMessage = {
          content: contentText.length > 0 ? contentText : null,
          toolCalls,
        };

        yield {
          type: "complete" as const,
          message,
          usage: usage ?? { inputTokens: 0, outputTokens: 0 },
        };
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

  return { name: "openai", stream };
}
