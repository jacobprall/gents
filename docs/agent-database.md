# gents — Agent Database

The agent database is the foundational layer. Everything else in gents reads from or writes to this SQLite file.

---

## Schema

### events

Append-only log of everything the agent does. The source of truth for reconstruction and auditing.

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  turn INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_turn ON events(turn);
CREATE INDEX idx_events_created ON events(created_at);
```

**Event types:**
- `turn.started`, `turn.completed`, `turn.failed`
- `tool.called`, `tool.completed`, `tool.failed`
- `index.started`, `index.completed`
- `compaction.created`
- `session.started`, `session.resumed`
- `cost.recorded`

### messages

The conversation. Each message is a turn in the dialogue between user, assistant, and tools.

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  turn INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_turn ON messages(turn);
CREATE INDEX idx_messages_role ON messages(role);
```

### compaction_markers

When conversation grows too long, the agent can compact earlier turns into a summary. These markers tell the context assembler to replace old messages with the summary.

```sql
CREATE TABLE compaction_markers (
  id TEXT PRIMARY KEY,
  up_to_turn INTEGER NOT NULL,
  summary TEXT NOT NULL,
  token_count INTEGER,
  created_at INTEGER NOT NULL
);
```

**How compaction works:**
1. Agent observes context pressure (approaching token limit)
2. Agent calls `compact_conversation` tool with a target turn
3. The tool generates a summary of messages up to that turn
4. A marker is written
5. Next assembly: messages before marker are omitted, summary is injected instead

### code_chunks

Chunked source code with embeddings for hybrid search.

```sql
CREATE TABLE code_chunks (
  rowid INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  language TEXT,
  chunk_text TEXT NOT NULL,
  embedding BLOB
);

CREATE INDEX idx_chunks_path ON code_chunks(path);
CREATE INDEX idx_chunks_language ON code_chunks(language);
```

Vector initialization (run once after table creation):
```sql
SELECT vector_init('code_chunks', 'embedding',
  'type=FLOAT32, dimension=768, distance=COSINE');
```

After bulk insert, build the ANN index:
```sql
SELECT vector_quantize('code_chunks', 'embedding');
SELECT vector_quantize_preload('code_chunks', 'embedding');
```

### code_fts

FTS5 virtual table for BM25 keyword search. Content-synced with code_chunks.

```sql
CREATE VIRTUAL TABLE code_fts USING fts5(
  path,
  chunk_text,
  language,
  content='code_chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
```

Rebuild triggers after code_chunks modifications:
```sql
CREATE TRIGGER code_chunks_ai AFTER INSERT ON code_chunks BEGIN
  INSERT INTO code_fts(rowid, path, chunk_text, language)
    VALUES (new.rowid, new.path, new.chunk_text, new.language);
END;

CREATE TRIGGER code_chunks_ad AFTER DELETE ON code_chunks BEGIN
  INSERT INTO code_fts(code_fts, rowid, path, chunk_text, language)
    VALUES ('delete', old.rowid, old.path, old.chunk_text, old.language);
END;
```

### file_tree

Filesystem state for incremental indexing. Tracks which files have been indexed and their content hashes.

```sql
CREATE TABLE file_tree (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  size INTEGER,
  modified_at INTEGER,
  language TEXT,
  indexed_at INTEGER
);
```

### tool_cache

Memoized tool results. Prevents re-running expensive operations when the inputs haven't changed.

```sql
CREATE TABLE tool_cache (
  hash TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

### config

Agent configuration persisted in the database.

```sql
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Keys: `model`, `provider`, `max_turns`, `cost_limit_usd`, `repo_path`, `session_id`.

---

## Operations

### createAgentDB(path)

Opens or creates a database at the given path. Loads extensions, runs migrations if needed.

```typescript
function createAgentDB(dbPath: string, opts?: {
  modelPath?: string;  // path to Nomic Embed GGUF
  repoPath?: string;   // working directory for the agent
}): AgentDB;
```

On first creation:
1. Open SQLite connection
2. Load sqlite-vector extension
3. Load sqlite-ai extension
4. Load Nomic Embed GGUF into sqlite-ai
5. Create embedding context (FLOAT32, normalized)
6. Run schema migrations
7. Initialize vector index on code_chunks

### indexCodebase(db, repoPath, opts)

Incremental code indexing.

