import { GoogleGenAI } from "@google/genai";
import type { Content, FunctionDeclaration, Part, Tool } from "@google/genai";
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
  if (error instanceof Error && /RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL/.test(error.message)) {
    return true;
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

function toGeminiContents(messages: CompletionParams["messages"]): Content[] {
  const result: Content[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const parts: Part[] = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push({ text: block.text });
          } else if (block.type === "tool_result") {
            parts.push({
              functionResponse: {
                id: block.tool_use_id,
                name: block.tool_use_id,
                response: safeJsonParse(block.content),
              },
            });
          }
        }
        if (parts.length > 0) {
          result.push({ role: "user", parts });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        result.push({ role: "model", parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const parts: Part[] = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push({ text: block.text });
          } else if (block.type === "tool_use") {
            parts.push({
              functionCall: {
                id: block.id,
                name: block.name,
                args: block.input as Record<string, unknown>,
              },
            });
          }
        }
        if (parts.length > 0) {
          result.push({ role: "model", parts });
        }
      }
    }
  }

  return result;
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    return { result: s };
  } catch {
    return { result: s };
  }
}

function toGeminiTools(tools: CompletionParams["tools"]): Tool[] | undefined {
  if (tools.length === 0) return undefined;
  const declarations: FunctionDeclaration[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.input_schema,
  }));
  return [{ functionDeclarations: declarations }];
}

/**
 * Gemini uses the tool name as the correlation key for function responses,
 * but our conversation format uses tool_use_id. We need to track the
 * id->name mapping so tool results can be matched back.
 */
function patchToolResultNames(
  messages: CompletionParams["messages"],
  contents: Content[],
): Content[] {
  const idToName = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        idToName.set(block.id, block.name);
      }
    }
  }

  return contents.map((c) => {
    if (c.role !== "user") return c;
    const patched = c.parts?.map((p) => {
      if (p.functionResponse && p.functionResponse.id) {
        const name = idToName.get(p.functionResponse.id);
        if (name) {
          return { ...p, functionResponse: { ...p.functionResponse, name } };
        }
      }
      return p;
    });
    return { ...c, parts: patched };
  });
}

export function createGoogleProvider(apiKey: string): LLMProvider {
  const ai = new GoogleGenAI({ apiKey });

  async function* stream(params: CompletionParams): AsyncGenerator<StreamEvent> {
    const systemText = systemBlocksToText(params.system);
    let contents = toGeminiContents(params.messages);
    contents = patchToolResultNames(params.messages, contents);
    const tools = toGeminiTools(params.tools);

    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (params.signal?.aborted) return;

      if (attempt > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.random() * 500;
        await sleep(backoff, params.signal);
      }

      try {
        const response = await ai.models.generateContentStream({
          model: params.model,
          contents,
          config: {
            maxOutputTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(systemText ? { systemInstruction: systemText } : {}),
            ...(tools ? { tools } : {}),
            abortSignal: params.signal,
          },
        });

        let contentText = "";
        const toolCalls: AssistantMessage["toolCalls"] = [];
        let usage: TokenUsage | null = null;

        for await (const chunk of response) {
          if (params.signal?.aborted) return;

          if (chunk.usageMetadata) {
            usage = {
              inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
              outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            };
          }

          if (chunk.candidates?.[0]?.content?.parts) {
            for (const part of chunk.candidates[0].content.parts) {
              if (part.text) {
                contentText += part.text;
                yield { type: "text_delta" as const, text: part.text };
              }
              if (part.functionCall) {
                toolCalls.push({
                  id: part.functionCall.id ?? `call_${toolCalls.length}`,
                  name: part.functionCall.name ?? "",
                  input: (part.functionCall.args as Record<string, unknown>) ?? {},
                });
              }
            }
          }
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

  return { name: "google", stream };
}
