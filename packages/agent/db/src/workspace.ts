import { Database } from "bun:sqlite";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { sqlError } from "./errors";
import type { WorkspaceDB } from "./types";
import { WORKSPACE_SCHEMA_SQL, WORKSPACE_SCHEMA_VERSION, WORKSPACE_MIGRATIONS } from "./schema";
import { DEFAULT_EXCLUDE_PATTERNS } from "./blueprint";
import { languageFromExt, sha256Hex, chunkFileContent } from "./chunker";

// ---------------------------------------------------------------------------
// Workspace DB lifecycle
// ---------------------------------------------------------------------------

function getCurrentSchemaVersion(database: Database): number {
  try {
    const row = database
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_version' LIMIT 1`)
      .get() as { ok: number } | undefined;
    if (!row) return 0;
    const ver = database.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number | null } | undefined;
    return ver?.v ?? 0;
  } catch {
    return 0;
  }
}

function tryLoadVectorExtension(database: Database): boolean {
  try {
    const { getExtensionPath } = require("@sqliteai/sqlite-vector") as { getExtensionPath: () => string };
    database.loadExtension(getExtensionPath());
    return true;
  } catch {
    return false;
  }
}

function tryLoadAIExtension(database: Database): boolean {
  try {
    const { getExtensionPath } = require("@sqliteai/sqlite-ai") as { getExtensionPath: () => string };
    database.loadExtension(getExtensionPath());
    return true;
  } catch {
    return false;
  }
}

function tryLoadSyncExtension(database: Database): boolean {
  try {
    const { getExtensionPath } = require("@sqliteai/sqlite-sync") as { getExtensionPath: () => string };
    database.loadExtension(getExtensionPath());
    return true;
  } catch {
    return false;
  }
}

function extensionCandidates(baseDir: string): string[] {
  const ext = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
  const names = [
    `libsqlite_vector.${ext}`,
    `libsqlite_ai.${ext}`,
    `sqlite_vector.${ext}`,
    `sqlite_ai.${ext}`,
    `cloudsync.${ext}`,
  ];
  return names.map((n) => join(baseDir, n));
}

function tryLoadExtensionsFromPath(database: Database, modelPath: string): boolean {
  let anyLoaded = false;
  let base: string;
  try {
    base = statSync(modelPath).isDirectory() ? modelPath : dirname(modelPath);
  } catch {
    base = dirname(modelPath);
  }
  for (const fullPath of extensionCandidates(base)) {
    try {
      database.loadExtension(fullPath);
      anyLoaded = true;
    } catch {
      try {
        database.loadExtension(fullPath.replace(/\.(dylib|so|dll)$/, ""));
        anyLoaded = true;
      } catch {
        /* skip */
      }
    }
  }
  return anyLoaded;
}

/**
 * Open or create the shared workspace index database.
 * Stored at `<workspacePath>/.gents/workspace.sqlite`.
 */
