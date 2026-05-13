import { sqlError } from "./errors";
import type { AgentDB } from "./types";

export function getConfig(db: AgentDB, key: string): string | undefined {
  try {
    const row = db.db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value;
  } catch (e) {
    throw sqlError("getConfig", e);
  }
}

export function setConfig(db: AgentDB, key: string, value: string): void {
  try {
    db.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?,?)`).run(key, value);
  } catch (e) {
    throw sqlError("setConfig", e);
  }
}
