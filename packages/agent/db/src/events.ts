import { sqlError } from "./errors";
import type { AgentDB, Event, NewEvent } from "./types";
import { generateUUIDv7 } from "./uuid";

interface EventRow {
  id: string;
  type: string;
  payload: string;
  turn: number | null;
  created_at: number;
}

function rowToEvent(row: EventRow): Event {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    type: row.type,
    payload,
    turn: row.turn ?? undefined,
    createdAt: row.created_at,
  };
}

export function appendEvent(db: AgentDB, event: NewEvent): Event {
  const id = generateUUIDv7();
  const createdAt = Date.now();
  const sid = db.activeSessionId ?? null;
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(event.payload);
  } catch (e) {
    throw sqlError("appendEvent (serialize payload)", e);
  }
  try {
    db.db
      .prepare(`INSERT INTO events (id, type, payload, turn, session_id, created_at) VALUES (?,?,?,?,?,?)`)
      .run(id, event.type, payloadJson, event.turn ?? null, sid, createdAt);
  } catch (e) {
    throw sqlError("appendEvent", e);
  }
  return {
    id,
    type: event.type,
    payload: event.payload,
    turn: event.turn,
    createdAt,
  };
}

export function getEvents(
  db: AgentDB,
  opts?: { type?: string; limit?: number; offset?: number; sessionId?: string },
): Event[] {
  const sid = opts?.sessionId ?? db.activeSessionId ?? null;
  try {
    const limit = Math.max(1, opts?.limit ?? 100);
    const offset = Math.max(0, opts?.offset ?? 0);

    if (sid && opts?.type != null) {
      return (
        db.db
          .prepare(`SELECT id, type, payload, turn, created_at FROM events WHERE session_id = ? AND type = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`)
          .all(sid, opts.type, limit, offset) as EventRow[]
      ).map(rowToEvent);
    }
    if (sid) {
      return (
        db.db
          .prepare(`SELECT id, type, payload, turn, created_at FROM events WHERE session_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`)
          .all(sid, limit, offset) as EventRow[]
      ).map(rowToEvent);
    }
    if (opts?.type != null) {
      return (
        db.db
          .prepare(`SELECT id, type, payload, turn, created_at FROM events WHERE type = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`)
          .all(opts.type, limit, offset) as EventRow[]
      ).map(rowToEvent);
    }
    return (
      db.db
        .prepare(`SELECT id, type, payload, turn, created_at FROM events ORDER BY created_at ASC LIMIT ? OFFSET ?`)
        .all(limit, offset) as EventRow[]
    ).map(rowToEvent);
  } catch (e) {
    throw sqlError("getEvents", e);
  }
}

export function getLastEvent(db: AgentDB): Event | undefined {
  const sid = db.activeSessionId ?? null;
  try {
    let row: EventRow | undefined;
    if (sid) {
      row = db.db
        .prepare(`SELECT id, type, payload, turn, created_at FROM events WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`)
        .get(sid) as EventRow | undefined;
    } else {
      row = db.db
        .prepare(`SELECT id, type, payload, turn, created_at FROM events ORDER BY created_at DESC LIMIT 1`)
        .get() as EventRow | undefined;
    }
    return row ? rowToEvent(row) : undefined;
  } catch (e) {
    throw sqlError("getLastEvent", e);
  }
}