```typescript
function indexCodebase(db: AgentDB, repoPath: string, opts?: {
  include?: string[];    // glob patterns to include
  exclude?: string[];    // glob patterns to exclude
  chunkSize?: number;    // default 1000 chars
  chunkOverlap?: number; // default 150 chars
  forceReindex?: boolean;
}): IndexResult;
```

Steps:
1. Walk filesystem respecting .gitignore + include/exclude
2. Hash each file, compare against file_tree
3. For changed/new files: chunk with language-aware splitting
4. Embed each chunk via sqlite-ai (`llm_embed_generate`)
5. Batch insert into code_chunks
6. Rebuild FTS triggers
7. Quantize vectors for ANN search
8. Update file_tree with new hashes

### hybridSearch(db, query, opts)

Combined BM25 + semantic search.

```typescript
function hybridSearch(db: AgentDB, query: string, opts?: {
  limit?: number;        // default 20
  languages?: string[];  // filter by language
  paths?: string[];      // filter by path glob
  bm25Weight?: number;   // default 0.3
  vectorWeight?: number; // default 0.7
}): SearchResult[];
```

Implementation:
1. Embed query via sqlite-ai (`search_query: ${query}` prefix for Nomic)
2. BM25 search: `SELECT ... FROM code_fts WHERE code_fts MATCH ?`
3. Vector search: `SELECT ... FROM vector_quantize_scan('code_chunks', 'embedding', ?, k)`
4. Reciprocal Rank Fusion: `score = sum(1 / (k + rank))` across both result lists
5. Return merged, deduplicated, sorted results

### getConversation(db, opts)

Reads conversation history, respecting compaction markers.

```typescript
function getConversation(db: AgentDB, opts?: {
  maxTokens?: number;   // budget for conversation in context
  fromTurn?: number;    // start from specific turn
}): Message[];
```

Logic:
1. Find latest compaction_marker (if any)
2. If marker exists: start with marker summary as a system/context message
3. Append all messages after marker's `up_to_turn`
4. If no marker: return all messages
5. Optionally truncate from the beginning if exceeding maxTokens

### compactConversation(db, upToTurn, summary)

Creates a compaction marker.

```typescript
function compactConversation(db: AgentDB, upToTurn: number, summary: string): void;
```

### appendMessage(db, message) / appendEvent(db, event)

Write operations. Generate UUIDv7 IDs, set timestamps.

---

## Embedding Pipeline

### Model: Nomic Embed Text v1.5

- Parameters: 137M
- Dimensions: 768 (supports Matryoshka truncation to 256/512)
- Format: GGUF Q8_0 (~150MB)
- Trained on code and natural language
- Requires task prefixes: `search_document:` for indexing, `search_query:` for queries

### Loading via sqlite-ai

```sql
SELECT llm_model_load('/path/to/nomic-embed-text-v1.5.Q8_0.gguf', 'gpu_layers=99');
SELECT llm_context_create_embedding('embedding_type=FLOAT32, normalize_embedding=1');
```

### Generating embeddings

```sql
-- Single embedding (query time)
SELECT llm_embed_generate('search_query: how does authentication work');

-- Batch during indexing (per chunk)
INSERT INTO code_chunks (path, chunk_index, start_line, end_line, language, chunk_text, embedding)
  VALUES (?, ?, ?, ?, ?, ?, llm_embed_generate('search_document: ' || ?));
```

### Performance expectations (Apple Silicon M-series)

- Embedding throughput: ~100-200 chunks/second
- Vector query (1M vectors, dim 768): < 1ms with quantized ANN
- BM25 query: < 1ms
- Combined hybrid search: < 5ms total

---

## Chunking Strategy

Language-aware recursive text splitting:

1. **Detect language** from file extension
2. **Split at natural boundaries** (in priority order):
   - Function/class/method boundaries (language-specific)
   - Blank lines (paragraph breaks)
   - Line breaks
   - Character limit fallback
3. **Parameters:**
   - Target chunk size: 1000 characters
   - Minimum chunk size: 250 characters
   - Overlap: 150 characters (context preservation across boundaries)
4. **Metadata:** Each chunk records path, start_line, end_line, language

Files that should not be indexed (binary, generated, vendor) are excluded via .gitignore parsing + configurable patterns.

---

## File Organization

```
~/.gents/
  config.json              # Global config (API keys, model path, defaults)
  models/
    nomic-embed-text-v1.5.Q8_0.gguf

<repo>/.gents/
  default.agent.db         # Default session database
  sessions/
    <session-id>.agent.db  # Named sessions
```
