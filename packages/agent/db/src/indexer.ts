import { statSync, readFileSync, readdirSync, existsSync, lstatSync } from "node:fs";
import { join, relative, normalize } from "node:path";
import { sqlError } from "./errors";
import type { AgentDB, FileEntry, IndexOptions, IndexResult, IndexStatus, TreeDiff } from "./types";
import { getExcludePatterns } from "./file-tree";

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tif", "tiff",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "wav", "webm", "mov", "avi", "mkv",
  "exe", "dll", "so", "dylib", "bin", "o", "a",
  "class", "jar", "wasm", "sqlite", "db", "parquet", "gifv",
]);

import { globMatch } from "./glob";

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

// --- Language detection ---

const LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
  rs: "rust", go: "go", java: "java",
  kt: "kotlin", kts: "kotlin",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  rb: "ruby",
  md: "markdown", mdx: "markdown",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
  html: "html", css: "css", scss: "scss", sql: "sql",
  sh: "shell", bash: "shell", zsh: "shell",
  swift: "swift", scala: "scala", dart: "dart", lua: "lua",
  ex: "elixir", exs: "elixir",
  hs: "haskell", cs: "csharp", fs: "fsharp", vb: "vb", php: "php",
};

function languageFromExt(filePath: string): string | null {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return LANGUAGE_MAP[ext] ?? null;
}

function isBinaryPath(rel: string): boolean {
  const seg = rel.split("/").pop() ?? rel;
  const dot = seg.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(seg.slice(dot + 1).toLowerCase());
}

function sha256Hex(data: string | Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  if (typeof data === "string") h.update(data);
  else h.update(data);
  return h.digest("hex");
}

// --- Chunking with accurate line tracking ---

interface ChunkPart {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Split on double-newline boundaries then subdivide long blocks with overlap.
 * Tracks actual newlines consumed (including multiple blank lines) to keep line numbers accurate.
 */
function chunkFileContent(content: string, chunkSize: number, overlap: number, minChunk: number): ChunkPart[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];

  const lines = normalized.split("\n");
  const totalLines = lines.length;
  const result: ChunkPart[] = [];

  let i = 0;
  while (i < totalLines) {
    while (i < totalLines && lines[i]!.trim() === "") i++;
    if (i >= totalLines) break;

    const blockStart = i;
    while (i < totalLines && !(i > blockStart && lines[i]!.trim() === "" && (i + 1 >= totalLines || lines[i + 1]!.trim() === ""))) {
      i++;
    }
    const blockEnd = i;

    const blockLines = lines.slice(blockStart, blockEnd);
    const blockText = blockLines.join("\n");

    if (blockText.length <= chunkSize) {
      const t = blockText.trim();
      if (t && (t.length >= minChunk || result.length === 0)) {
        result.push({ text: t, startLine: blockStart + 1, endLine: blockEnd });
      } else if (t && result.length > 0) {
        const prev = result[result.length - 1]!;
        prev.text = `${prev.text}\n\n${t}`;
        prev.endLine = blockEnd;
      }
    } else {
      let li = 0;
      while (li < blockLines.length) {
        let accLen = 0;
        let lj = li;
        while (lj < blockLines.length && accLen < chunkSize) {
          accLen += blockLines[lj]!.length + (lj > li ? 1 : 0);
          lj++;
        }
        if (lj === li) lj = li + 1;
        const slice = blockLines.slice(li, lj).join("\n").trim();
        if (slice) {
          if (slice.length >= minChunk || result.length === 0) {
            result.push({ text: slice, startLine: blockStart + li + 1, endLine: blockStart + lj });
          } else {
            const prev = result[result.length - 1]!;
            prev.text = `${prev.text}\n\n${slice}`;
            prev.endLine = blockStart + lj;
          }
        }
        if (lj >= blockLines.length) break;
        const overlapLines = Math.max(1, Math.ceil(overlap / 80));
        li = Math.max(li + 1, lj - overlapLines);
      }
    }

    while (i < totalLines && lines[i]!.trim() === "") i++;
  }

  return result;
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

function loadFileTreeMap(db: AgentDB): Map<string, FileEntry> {
  const rows = db.db.prepare(`SELECT path, hash, size, modified_at, language, indexed_at FROM file_tree`).all() as {
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

/** Incrementally index text files under repoPath; uses mtime+size for fast skip. */
export function indexCodebase(db: AgentDB, repoPath: string, opts?: IndexOptions): IndexResult {
  const t0 = Date.now();
  const chunkSize = opts?.chunkSize ?? 1000;
  const chunkOverlap = opts?.chunkOverlap ?? 150;
  const minChunk = 250;
  const force = opts?.forceReindex ?? false;

  const fromDb = getExcludePatterns(db);
  const exclude = [...fromDb, ...(opts?.exclude ?? [])];

  const gitRules = loadGitRules(repoPath, "");
  let files: string[] = [];
  try {
    files = listSourceFiles(repoPath, exclude, opts?.include, gitRules);
  } catch (e) {
    throw sqlError("indexCodebase (scan)", e);
  }

  const prevMap = loadFileTreeMap(db);
  const now = Date.now();
  let filesChanged = 0;
  let chunksCreated = 0;

  const deleteChunksStmt = db.db.prepare(`DELETE FROM code_chunks WHERE path = ?`);
  const insertChunkStmt = db.db.prepare(
    `INSERT INTO code_chunks (path, chunk_index, start_line, end_line, language, chunk_text, embedding)
     VALUES (?,?,?,?,?,?,NULL)`,
  );
  const upsertFileStmt = db.db.prepare(
    `INSERT OR REPLACE INTO file_tree (path, hash, size, modified_at, language, indexed_at)
     VALUES (?,?,?,?,?,?)`,
  );
  const deleteFileStmt = db.db.prepare(`DELETE FROM file_tree WHERE path = ?`);

  const tracked = new Set<string>();
  const tx = db.db.transaction(() => {
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

export function getIndexStatus(db: AgentDB): IndexStatus {
  try {
    const totalFilesRow = db.db.prepare(`SELECT COUNT(*) AS c FROM file_tree`).get() as { c: number };
    const totalChunksRow = db.db.prepare(`SELECT COUNT(*) AS c FROM code_chunks`).get() as { c: number };
    const lastRow = db.db.prepare(`SELECT MAX(indexed_at) AS m FROM file_tree`).get() as { m: number | null };
    const pendingRow = db.db.prepare(`SELECT COUNT(*) AS c FROM file_tree WHERE indexed_at IS NULL`).get() as { c: number };
    const langRows = db.db.prepare(`SELECT language, COUNT(*) AS c FROM code_chunks GROUP BY language`).all() as {
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
  const fromDb = getExcludePatterns(db);
  const gitRules = loadGitRules(repoPath, "");
  let files: string[] = [];
  try {
    files = listSourceFiles(repoPath, fromDb, undefined, gitRules);
  } catch (e) {
    throw sqlError("getFileTreeDiff", e);
  }
  const disk = new Set(files);
  const prevMap = loadFileTreeMap(db);

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
