import { statSync, readFileSync, readdirSync, existsSync, lstatSync } from "node:fs";
import { join, relative, normalize } from "node:path";
import { sqlError } from "./errors";
import type { AgentDB, FileEntry, IndexOptions, IndexResult, IndexStatus, TreeDiff, WorkspaceDB } from "./types";
import { getExcludePatterns } from "./file-tree";
import { getWorkspaceHandle } from "./workspace";
import { globMatch } from "./glob";
import { languageFromExt, sha256Hex, chunkFileContent } from "./chunker";

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tif", "tiff",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "wav", "webm", "mov", "avi", "mkv",
  "exe", "dll", "so", "dylib", "bin", "o", "a",
  "class", "jar", "wasm", "sqlite", "db", "parquet", "gifv",
]);

// --- Gitignore handling (supports nested .gitignore files) ---

interface GitRule {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
  basePath: string;
}

function parseGitignoreLines(content: string, basePath: string): GitRule[] {
  const rules: GitRule[] = [];
  for (let line of content.split("\n")) {
    line = line.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1).trim();
    }
    let dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    if (line) rules.push({ pattern: line, negated, dirOnly, basePath });
  }
  return rules;
}

function loadGitRules(dirPath: string, basePath: string): GitRule[] {
  const p = join(dirPath, ".gitignore");
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf8");
    return parseGitignoreLines(raw, basePath);
  } catch {
    return [];
  }
}

function gitIgnored(rel: string, isDir: boolean, rules: GitRule[]): boolean {
  let ignored = false;
  const norm = rel.replace(/\\/g, "/");
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    const target = r.basePath ? (norm.startsWith(r.basePath + "/") ? norm.slice(r.basePath.length + 1) : norm) : norm;
    if (globMatch(r.pattern, target)) {
      ignored = !r.negated;
    }
  }
  return ignored;
}

function isBinaryPath(rel: string): boolean {
  const seg = rel.split("/").pop() ?? rel;
  const dot = seg.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(seg.slice(dot + 1).toLowerCase());
}

// --- File walking ---

