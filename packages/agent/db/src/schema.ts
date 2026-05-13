export const SCHEMA_VERSION = 3;

export interface Migration {
  version: number;
  sql: string;
}

/**
 * Ordered list of migrations. Each entry upgrades from (version-1) to version.
 *
 * IMPORTANT: When adding a migration, also update SCHEMA_SQL below to include
 * the same changes. SCHEMA_SQL is the canonical "latest full schema" applied to
 * fresh databases; migrations handle upgrades from older versions.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    sql: `
CREATE TRIGGER IF NOT EXISTS code_chunks_au AFTER UPDATE ON code_chunks BEGIN
  INSERT INTO code_fts(code_fts, rowid, path, chunk_text, language)
  VALUES ('delete', old.rowid, old.path, old.chunk_text, old.language);
  INSERT INTO code_fts(rowid, path, chunk_text, language)
  VALUES (new.rowid, new.path, new.chunk_text, new.language);
END;
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'builtin',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subagent_defs (
  name TEXT PRIMARY KEY,
  skill TEXT NOT NULL REFERENCES skills(name),
  description TEXT NOT NULL,
  allowed_tools TEXT NOT NULL,
  max_iterations INTEGER DEFAULT 10,
  max_cost_usd REAL,
  source TEXT NOT NULL DEFAULT 'builtin',
  created_at INTEGER NOT NULL
);
`,
  },
];

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  turn INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_turn ON events(turn);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  turn INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(turn);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

CREATE TABLE IF NOT EXISTS compaction_markers (
  id TEXT PRIMARY KEY,
  up_to_turn INTEGER NOT NULL,
  summary TEXT NOT NULL,
  token_count INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS code_chunks (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  language TEXT,
  chunk_text TEXT NOT NULL,
  embedding BLOB
);

CREATE INDEX IF NOT EXISTS idx_chunks_path ON code_chunks(path);
CREATE INDEX IF NOT EXISTS idx_chunks_language ON code_chunks(language);

CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
  path,
  chunk_text,
  language,
  content='code_chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS code_chunks_ai AFTER INSERT ON code_chunks BEGIN
  INSERT INTO code_fts(rowid, path, chunk_text, language)
  VALUES (new.rowid, new.path, new.chunk_text, new.language);
END;

CREATE TRIGGER IF NOT EXISTS code_chunks_ad AFTER DELETE ON code_chunks BEGIN
  INSERT INTO code_fts(code_fts, rowid, path, chunk_text, language)
  VALUES ('delete', old.rowid, old.path, old.chunk_text, old.language);
END;

CREATE TRIGGER IF NOT EXISTS code_chunks_au AFTER UPDATE ON code_chunks BEGIN
  INSERT INTO code_fts(code_fts, rowid, path, chunk_text, language)
  VALUES ('delete', old.rowid, old.path, old.chunk_text, old.language);
  INSERT INTO code_fts(rowid, path, chunk_text, language)
  VALUES (new.rowid, new.path, new.chunk_text, new.language);
END;

CREATE TABLE IF NOT EXISTS file_tree (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  size INTEGER,
  modified_at INTEGER,
  language TEXT,
  indexed_at INTEGER
);

CREATE TABLE IF NOT EXISTS tool_cache (
  hash TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  turn INTEGER PRIMARY KEY,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS tools (
  name TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exclude_patterns (
  pattern TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'builtin',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subagent_defs (
  name TEXT PRIMARY KEY,
  skill TEXT NOT NULL REFERENCES skills(name),
  description TEXT NOT NULL,
  allowed_tools TEXT NOT NULL,
  max_iterations INTEGER DEFAULT 10,
  max_cost_usd REAL,
  source TEXT NOT NULL DEFAULT 'builtin',
  created_at INTEGER NOT NULL
);
`;

/**
 * Validate that SCHEMA_SQL and MIGRATIONS don't drift apart.
 * Call this in tests to ensure every table created by a migration also exists in SCHEMA_SQL.
 */
export function validateSchemaConsistency(): { ok: boolean; missing: string[] } {
  const tableRe = /CREATE TABLE[^(]*?(\w+)\s*\(/gi;
  const schemaTableNames = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(SCHEMA_SQL)) !== null) {
    schemaTableNames.add(m[1]!.toLowerCase());
  }

  const missing: string[] = [];
  for (const migration of MIGRATIONS) {
    const migRe = /CREATE TABLE[^(]*?(\w+)\s*\(/gi;
    let mm: RegExpExecArray | null;
    while ((mm = migRe.exec(migration.sql)) !== null) {
      const name = mm[1]!.toLowerCase();
      if (!schemaTableNames.has(name)) {
        missing.push(`v${migration.version}: table "${name}" not in SCHEMA_SQL`);
      }
    }
  }

  return { ok: missing.length === 0, missing };
}
