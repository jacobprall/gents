import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";
import { applyBlueprint } from "./blueprint";
import { sqlError } from "./errors";
import type { AgentBlueprint, AgentDB, CreateDBOptions } from "./types";
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

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

function applySchema(database: Database): void {
  try {
    database.exec(SCHEMA_SQL);
    const now = Date.now();
    database.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)`).run(SCHEMA_VERSION, now);
  } catch (e) {
    throw sqlError("applySchema", e);
  }
}

function applyMigrations(database: Database, fromVersion: number): void {
  const pending = MIGRATIONS.filter((m) => m.version > fromVersion).sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    try {
      database.exec(migration.sql);
      const now = Date.now();
      database.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)`).run(migration.version, now);
    } catch (e) {
      throw sqlError(`applyMigration(v${migration.version})`, e);
    }
  }
}

/**
 * Open or create an agent database. Applies schema when new, runs migrations for existing.
 * If `modelPath` is set, attempts to load native sqlite-vector / sqlite-ai extensions (non-fatal if missing).
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

  const currentVersion = getCurrentSchemaVersion(database);
  const isNew = currentVersion === 0;

  if (isNew) {
    applySchema(database);
  } else if (currentVersion < SCHEMA_VERSION) {
    applyMigrations(database, currentVersion);
  }

  const repoPath = opts?.repoPath ?? "";

  if (opts?.blueprint != null && isNew) {
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

/**
 * Create a database and persist blueprint seed data.
 * Only applies blueprint on fresh databases to avoid duplicating seed messages.
 */
export function createAgentDBFromBlueprint(
  dbPath: string,
  blueprint: AgentBlueprint,
  opts?: Omit<CreateDBOptions, "blueprint">,
): AgentDB {
  return createAgentDB(dbPath, { ...opts, blueprint });
}

export function closeAgentDB(agent: AgentDB): void {
  try {
    agent.db.close();
  } catch (e) {
    throw sqlError("close database", e);
  }
}
