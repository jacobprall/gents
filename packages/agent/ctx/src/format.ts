import type { AnthropicContentBlock, AnthropicMessage, AnthropicSystemBlock, ContentBlock } from "./types";

function coerceContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
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
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: AnthropicContentBlock[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    if (e.type === "tool_use" && typeof e.name === "string") {
      out.push({
        type: "tool_use",
        id,
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
        } catch {
          input = {};
        }
      }
      out.push({ type: "tool_use", id: id || `call_${out.length}`, name, input });
    }
  }
  return out;
}

/** Convert resolver output into system preamble blocks (no breakpoint here). */
export function normalizeToBlocks(input: string | ContentBlock[]): AnthropicSystemBlock[] {
  if (typeof input === "string") {
    return input ? [{ type: "text", text: input }] : [];
  }
  return input.map((b): AnthropicSystemBlock => ({
    type: "text",
    text: b.text,
    ...(b.cache_control ? { cache_control: b.cache_control } : {}),
  }));
}

interface DbMessageLike {
  role: unknown;
  content?: unknown;
  toolCalls?: unknown;
  toolCallId?: unknown;
}

function isDbMessage(o: unknown): o is DbMessageLike {
  return typeof o === "object" && o !== null && "role" in o;
}

function toolResultBlock(toolUseId: string, content: string): AnthropicContentBlock {
  const id = toolUseId.trim() ? toolUseId : "unknown_tool_use";
  return { type: "tool_result", tool_use_id: id, content };
}

/** Build assistant Anthropic payload: optional text plus parsed tool_use blocks. */
function formatAssistantMessage(msg: DbMessageLike): AnthropicMessage {
  const pieces: AnthropicContentBlock[] = [];
  const text = coerceContent(msg.content).trim();
  if (text) pieces.push({ type: "text", text });

  let toolCallsJson: string | undefined;
  if (typeof msg.toolCalls === "string") toolCallsJson = msg.toolCalls;
  pieces.push(...parseToolCallsJson(toolCallsJson));

  if (pieces.length === 0) return { role: "assistant", content: "" };

  if (pieces.length === 1) {
    const only = pieces[0]!;
    if (only.type === "text") return { role: "assistant", content: only.text };
  }
  return { role: "assistant", content: pieces };
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
      out.push(formatAssistantMessage(item));
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

  return out;
}
