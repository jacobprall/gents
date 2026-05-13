import type { AgentDB, Event, NewEvent } from "./types";
import { generateUUIDv7 } from "./uuid";

function sqlError(op: string, cause: unknown): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${op} failed: ${msg}`);
}

function rowToEvent(row: Record<string, unknown>): Event {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: String(row.id),
    type: String(row.type),
    payload,
    turn: row.turn != null ? Number(row.turn) : undefined,
    createdAt: Number(row.created_at),
  };
}

export function appendEvent(db: AgentDB, event: NewEvent): Event {
  const id = generateUUIDv7();
  const createdAt = Date.now();
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(event.payload);
  } catch (e) {
    throw sqlError("appendEvent (serialize payload)", e);
  }
  try {
    db.db
      .prepare(`INSERT INTO events (id, type, payload, turn, created_at) VALUES (?,?,?,?,?)`)
      .run(id, event.type, payloadJson, event.turn ?? null, createdAt);
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
  opts?: { type?: string; limit?: number; offset?: number },
): Event[] {
  try {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    if (opts?.type != null) {
      return db.db
        .prepare(
          `SELECT * FROM events WHERE type = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`,
        )
        .all(opts.type, limit, offset)
        .map((r) => rowToEvent(r as Record<string, unknown>));
    }
    return db.db
      .prepare(`SELECT * FROM events ORDER BY created_at ASC LIMIT ? OFFSET ?`)
      .all(limit, offset)
      .map((r) => rowToEvent(r as Record<string, unknown>));
  } catch (e) {
    throw sqlError("getEvents", e);
  }
}

export function getLastEvent(db: AgentDB): Event | undefined {
  try {
    const row = db.db.prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT 1`).get() as
      | Record<string, unknown>
      | undefined;
    return row ? rowToEvent(row) : undefined;
  } catch (e) {
    throw sqlError("getLastEvent", e);
  }
}
