/** Full SQLite schema for the coding-agent database (v1). */
export const SCHEMA_VERSION = 1;

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
`;