export function createWorkspaceDB(
  workspacePath: string,
  opts?: { modelPath?: string },
): WorkspaceDB {
  const gentsDir = join(workspacePath, ".gents");
  if (!existsSync(gentsDir)) {
    mkdirSync(gentsDir, { recursive: true });
  }

  const dbPath = join(gentsDir, "workspace.sqlite");
  let database: Database;
  try {
    database = new Database(dbPath, { create: true });
  } catch (e) {
    throw sqlError("open workspace database", e);
  }

  try {
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`);
  } catch (e) {
    try { database.close(); } catch { /* ignore */ }
    throw sqlError("configure workspace PRAGMAs", e);
  }

  let modelLoaded = false;
  try {
    const vectorOk = tryLoadVectorExtension(database);
    const aiOk = tryLoadAIExtension(database);
    modelLoaded = vectorOk || aiOk;
  } catch {
    modelLoaded = false;
  }

  if (!modelLoaded && opts?.modelPath) {
    try {
      modelLoaded = tryLoadExtensionsFromPath(database, opts.modelPath);
    } catch {
      modelLoaded = false;
    }
  }

  let syncLoaded = false;
  try {
    syncLoaded = tryLoadSyncExtension(database);
  } catch {
    syncLoaded = false;
  }

  const currentVersion = getCurrentSchemaVersion(database);
  if (currentVersion === 0) {
    try {
      database.exec(WORKSPACE_SCHEMA_SQL);
      database
        .prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)`)
        .run(WORKSPACE_SCHEMA_VERSION, Date.now());

      const insertExclude = database.prepare(
        `INSERT OR IGNORE INTO exclude_patterns (pattern, source) VALUES (?, 'default')`,
      );
      const seedTx = database.transaction(() => {
        for (const pattern of DEFAULT_EXCLUDE_PATTERNS) {
          insertExclude.run(pattern);
        }
      });
      seedTx();
    } catch (e) {
      throw sqlError("apply workspace schema", e);
    }
  } else if (currentVersion < WORKSPACE_SCHEMA_VERSION) {
    const pending = WORKSPACE_MIGRATIONS
      .filter((m) => m.version > currentVersion)
      .sort((a, b) => a.version - b.version);
    for (const migration of pending) {
      try {
        database.exec(migration.sql);
        database
          .prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)`)
          .run(migration.version, Date.now());
      } catch (e) {
        throw sqlError(`workspace migration v${migration.version}`, e);
      }
    }
  }

  let siteId: string | undefined;
  if (syncLoaded) {
    try {
      const row = database.prepare(`SELECT quote(cloudsync_siteid()) AS sid`).get() as { sid: string } | undefined;
      if (row?.sid) {
        siteId = row.sid;
      }
    } catch { /* extension loaded but siteid unavailable */ }
  }

  return { db: database, dbPath, workspacePath, modelLoaded, syncLoaded, siteId };
}

export function closeWorkspaceDB(ws: WorkspaceDB): void {
  try {
    ws.db.close();
  } catch (e) {
    throw sqlError("close workspace database", e);
  }
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function assertSafeRelPath(relPath: string): void {
  const norm = normalize(relPath);
  if (isAbsolute(norm) || norm.startsWith("..")) {
    throw new Error(`Unsafe relative path: ${relPath}`);
  }
}

// ---------------------------------------------------------------------------
// Single-file re-indexing (write-through)
// ---------------------------------------------------------------------------

/**
 * Re-index a single file by its relative path. Reads from disk, re-chunks,
 * and updates the workspace DB atomically. Designed for write-through use
 * after file_write / file_edit.
 */
export function reindexFile(
  ws: WorkspaceDB,
  relPath: string,
  opts?: { content?: string; chunkSize?: number; chunkOverlap?: number },
): void {
  assertSafeRelPath(relPath);
  const chunkSize = opts?.chunkSize ?? 1000;
  const chunkOverlap = opts?.chunkOverlap ?? 150;
  const minChunk = 250;
  const now = Date.now();

  const fullPath = join(ws.workspacePath, relPath);
  let content = opts?.content;
  if (content == null) {
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      removeFileFromIndex(ws, relPath);
      return;
    }
  }

  const hash = sha256Hex(content);
  const lang = languageFromExt(relPath);
  const parts = chunkFileContent(content, chunkSize, chunkOverlap, minChunk);
  let st: { size: number; mtimeMs: number } | null = null;
  try {
    st = statSync(fullPath);
  } catch { /* file may have been written in memory only */ }

  const tx = ws.db.transaction(() => {
    ws.db.prepare(`DELETE FROM code_chunks WHERE path = ?`).run(relPath);

    let idx = 0;
    for (const part of parts) {
      ws.db
        .prepare(
          `INSERT INTO code_chunks (path, chunk_index, start_line, end_line, language, chunk_text, embedding)
           VALUES (?,?,?,?,?,?,NULL)`,
        )
        .run(relPath, idx++, part.startLine, part.endLine, lang, part.text);
    }

    ws.db
      .prepare(
        `INSERT OR REPLACE INTO file_tree (path, hash, size, modified_at, language, indexed_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(relPath, hash, st?.size ?? content!.length, st != null ? Math.trunc(st.mtimeMs) : null, lang, now);
  });

  try {
    tx();
  } catch (e) {
    throw sqlError("reindexFile", e);
  }
}

/**
 * Re-index multiple files by relative path in a single transaction.
 * Designed for batch updates after git commit.
 */
