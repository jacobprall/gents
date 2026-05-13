import type { AnthropicContentBlock, AnthropicMessage, ContentBlock } from "./types";

const LOG_PREFIX = "[@gents/agent-ctx]";

function debugWarn(msg: string, cause?: unknown): void {
  if (process.env["DEBUG"] || process.env["GENTS_DEBUG"]) {
    console.debug(LOG_PREFIX, msg, cause ?? "");
  }
}

function coerceContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? String(v) : v);
  } catch (e) {
    debugWarn("coerceContent: JSON.stringify failed on non-primitive value", e);
    return "";
  }
}

function parseMaybeJsonRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw) as unknown;
      return typeof p === "object" && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

/** Extract Anthropic-compatible tool_use blocks from a stored tool_calls JSON string. */
function parseToolCallsJson(toolCalls: string | undefined): AnthropicContentBlock[] {
  if (!toolCalls?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCalls) as unknown;
  } catch (e) {
    debugWarn("parseToolCallsJson: invalid JSON in stored tool_calls", e);
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: AnthropicContentBlock[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const rawId = typeof e.id === "string" && e.id ? e.id : "";

    if (e.type === "tool_use" && typeof e.name === "string") {
      out.push({
        type: "tool_use",
        id: rawId || `call_${out.length}`,
        name: e.name,
        input: parseMaybeJsonRecord(e.input),
      });
      continue;
    }

    const fn = e.function;
    if (fn && typeof fn === "object" && !Array.isArray(fn)) {
      const f = fn as Record<string, unknown>;
      const name = typeof f.name === "string" ? f.name : "";
      if (!name) continue;
      let input: Record<string, unknown> = {};
      if (typeof f.arguments === "string") {
        try {
          const args = JSON.parse(f.arguments) as unknown;
          if (typeof args === "object" && args !== null && !Array.isArray(args)) input = args as Record<string, unknown>;
        } catch (e) {
          debugWarn(`parseToolCallsJson: invalid JSON in function arguments for "${name}"`, e);
          input = {};
        }
      }
      out.push({ type: "tool_use", id: rawId || `call_${out.length}`, name, input });
    }
  }
  return out;
}

/** Convert resolver output into system preamble blocks. */
export function normalizeToBlocks(input: string | ContentBlock[]): ContentBlock[] {
  if (typeof input === "string") {
    return input ? [{ type: "text", text: input }] : [];
  }
  return input.map(
    (b): ContentBlock => ({
      type: "text",
      text: b.text,
      ...(b.cache_control ? { cache_control: b.cache_control } : {}),
    }),
  );
}

interface DbMessageLike {
  role: unknown;
  content?: unknown;
  toolCalls?: unknown;
  toolCallId?: unknown;
}

function isDbMessage(o: unknown): o is DbMessageLike {
  if (typeof o !== "object" || o === null) return false;
  const role = (o as Record<string, unknown>).role;
  return typeof role === "string";
}

function toolResultBlock(toolUseId: string, content: string): AnthropicContentBlock {
  const id = toolUseId.trim() ? toolUseId : "unknown_tool_use";
  return { type: "tool_result", tool_use_id: id, content };
}

/** Build assistant Anthropic payload; returns null for empty messages. */
function formatAssistantMessage(msg: DbMessageLike): AnthropicMessage | null {
  const pieces: AnthropicContentBlock[] = [];
  const text = coerceContent(msg.content).trim();
  if (text) pieces.push({ type: "text", text });

  let toolCallsJson: string | undefined;
  if (typeof msg.toolCalls === "string") toolCallsJson = msg.toolCalls;
  pieces.push(...parseToolCallsJson(toolCallsJson));

  if (pieces.length === 0) return null;

  if (pieces.length === 1) {
    const only = pieces[0]!;
    if (only.type === "text") return { role: "assistant", content: only.text };
  }
  return { role: "assistant", content: pieces };
}

function contentToBlocks(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return content;
}

/** Merge consecutive same-role messages to satisfy the Anthropic alternation requirement. */
function coalesceMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length <= 1) return messages;
  const out: AnthropicMessage[] = [messages[0]!];

  for (let i = 1; i < messages.length; i++) {
    const prev = out[out.length - 1]!;
    const curr = messages[i]!;

    if (prev.role !== curr.role) {
      out.push(curr);
      continue;
    }

    const prevBlocks = contentToBlocks(prev.content);
    const currBlocks = contentToBlocks(curr.content);
    prev.content = [...prevBlocks, ...currBlocks];
  }

  return out;
}

/** Map stored conversation rows to Anthropic `messages`. */
export function formatConversation(raw: unknown): AnthropicMessage[] {
  if (!Array.isArray(raw)) return [];

  const out: AnthropicMessage[] = [];
  let i = 0;
  while (i < raw.length) {
    const item = raw[i];
    i += 1;
    if (!isDbMessage(item)) continue;

    const role = item.role;
    if (role === "user") {
      out.push({ role: "user", content: coerceContent(item.content) });
      continue;
    }
    if (role === "assistant") {
      const formatted = formatAssistantMessage(item);
      if (formatted) out.push(formatted);
      continue;
    }
    if (role === "tool") {
      const results: AnthropicContentBlock[] = [];
      results.push(toolResultBlock(coerceContent(item.toolCallId), coerceContent(item.content)));
      while (i < raw.length) {
        const next = raw[i];
        if (!isDbMessage(next) || next.role !== "tool") break;
        i += 1;
        results.push(toolResultBlock(coerceContent(next.toolCallId), coerceContent(next.content)));
      }
      if (results.length > 0) out.push({ role: "user", content: results });
      continue;
    }
    if (role === "system") {
      const body = coerceContent(item.content).trim();
      const prefix = "[Context compaction summary]\n\n";
      out.push({ role: "user", content: body ? `${prefix}${body}` : prefix.trimEnd() });
    }
  }

  return coalesceMessages(out);
}
