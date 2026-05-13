import { statSync, readFileSync, readdirSync, existsSync, lstatSync } from "node:fs";
import { join, relative, normalize } from "node:path";
import type { AgentDB, FileEntry, IndexOptions, IndexResult, IndexStatus, TreeDiff } from "./types";
import { getExcludePatterns } from "./file-tree";

function sqlError(op: string, cause: unknown): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${op} failed: ${msg}`);
}

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "tif",
  "tiff",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "wav",
  "webm",
  "mov",
  "avi",
  "mkv",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "o",
  "a",
  "class",
  "jar",
  "wasm",
  "sqlite",
  "db",
  "parquet",
  "gifv",
]);

/** Glob-like match for ignore patterns (slash-normalized). */
function pathMatchesPattern(target: string, pattern: string): boolean {
  const norm = target.replace(/\\/g, "/").replace(/^\/+/, "");
  const pat = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!pat.includes("*") && !pat.includes("?")) {
    return norm === pat || norm.startsWith(`${pat}/`) || norm.endsWith(`/${pat}`) || norm.includes(`/${pat}/`);
  }
  const esc = pat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0DS\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\0DS\0/g, ".*");
  const re = new RegExp(`^(?:${esc})$|^(?:${esc})/|/(?:${esc})$|/(?:${esc})/`);
  return re.test(norm) || new RegExp(`^${esc}$`).test(norm.split("/").pop() ?? "");
}

interface GitRule {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
}

function loadGitRules(repoPath: string): GitRule[] {
  const p = join(repoPath, ".gitignore");
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  const rules: GitRule[] = [];
  for (let line of raw.split("\n")) {
    line = line.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1).trim();
    }
    let dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    if (line) rules.push({ pattern: line, negated, dirOnly });
  }
  return rules;
}

function gitIgnored(rel: string, isDir: boolean, rules: GitRule[]): boolean {
  let ignored = false;
  const norm = rel.replace(/\\/g, "/");
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (pathMatchesPattern(norm, r.pattern)) {
      ignored = !r.negated;
    }
  }
  return ignored;
}

function languageFromExt(filePath: string): string | null {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    pyi: "python",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    kts: "kotlin",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    hh: "cpp",
    rb: "ruby",
    md: "markdown",
    mdx: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    swift: "swift",
    scala: "scala",
    dart: "dart",
    lua: "lua",
    ex: "elixir",
    exs: "elixir",
    hs: "haskell",
    cs: "csharp",
    fs: "fsharp",
    vb: "vb",
    php: "php",
  };
  return map[ext] ?? null;
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

interface ChunkPart {
  text: string;
  startLine: number;
  endLine: number;
}

/** Split on blank lines first, then subdivide long blocks by line with overlap. */
function chunkFileContent(content: string, chunkSize: number, overlap: number, minChunk: number): ChunkPart[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];

  const paragraphs = normalized.split(/\n\n+/);
  const result: ChunkPart[] = [];
  let lineCursor = 1;

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi]!;
    const paraLines = para.split("\n");
    const blockStart = lineCursor;
    lineCursor += paraLines.length + (pi < paragraphs.length - 1 ? 1 : 0);

    if (para.length <= chunkSize) {
      const t = para.trim();
      if (t && (t.length >= minChunk || result.length === 0)) {
        result.push({ text: t, startLine: blockStart, endLine: blockStart + paraLines.length - 1 });
      } else if (t && result.length > 0) {
        const prev = result[result.length - 1]!;
        prev.text = `${prev.text}\n\n${t}`;
        prev.endLine = blockStart + paraLines.length - 1;
      }
      continue;
    }

    let i = 0;
    while (i < paraLines.length) {
      let accLen = 0;
      let j = i;
      while (j < paraLines.length && accLen < chunkSize) {
        accLen += paraLines[j]!.length + (j > i ? 1 : 0);
        j++;
      }
      if (j === i) j = i + 1;
      const slice = paraLines.slice(i, j).join("\n").trim();
      if (slice) {
        if (slice.length >= minChunk || result.length === 0) {
          result.push({ text: slice, startLine: blockStart + i, endLine: blockStart + j - 1 });
        } else {
          const prev = result[result.length - 1]!;
          prev.text = `${prev.text}\n\n${slice}`;
          prev.endLine = blockStart + j - 1;
        }
      }
      if (j >= paraLines.length) break;
      const overlapLines = Math.max(1, Math.ceil(overlap / 80));
      i = Math.max(i + 1, j - overlapLines);
    }
  }

  return result;
}

function listSourceFiles(
  repoPath: string,
  exclude: string[],
  include: string[] | undefined,
  gitRules: GitRule[],
): string[] {
  const out: string[] = [];
  const normRoot = normalize(repoPath);

  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(normRoot, full).replace(/\\/g, "/");
      try {
        if (lstatSync(full).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (e.isDirectory()) {
        if (e.name === ".git") continue;
        if (exclude.some((p) => pathMatchesPattern(rel, p) || pathMatchesPattern(`${rel}/`, p))) continue;
        if (gitIgnored(rel, true, gitRules)) continue;
        walk(full);
      } else if (e.isFile()) {
        if (e.name === ".gitignore") continue;
        if (isBinaryPath(rel)) continue;
        if (exclude.some((p) => pathMatchesPattern(rel, p))) continue;
        if (gitIgnored(rel, false, gitRules)) continue;
        if (include != null && include.length > 0) {
          const ok = include.some((p) => pathMatchesPattern(rel, p));
          if (!ok) continue;
        }
        out.push(rel);
      }
    }
  };

  walk(normRoot);
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

/** Incrementally index text files under repoPath; embeddings are not written (extension-dependent). */
export function indexCodebase(db: AgentDB, repoPath: string, opts?: IndexOptions): IndexResult {
  const t0 = Date.now();
  const chunkSize = opts?.chunkSize ?? 1000;
  const chunkOverlap = opts?.chunkOverlap ?? 150;
  const minChunk = 250;
  const force = opts?.forceReindex ?? false;

  const fromDb = getExcludePatterns(db);
  const exclude = [...fromDb, ...(opts?.exclude ?? [])];

  const gitRules = loadGitRules(repoPath);
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
      let content: string;
      try {
        content = readFileSync(join(repoPath, rel), "utf8");
      } catch {
        continue;
      }
      const st = (() => {
        try {
          return statSync(join(repoPath, rel));
        } catch {
          return null;
        }
      })();
      const hash = sha256Hex(content);
      const prev = prevMap.get(rel);
      const changed = force || !prev || prev.hash !== hash;
      if (!changed) continue;

      filesChanged++;
      deleteChunksStmt.run(rel);

      const lang = languageFromExt(rel);
      const parts = chunkFileContent(content, chunkSize, chunkOverlap, minChunk);
      let idx = 0;
      for (const part of parts) {
        insertChunkStmt.run(rel, idx++, part.startLine, part.endLine, lang, part.text);
        chunksCreated++;
      }

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

/** Aggregate index metadata for dashboards. */
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

/** Diff DB file_tree vs filesystem without mutating the database. */
export function getFileTreeDiff(db: AgentDB, repoPath: string): TreeDiff {
  const fromDb = getExcludePatterns(db);
  const gitRules = loadGitRules(repoPath);
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
    let content: string;
    try {
      content = readFileSync(join(repoPath, p), "utf8");
    } catch {
      continue;
    }
    const hash = sha256Hex(content);
    const prev = prevMap.get(p);
    if (!prev) added.push(p);
    else if (prev.hash !== hash) changed.push(p);
  }
  for (const p of prevMap.keys()) {
    if (!disk.has(p)) removed.push(p);
  }

  added.sort();
  changed.sort();
  removed.sort();
  return { added, changed, removed };
}
