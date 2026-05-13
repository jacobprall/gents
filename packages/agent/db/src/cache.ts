import type { AgentDB } from "./types";

function sqlError(op: string, cause: unknown): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${op} failed: ${msg}`);
}

function cacheHash(toolName: string, input: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`${toolName}\0${input}`);
  return h.digest("hex");
}

export function getCachedResult(db: AgentDB, toolName: string, input: string): string | undefined {
  const h = cacheHash(toolName, input);
  try {
    const row = db.db
      .prepare(`SELECT tool_name, input, output FROM tool_cache WHERE hash = ?`)
      .get(h) as { tool_name: string; input: string; output: string } | undefined;
    if (!row) return undefined;
    if (row.tool_name !== toolName || row.input !== input) return undefined;
    return row.output;
  } catch (e) {
    throw sqlError("getCachedResult", e);
  }
}

export function setCachedResult(db: AgentDB, toolName: string, input: string, output: string): void {
  const h = cacheHash(toolName, input);
  const createdAt = Date.now();
  try {
    db.db
      .prepare(`INSERT OR REPLACE INTO tool_cache (hash, tool_name, input, output, created_at) VALUES (?,?,?,?,?)`)
      .run(h, toolName, input, output, createdAt);
  } catch (e) {
    throw sqlError("setCachedResult", e);
  }
}
