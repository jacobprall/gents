import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";
import { applyBlueprint } from "./blueprint";
import type { AgentBlueprint, AgentDB, CreateDBOptions } from "./types";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

function sqlError(op: string, cause: unknown): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${op} failed: ${msg}`);
}

function extensionCandidates(baseDir: string): string[] {
  const ext = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
  const names = [
    `libsqlite_vector.${ext}`,
    `libsqlite_ai.${ext}`,
    `sqlite_vector.${ext}`,
    `sqlite_ai.${ext}`,
  ];
  return names.map((n) => join(baseDir, n));
}

function resolveExtensionBase(modelPath: string): string {
  try {
    const st = statSync(modelPath);
    if (st.isDirectory()) return modelPath;
    return dirname(modelPath);
  } catch {
    return dirname(modelPath);
  }
}

function tryLoadSqliteExtensions(database: Database, modelPath: string): boolean {
  let anyLoaded = false;
  const base = resolveExtensionBase(modelPath);
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

function schemaNeedsApply(database: Database): boolean {
  try {
    const row = database
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_version' LIMIT 1`)
      .get() as { ok: number } | undefined;
    if (!row) return true;
    const ver = database.prepare(`SELECT version FROM schema_version WHERE version = ?`).get(SCHEMA_VERSION) as
      | { version: number }
      | undefined;
    return ver === undefined;
  } catch {
    return true;
  }
}

function applySchema(database: Database): void {
  try {
    database.exec(SCHEMA_SQL);
    const now = Date.now();
    database.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)`).run(SCHEMA_VERSION, now);
  } catch (e) {
    throw sqlError("applySchema", e);
  }
}

/**
 * Open or create an agent database. Applies schema when new.
 * If `modelPath` is set, attempts to load native sqlite-vector / sqlite-ai extensions from that directory (non-fatal if missing).
 */
export function createAgentDB(dbPath: string, opts?: CreateDBOptions): AgentDB {
  let database: Database;
  try {
    database = new Database(dbPath, { create: true });
  } catch (e) {
    throw sqlError("open database", e);
  }

  try {
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`);
  } catch (e) {
    try {
      database.close();
    } catch {
      /* ignore */
    }
    throw sqlError("configure PRAGMAs", e);
  }

  let modelLoaded = false;
  const modelPath = opts?.modelPath;
  if (modelPath) {
    try {
      modelLoaded = tryLoadSqliteExtensions(database, modelPath);
    } catch {
      modelLoaded = false;
    }
  }

  let newInstall = false;
  if (schemaNeedsApply(database)) {
    applySchema(database);
    newInstall = true;
  }

  const repoPath = opts?.repoPath ?? "";
  if (opts?.blueprint != null && newInstall) {
    try {
      applyBlueprint({ db: database, repoPath, dbPath, modelLoaded }, opts.blueprint);
    } catch (e) {
      throw sqlError("applyBlueprint (options.blueprint)", e);
    }
  }

  return {
    db: database,
    dbPath,
    repoPath,
    modelLoaded,
  };
}

/** Create a database and persist blueprint seed data (tools, permissions, patterns, config, messages). */
export function createAgentDBFromBlueprint(
  dbPath: string,
  blueprint: AgentBlueprint,
  opts?: Omit<CreateDBOptions, "blueprint">,
): AgentDB {
  const db = createAgentDB(dbPath, opts);
  applyBlueprint(db, blueprint);
  return db;
}

/** Close the underlying SQLite connection. */
export function closeAgentDB(agent: AgentDB): void {
  try {
    agent.db.close();
  } catch (e) {
    throw sqlError("close database", e);
  }
}
