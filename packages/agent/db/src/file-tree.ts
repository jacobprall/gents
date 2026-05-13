import { sqlError } from "./errors";
import type { AgentDB, FileEntry } from "./types";
import { getWorkspaceHandle } from "./workspace";

export function getFileTree(db: AgentDB): FileEntry[] {
  const wsHandle = getWorkspaceHandle(db);
  try {
    const rows = wsHandle.prepare(`SELECT path, hash, size, modified_at, language, indexed_at FROM file_tree ORDER BY path`).all() as {
      path: string;
      hash: string;
      size: number | null;
      modified_at: number | null;
      language: string | null;
      indexed_at: number | null;
    }[];
    return rows.map((r) => ({
      path: r.path,
      hash: r.hash,
      size: r.size,
      modifiedAt: r.modified_at,
      language: r.language,
      indexedAt: r.indexed_at,
    }));
  } catch (e) {
    throw sqlError("getFileTree", e);
  }
}

/**
 * Read exclude patterns. Checks both the workspace DB (if available) and
 * the session DB, deduplicating results.
 */
export function getExcludePatterns(db: AgentDB): string[] {
  try {
    const wsHandle = getWorkspaceHandle(db);
    const rows = wsHandle.prepare(`SELECT pattern FROM exclude_patterns ORDER BY pattern`).all() as { pattern: string }[];
    const patterns = new Set(rows.map((r) => r.pattern));

    if (db.workspace) {
      try {
        const sessionRows = db.db.prepare(`SELECT pattern FROM exclude_patterns ORDER BY pattern`).all() as { pattern: string }[];
        for (const r of sessionRows) patterns.add(r.pattern);
      } catch {
        // session DB may not have exclude_patterns in split mode
      }
    }

    return [...patterns].sort();
  } catch (e) {
    throw sqlError("getExcludePatterns", e);
  }
}
