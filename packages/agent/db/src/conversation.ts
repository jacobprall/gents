import { sqlError } from "./errors";
import type { AgentDB, ConversationOptions, Message, NewMessage } from "./types";
import { generateUUIDv7 } from "./uuid";

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
  session_id: string | null;
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

function resolveSessionId(db: AgentDB, explicit?: string): string | null {
  return explicit ?? db.activeSessionId ?? null;
}

export function appendMessage(db: AgentDB, msg: NewMessage): Message {
  const id = generateUUIDv7();
  const createdAt = Date.now();
  const sid = resolveSessionId(db);
  try {
    db.db
      .prepare(
        `INSERT INTO messages (id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, session_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
        sid,
        createdAt,
      );
  } catch (e) {
    throw sqlError("appendMessage", e);
  }
  if (sid) {
    try {
      db.db.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`).run(createdAt, sid);
    } catch { /* best effort */ }
  }
  return { ...msg, id, createdAt };
}

export function getCurrentTurn(db: AgentDB, sessionId?: string): number {
  const sid = resolveSessionId(db, sessionId);
  try {
    if (sid) {
      const row = db.db.prepare(`SELECT MAX(turn) AS m FROM messages WHERE session_id = ?`).get(sid) as { m: number | null } | undefined;
      if (row?.m == null || Number.isNaN(row.m)) return 0;
      return row.m;
    }
    const row = db.db.prepare(`SELECT MAX(turn) AS m FROM messages`).get() as { m: number | null } | undefined;
    if (row?.m == null || Number.isNaN(row.m)) return 0;
    return row.m;
  } catch (e) {
    throw sqlError("getCurrentTurn", e);
  }
}

export function compactConversation(db: AgentDB, upToTurn: number, summary: string, sessionId?: string): void {
  const id = generateUUIDv7();
  const createdAt = Date.now();
  const sid = resolveSessionId(db, sessionId);
  try {
    db.db
      .prepare(`INSERT INTO compaction_markers (id, up_to_turn, summary, token_count, session_id, created_at) VALUES (?,?,?,?,?,?)`)
      .run(id, upToTurn, summary, null, sid, createdAt);
  } catch (e) {
    throw sqlError("compactConversation", e);
  }
}

function estimateTokens(m: Message): number {
  const t = (m.tokensIn ?? 0) + (m.tokensOut ?? 0);
  if (t > 0) return t;
  const charLen =
    (m.content?.length ?? 0) +
    (m.toolCalls?.length ?? 0) +
    (m.toolCallId?.length ?? 0);
  return Math.max(1, Math.ceil(charLen / 4));
}

type MarkerRow = { id: string; up_to_turn: number; summary: string; created_at: number };

function getLatestMarker(db: AgentDB, sid: string | null): MarkerRow | undefined {
  if (sid) {
    return db.db
      .prepare(`SELECT id, up_to_turn, summary, created_at FROM compaction_markers WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(sid) as MarkerRow | undefined;
  }
  return db.db
    .prepare(`SELECT id, up_to_turn, summary, created_at FROM compaction_markers ORDER BY created_at DESC LIMIT 1`)
    .get() as MarkerRow | undefined;
}

/**
 * Retrieve messages for context window. Uses a reverse-scan approach when maxTokens
 * is specified to avoid loading the entire conversation history into memory.
 */
export function getConversation(db: AgentDB, opts?: ConversationOptions): Message[] {
  const sid = resolveSessionId(db, opts?.sessionId);
  try {
    const marker = getLatestMarker(db, sid);

    const fromTurn = opts?.fromTurn;
    const maxTokens = opts?.maxTokens;
    const markerTurn = marker?.up_to_turn;

    const effectiveFrom = Math.max(markerTurn != null ? markerTurn + 1 : 0, fromTurn ?? 0);

    if (maxTokens != null && maxTokens > 0) {
      return getConversationWithBudget(db, sid, marker, effectiveFrom, maxTokens);
    }

    let rows: MessageRow[];
    if (sid) {
      if (effectiveFrom > 0) {
        rows = db.db
          .prepare(
            `SELECT id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, session_id, created_at
             FROM messages WHERE session_id = ? AND turn >= ? ORDER BY turn ASC, created_at ASC`,
          )
          .all(sid, effectiveFrom) as MessageRow[];
      } else {
        rows = db.db
          .prepare(
            `SELECT id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, session_id, created_at
             FROM messages WHERE session_id = ? ORDER BY turn ASC, created_at ASC`,
          )
          .all(sid) as MessageRow[];
      }
    } else {
      if (effectiveFrom > 0) {
        rows = db.db
          .prepare(
            `SELECT id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, session_id, created_at
             FROM messages WHERE turn >= ? ORDER BY turn ASC, created_at ASC`,
          )
          .all(effectiveFrom) as MessageRow[];
      } else {
        rows = db.db
          .prepare(
            `SELECT id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, session_id, created_at
             FROM messages ORDER BY turn ASC, created_at ASC`,
          )
          .all() as MessageRow[];
      }
    }

    const messages = rows.map(rowToMessage);

    if (marker) {
      const summaryMsg: Message = {
        id: marker.id,
        turn: marker.up_to_turn,
        role: "system",
        content: marker.summary,
        createdAt: marker.created_at,
      };
      return [summaryMsg, ...messages];
    }

    return messages;
  } catch (e) {
    throw sqlError("getConversation", e);
  }
}

function getConversationWithBudget(
  db: AgentDB,
  sid: string | null,
  marker: MarkerRow | undefined,
  effectiveFrom: number,
  maxTokens: number,
): Message[] {
  let rows: MessageRow[];
  if (sid) {
    if (effectiveFrom > 0) {
      rows = db.db
        .prepare(
          `SELECT id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, session_id, created_at
           FROM messages WHERE session_id = ? AND turn >= ? ORDER BY turn DESC, created_at DESC`,
        )
        .all(sid, effectiveFrom) as MessageRow[];
    } else {
      rows = db.db
        .prepare(
          `SELECT id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, session_id, created_at
           FROM messages WHERE session_id = ? ORDER BY turn DESC, created_at DESC`,
        )
        .all(sid) as MessageRow[];
    }
  } else {
    if (effectiveFrom > 0) {
      rows = db.db
        .prepare(
          `SELECT id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, session_id, created_at
           FROM messages WHERE turn >= ? ORDER BY turn DESC, created_at DESC`,
        )
        .all(effectiveFrom) as MessageRow[];
    } else {
      rows = db.db
        .prepare(
          `SELECT id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, session_id, created_at
           FROM messages ORDER BY turn DESC, created_at DESC`,
        )
        .all() as MessageRow[];
    }
  }

  let budget = maxTokens;
  const kept: Message[] = [];

  if (marker) {
    const summaryMsg: Message = {
      id: marker.id,
      turn: marker.up_to_turn,
      role: "system",
      content: marker.summary,
      createdAt: marker.created_at,
    };
    budget -= estimateTokens(summaryMsg);
    kept.push(summaryMsg);
  }

  for (const row of rows) {
    const msg = rowToMessage(row);
    const cost = estimateTokens(msg);
    if (budget - cost < 0 && kept.length > (marker ? 1 : 0)) break;
    budget -= cost;
    kept.push(msg);
  }

  if (marker) {
    const [summary, ...rest] = kept;
    rest.reverse();
    return [summary!, ...rest];
  }

  kept.reverse();
  return kept;
}