function listSourceFiles(
  repoPath: string,
  exclude: string[],
  include: string[] | undefined,
  gitRules: GitRule[],
): string[] {
  const out: string[] = [];
  const normRoot = normalize(repoPath);

  const walk = (dir: string, rules: GitRule[]) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const rel = relative(normRoot, dir).replace(/\\/g, "/");
    const localRules = [...rules, ...loadGitRules(dir, rel)];

    for (const e of entries) {
      const full = join(dir, e.name);
      const entryRel = relative(normRoot, full).replace(/\\/g, "/");
      try {
        if (lstatSync(full).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (e.isDirectory()) {
        if (e.name === ".git") continue;
        if (exclude.some((p) => globMatch(p, entryRel) || globMatch(p, `${entryRel}/`))) continue;
        if (gitIgnored(entryRel, true, localRules)) continue;
        walk(full, localRules);
      } else if (e.isFile()) {
        if (e.name === ".gitignore") continue;
        if (isBinaryPath(entryRel)) continue;
        if (exclude.some((p) => globMatch(p, entryRel))) continue;
        if (gitIgnored(entryRel, false, localRules)) continue;
        if (include != null && include.length > 0) {
          const ok = include.some((p) => globMatch(p, entryRel));
          if (!ok) continue;
        }
        out.push(entryRel);
      }
    }
  };

  const rootRules = loadGitRules(normRoot, "");
  walk(normRoot, [...gitRules, ...rootRules]);
  return out;
}

function loadFileTreeMap(database: import("bun:sqlite").Database): Map<string, FileEntry> {
  const rows = database.prepare(`SELECT path, hash, size, modified_at, language, indexed_at FROM file_tree`).all() as {
    path: string;
    hash: string;
    size: number | null;
    modified_at: number | null;
    language: string | null;
    indexed_at: number | null;
  }[];
  const m = new Map<string, FileEntry>();
  for (const r of rows) {
    m.set(r.path, {
      path: r.path,
      hash: r.hash,
      size: r.size,
      modifiedAt: r.modified_at,
      language: r.language,
      indexedAt: r.indexed_at,
    });
  }
  return m;
}

/** Check if file likely changed using mtime+size before expensive hash. */
function fileAppearsChanged(fullPath: string, prev: FileEntry): boolean {
  try {
    const st = statSync(fullPath);
    if (prev.size != null && st.size !== prev.size) return true;
    if (prev.modifiedAt != null && Math.trunc(st.mtimeMs) !== prev.modifiedAt) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Incrementally index text files under repoPath; uses mtime+size for fast skip.
 * When the AgentDB has a workspace attached, indexing targets the workspace DB.
 */
export function indexCodebase(db: AgentDB, repoPath: string, opts?: IndexOptions): IndexResult {
  const wsHandle = getWorkspaceHandle(db);
  return indexCodebaseInto(wsHandle, db, repoPath, opts);
}

/**
 * Index directly into a WorkspaceDB (no AgentDB needed).
 */
export function indexWorkspace(ws: WorkspaceDB, opts?: IndexOptions): IndexResult {
  return indexCodebaseInto(ws.db, undefined, ws.workspacePath, opts);
}

function indexCodebaseInto(
  targetDb: import("bun:sqlite").Database,
  agentDb: AgentDB | undefined,
  repoPath: string,
  opts?: IndexOptions,
): IndexResult {
  const t0 = Date.now();
  const chunkSize = opts?.chunkSize ?? 1000;
  const chunkOverlap = opts?.chunkOverlap ?? 150;
  const minChunk = 250;
  const force = opts?.forceReindex ?? false;

  const fromDb = agentDb ? getExcludePatterns(agentDb) : getExcludePatternsRaw(targetDb);
  const exclude = [...fromDb, ...(opts?.exclude ?? [])];

  const gitRules = loadGitRules(repoPath, "");
  let files: string[] = [];
  try {
    files = listSourceFiles(repoPath, exclude, opts?.include, gitRules);
  } catch (e) {
    throw sqlError("indexCodebase (scan)", e);
  }

  const prevMap = loadFileTreeMap(targetDb);
  const now = Date.now();
  let filesChanged = 0;
  let chunksCreated = 0;

  const deleteChunksStmt = targetDb.prepare(`DELETE FROM code_chunks WHERE path = ?`);
  const insertChunkStmt = targetDb.prepare(
    `INSERT INTO code_chunks (path, chunk_index, start_line, end_line, language, chunk_text, embedding)
     VALUES (?,?,?,?,?,?,NULL)`,
  );
  const upsertFileStmt = targetDb.prepare(
    `INSERT OR REPLACE INTO file_tree (path, hash, size, modified_at, language, indexed_at)
     VALUES (?,?,?,?,?,?)`,
  );
  const deleteFileStmt = targetDb.prepare(`DELETE FROM file_tree WHERE path = ?`);

  const tracked = new Set<string>();
  const tx = targetDb.transaction(() => {
    for (const rel of files) {
      tracked.add(rel);
      const fullPath = join(repoPath, rel);
      const prev = prevMap.get(rel);

      if (!force && prev) {
        if (!fileAppearsChanged(fullPath, prev)) continue;
      }

      let content: string;
      try {
        content = readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      const hash = sha256Hex(content);
      if (!force && prev && prev.hash === hash) {
        const st = (() => { try { return statSync(fullPath); } catch { return null; } })();
        if (st) {
          upsertFileStmt.run(rel, hash, st.size, Math.trunc(st.mtimeMs), prev.language, prev.indexedAt);
        }
        continue;
      }

      filesChanged++;
      deleteChunksStmt.run(rel);

      const lang = languageFromExt(rel);
      const parts = chunkFileContent(content, chunkSize, chunkOverlap, minChunk);
      let idx = 0;
      for (const part of parts) {
        insertChunkStmt.run(rel, idx++, part.startLine, part.endLine, lang, part.text);
        chunksCreated++;
      }

      const st = (() => { try { return statSync(fullPath); } catch { return null; } })();
      upsertFileStmt.run(rel, hash, st?.size ?? content.length, st != null ? Math.trunc(st.mtimeMs) : null, lang, now);
    }

    for (const p of prevMap.keys()) {
      if (!tracked.has(p)) {
        deleteChunksStmt.run(p);
        deleteFileStmt.run(p);
        filesChanged++;
      }
    }
  });

  try {
    tx();
  } catch (e) {
    throw sqlError("indexCodebase", e);
  }

  return {
    filesScanned: files.length,
    filesChanged,
    chunksCreated,
    embeddingsGenerated: 0,
    elapsedMs: Date.now() - t0,
  };
}

/** Read exclude patterns directly from a database handle (for workspace-only use). */
function getExcludePatternsRaw(database: import("bun:sqlite").Database): string[] {
  try {
    const rows = database.prepare(`SELECT pattern FROM exclude_patterns ORDER BY pattern`).all() as { pattern: string }[];
    return rows.map((r) => r.pattern);
  } catch {
    return [];
  }
}

export function getIndexStatus(db: AgentDB): IndexStatus {
  const wsHandle = getWorkspaceHandle(db);
  try {
    const totalFilesRow = wsHandle.prepare(`SELECT COUNT(*) AS c FROM file_tree`).get() as { c: number };
    const totalChunksRow = wsHandle.prepare(`SELECT COUNT(*) AS c FROM code_chunks`).get() as { c: number };
    const lastRow = wsHandle.prepare(`SELECT MAX(indexed_at) AS m FROM file_tree`).get() as { m: number | null };
    const pendingRow = wsHandle.prepare(`SELECT COUNT(*) AS c FROM file_tree WHERE indexed_at IS NULL`).get() as { c: number };
    const langRows = wsHandle.prepare(`SELECT language, COUNT(*) AS c FROM code_chunks GROUP BY language`).all() as {
      language: string | null;
      c: number;
    }[];
    const languageBreakdown: Record<string, number> = {};
    for (const r of langRows) {
      const k = r.language ?? "unknown";
      languageBreakdown[k] = (languageBreakdown[k] ?? 0) + Number(r.c);
    }
    return {
      totalFiles: Number(totalFilesRow.c),
      totalChunks: Number(totalChunksRow.c),
      lastIndexedAt: lastRow.m != null ? Number(lastRow.m) : null,
      pendingFiles: Number(pendingRow.c),
      languageBreakdown,
    };
  } catch (e) {
    throw sqlError("getIndexStatus", e);
  }
}

/** Diff DB file_tree vs filesystem using mtime+size fast-path before hashing. */
export function getFileTreeDiff(db: AgentDB, repoPath: string): TreeDiff {
  const wsHandle = getWorkspaceHandle(db);
  const fromDb = getExcludePatterns(db);
  const gitRules = loadGitRules(repoPath, "");
  let files: string[] = [];
  try {
    files = listSourceFiles(repoPath, fromDb, undefined, gitRules);
  } catch (e) {
    throw sqlError("getFileTreeDiff", e);
  }
  const disk = new Set(files);
  const prevMap = loadFileTreeMap(wsHandle);

  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const p of disk) {
    const prev = prevMap.get(p);
    if (!prev) {
      added.push(p);
      continue;
    }
    const fullPath = join(repoPath, p);
    if (!fileAppearsChanged(fullPath, prev)) continue;
    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    const hash = sha256Hex(content);
    if (prev.hash !== hash) changed.push(p);
  }
  for (const p of prevMap.keys()) {
    if (!disk.has(p)) removed.push(p);
  }

  added.sort();
  changed.sort();
  removed.sort();
  return { added, changed, removed };
}