export function reindexFiles(ws: WorkspaceDB, relPaths: string[]): void {
  if (relPaths.length === 0) return;
  for (const p of relPaths) assertSafeRelPath(p);
  if (relPaths.length === 1) {
    reindexFile(ws, relPaths[0]!);
    return;
  }

  const chunkSize = 1000;
  const chunkOverlap = 150;
  const minChunk = 250;
  const now = Date.now();

  const deleteChunksStmt = ws.db.prepare(`DELETE FROM code_chunks WHERE path = ?`);
  const insertChunkStmt = ws.db.prepare(
    `INSERT INTO code_chunks (path, chunk_index, start_line, end_line, language, chunk_text, embedding)
     VALUES (?,?,?,?,?,?,NULL)`,
  );
  const upsertFileStmt = ws.db.prepare(
    `INSERT OR REPLACE INTO file_tree (path, hash, size, modified_at, language, indexed_at)
     VALUES (?,?,?,?,?,?)`,
  );
  const deleteFileStmt = ws.db.prepare(`DELETE FROM file_tree WHERE path = ?`);

  const tx = ws.db.transaction(() => {
    for (const relPath of relPaths) {
      const fullPath = join(ws.workspacePath, relPath);
      let content: string;
      try {
        content = readFileSync(fullPath, "utf8");
      } catch {
        deleteChunksStmt.run(relPath);
        deleteFileStmt.run(relPath);
        continue;
      }

      const hash = sha256Hex(content);
      const lang = languageFromExt(relPath);
      const parts = chunkFileContent(content, chunkSize, chunkOverlap, minChunk);
      let st: { size: number; mtimeMs: number } | null = null;
      try { st = statSync(fullPath); } catch { /* ok */ }

      deleteChunksStmt.run(relPath);

      let idx = 0;
      for (const part of parts) {
        insertChunkStmt.run(relPath, idx++, part.startLine, part.endLine, lang, part.text);
      }

      upsertFileStmt.run(
        relPath, hash,
        st?.size ?? content.length,
        st != null ? Math.trunc(st.mtimeMs) : null,
        lang, now,
      );
    }
  });

  try {
    tx();
  } catch (e) {
    throw sqlError("reindexFiles", e);
  }
}

/**
 * Remove a file from the workspace index (e.g. after deletion).
 */
export function removeFileFromIndex(ws: WorkspaceDB, relPath: string): void {
  assertSafeRelPath(relPath);
  try {
    const tx = ws.db.transaction(() => {
      ws.db.prepare(`DELETE FROM code_chunks WHERE path = ?`).run(relPath);
      ws.db.prepare(`DELETE FROM file_tree WHERE path = ?`).run(relPath);
    });
    tx();
  } catch (e) {
    throw sqlError("removeFileFromIndex", e);
  }
}

/**
 * Check whether a file's index entry appears stale vs. disk.
 * Returns true if the file needs re-indexing.
 */
export function fileIndexStale(ws: WorkspaceDB, relPath: string): boolean {
  assertSafeRelPath(relPath);
  const row = ws.db
    .prepare(`SELECT hash, size, modified_at FROM file_tree WHERE path = ?`)
    .get(relPath) as { hash: string; size: number | null; modified_at: number | null } | undefined;
  if (!row) return true;

  const fullPath = join(ws.workspacePath, relPath);
  try {
    const st = statSync(fullPath);
    if (row.size != null && st.size !== row.size) return true;
    if (row.modified_at != null && Math.trunc(st.mtimeMs) !== row.modified_at) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Validate search results against disk, re-indexing stale files on the fly.
 * Returns the original results with ghost entries (deleted files) removed.
 */
export function validateAndRefreshResults<T extends { path: string }>(
  ws: WorkspaceDB,
  results: T[],
): T[] {
  const refreshed = new Set<string>();
  const valid: T[] = [];

  for (const r of results) {
    const fullPath = join(ws.workspacePath, r.path);
    if (!existsSync(fullPath)) continue; // ghost

    if (!refreshed.has(r.path) && fileIndexStale(ws, r.path)) {
      reindexFile(ws, r.path);
      refreshed.add(r.path);
    }
    valid.push(r);
  }

  return valid;
}

// ---------------------------------------------------------------------------
// Helpers: resolve workspace DB from AgentDB
// ---------------------------------------------------------------------------

/**
 * Get the Database handle to use for workspace-level queries (file_tree,
 * code_chunks, code_fts, exclude_patterns). Falls back to the session DB
 * for legacy single-DB setups.
 */
export function getWorkspaceHandle(agent: { db: import("bun:sqlite").Database; workspace?: WorkspaceDB }): import("bun:sqlite").Database {
  return agent.workspace?.db ?? agent.db;
}
