import { sqlError } from "./errors";
import type { AgentDB, FileEntry } from "./types";

export function getFileTree(db: AgentDB): FileEntry[] {
  try {
    const rows = db.db.prepare(`SELECT path, hash, size, modified_at, language, indexed_at FROM file_tree ORDER BY path`).all() as {
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

export function getExcludePatterns(db: AgentDB): string[] {
  try {
    const rows = db.db.prepare(`SELECT pattern FROM exclude_patterns ORDER BY pattern`).all() as { pattern: string }[];
    return rows.map((r) => r.pattern);
  } catch (e) {
    throw sqlError("getExcludePatterns", e);
  }
}
