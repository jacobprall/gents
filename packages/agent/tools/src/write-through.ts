import { reindexFile, type AgentDB } from "@gents/agent-db";

/**
 * Best-effort write-through: re-index a single file in the workspace DB
 * immediately after a write/edit. If no workspace DB is attached or
 * re-indexing fails, silently no-ops — the index will catch up on the
 * next full incremental pass or commit trigger.
 */
export function tryWriteThrough(db: AgentDB, relPath: string, content: string): void {
  const ws = db.workspace;
  if (!ws) return;

  try {
    reindexFile(ws, relPath, { content });
  } catch {
    // Non-fatal: index will catch up later.
  }
}
