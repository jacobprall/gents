import type { AgentDB, ConversationOptions, Message, NewMessage } from "./types";
import { generateUUIDv7 } from "./uuid";

function sqlError(op: string, cause: unknown): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${op} failed: ${msg}`);
}

interface MessageRow {
  id: string;
  turn: number;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  created_at: number;
}

function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    turn: r.turn,
    role: r.role as Message["role"],
    content: r.content ?? undefined,
    toolCalls: r.tool_calls ?? undefined,
    toolCallId: r.tool_call_id ?? undefined,
    tokensIn: r.tokens_in ?? undefined,
    tokensOut: r.tokens_out ?? undefined,
    costUsd: r.cost_usd ?? undefined,
    createdAt: r.created_at,
  };
}

/** Insert a message row and return it with id + timestamp. */
export function appendMessage(db: AgentDB, msg: NewMessage): Message {
  const id = generateUUIDv7();
  const createdAt = Date.now();
  try {
    db.db
      .prepare(
        `INSERT INTO messages (id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        msg.turn,
        msg.role,
        msg.content ?? null,
        msg.toolCalls ?? null,
        msg.toolCallId ?? null,
        msg.tokensIn ?? null,
        msg.tokensOut ?? null,
        msg.costUsd ?? null,
        createdAt,
      );
  } catch (e) {
    throw sqlError("appendMessage", e);
  }
  return { ...msg, id, createdAt };
}

/** Highest turn in messages, or 0 if none. */
export function getCurrentTurn(db: AgentDB): number {
  try {
    const row = db.db.prepare(`SELECT MAX(turn) AS m FROM messages`).get() as { m: number | null } | undefined;
    if (row?.m == null || Number.isNaN(row.m)) return 0;
    return row.m;
  } catch (e) {
    throw sqlError("getCurrentTurn", e);
  }
}

/** Record a compaction boundary; later reads use the summary plus messages after this turn. */
export function compactConversation(db: AgentDB, upToTurn: number, summary: string): void {
  const id = generateUUIDv7();
  const createdAt = Date.now();
  try {
    db.db
      .prepare(`INSERT INTO compaction_markers (id, up_to_turn, summary, token_count, created_at) VALUES (?,?,?,?,?)`)
      .run(id, upToTurn, summary, null, createdAt);
  } catch (e) {
    throw sqlError("compactConversation", e);
  }
}

function estimateTokens(m: Message): number {
  const t = (m.tokensIn ?? 0) + (m.tokensOut ?? 0);
  if (t > 0) return t;
  return Math.max(1, Math.ceil(((m.content?.length ?? 0) + (m.toolCalls?.length ?? 0)) / 4));
}

function truncateByTokens(messages: Message[], maxTokens: number): Message[] {
  let budget = maxTokens;
  const keptTail: Message[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const cost = estimateTokens(m);
    if (budget - cost < 0 && keptTail.length > 0) {
      break;
    }
    budget -= cost;
    keptTail.unshift(m);
  }
  return keptTail;
}

/** Messages for context: latest compaction summary (as system) plus rows after that marker, ordered by turn. */
export function getConversation(db: AgentDB, opts?: ConversationOptions): Message[] {
  try {
    const marker = db.db
      .prepare(`SELECT id, up_to_turn, summary, created_at FROM compaction_markers ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string; up_to_turn: number; summary: string; created_at: number } | undefined;

    const fromTurn = opts?.fromTurn;

    let rows: MessageRow[];
    if (marker) {
      if (fromTurn != null) {
        rows = db.db
          .prepare(
            `SELECT id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, created_at
             FROM messages WHERE turn > ? AND turn >= ? ORDER BY turn ASC, created_at ASC`,
          )
          .all(marker.up_to_turn, fromTurn) as Array<MessageRow>;
      } else {
        rows = db.db
          .prepare(
            `SELECT id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, created_at
             FROM messages WHERE turn > ? ORDER BY turn ASC, created_at ASC`,
          )
          .all(marker.up_to_turn) as Array<MessageRow>;
      }
    } else if (fromTurn != null) {
      rows = db.db
        .prepare(
          `SELECT id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, created_at
           FROM messages WHERE turn >= ? ORDER BY turn ASC, created_at ASC`,
        )
        .all(fromTurn) as Array<MessageRow>;
    } else {
      rows = db.db
        .prepare(
          `SELECT id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, created_at
           FROM messages ORDER BY turn ASC, created_at ASC`,
        )
        .all() as Array<MessageRow>;
    }

    const messages = rows.map(rowToMessage);
    let combined: Message[] = messages;

    if (marker) {
      const summaryMsg: Message = {
        id: marker.id,
        turn: marker.up_to_turn,
        role: "system",
        content: marker.summary,
        createdAt: marker.created_at,
      };
      combined = [summaryMsg, ...messages];
    }

    if (opts?.maxTokens != null && opts.maxTokens > 0 && combined.length > 0) {
      combined = truncateByTokens(combined, opts.maxTokens);
    }

    return combined;
  } catch (e) {
    throw sqlError("getConversation", e);
  }
}
