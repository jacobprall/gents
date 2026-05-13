# gents — Technical Decisions

Key decisions, their rationale, and alternatives considered.

---

## SQLite as Primary Store (not Postgres)

**Decision:** Agent state lives in a local SQLite file, not a remote PostgreSQL database.

**Rationale:**
- Zero-latency reads for code search and context assembly
- Works fully offline
- The database file IS the agent's portable identity (fork, transfer, inspect)
- No server process needed for local operation
- Single-writer model eliminates concurrency complexity for a single agent
- sqlite-vector provides production-grade ANN search in-process

**Alternatives considered:**
- PostgreSQL (current openforge-v2 approach) — requires network, can't work offline, adds operational complexity for local use
- Embedded key-value stores (LMDB, LevelDB) — no SQL, no FTS, no vector search
- In-memory only — lost on crash, can't persist across sessions

**Trade-offs accepted:**
- Single writer (fine for one agent per database)
- No concurrent access from multiple processes (MCP server must be same process or use WAL mode)
- Large databases for big repos (mitigated with Float16 vectors, exclude patterns)

---

## sqlite-vector (not sqlite-vec, not external vector DB)

**Decision:** Use sqlite-vector from SQLite Cloud for vector search.

**Rationale:**
- Sub-millisecond ANN queries on millions of vectors
- Multiple vector types (Float32, Float16, Int8) for storage/speed tradeoffs
- SIMD-accelerated (AVX2, NEON) distance computations
- Works with regular tables and BLOB columns (no special schema)
- Integrates naturally with SQLite's query planner (JOIN with main tables)
- Quantization for memory-efficient ANN (< 50MB for 1M vectors)

**Why not sqlite-vec:**
- sqlite-vector is the more mature, production-grade extension
- Better quantization and memory management
- Higher performance benchmarks (< 1ms on 1M vectors)

**Why not an external vector DB (Qdrant, Pinecone, etc.):**
- Adds a service dependency (defeats local-first goal)
- Network latency for every search
- Can't bundle in a single portable database file
- Operational complexity

---

## Nomic Embed v1.5 GGUF (local embeddings)

**Decision:** Generate embeddings locally using Nomic Embed Text v1.5 via sqlite-ai.

**Rationale:**
- No API costs for embedding generation
- Works offline
- Fast on Apple Silicon (~100-200 embeddings/sec)
- Good quality on both code and natural language
- 768 dimensions with Matryoshka support (can truncate to 256 for storage savings)
- Available as GGUF (loadable by sqlite-ai/llama.cpp)
- Task-prefix aware (`search_document:` / `search_query:`) for asymmetric search

**Alternatives considered:**
- OpenAI text-embedding-3-small — costs money per call, requires network
- Voyage Code — better code embeddings but API-only
- Local sentence-transformers via Python — adds Python dependency, cross-process overhead
- CodeRankEmbed — good for code but larger model

**Trade-offs accepted:**
- ~150MB model download on first run
- ~30-60s for initial index of a large repo (acceptable with progress UI)
- Slightly lower embedding quality than larger API models (Nomic is still very good for 137M params)

---

## Bun Runtime (not Node.js)

**Decision:** Use Bun as the primary runtime.

**Rationale:**
- Built-in SQLite with extension loading support
- Faster startup than Node.js (important for CLI)
- Native TypeScript execution (no build step for development)
- Single binary distribution potential (bun build --compile)
- Good performance for I/O-heavy workloads

**Alternatives considered:**
- Node.js + better-sqlite3 — more mature, larger ecosystem, but slower startup, requires native compilation
- Deno — good SQLite support but smaller ecosystem

**Trade-offs accepted:**
- Bun's SQLite API is less documented than better-sqlite3
- Some npm packages may have Bun compatibility issues
- Extension loading behavior may differ from better-sqlite3 (spike validates this)

---

## Simplified Context Layer (not full livectx)

**Decision:** Build a minimal prompt assembly system (`@gents/agent-ctx`) rather than using livectx for the base layer. Add livectx sources incrementally when the CLI needs live remote data.

**Rationale:**
- The base prompt layer is purpose-built for gents: declarative sections, static/dynamic placement, cache breakpoint — ~200 lines
- livectx's async/caching machinery is unnecessary for SQLite-backed sections (microsecond reads)
- But `definePrompt` already supports async resolvers, so livectx sources can be mixed in without rearchitecting
- When the CLI needs remote data (Render service status, GitHub PR state, deploy health), livectx sources are added to the sections array and gated on credential availability
- This avoids a hard split where only the cloud worker gets live data — the CLI can be progressively enhanced

**What the base layer provides:**
- Declarative prompt sections
- Static/dynamic placement
- Cache breakpoint for Anthropic prefix caching
- Clean separation between data resolution and output formatting
- Async resolver support (ready for livectx sources)

**What livectx adds when used:**
- SWR cache with staleTime/gcTime for remote API calls
- Retry and error handling for network requests
- Push invalidation when webhooks arrive (cloud worker only)

**What we still don't need locally:**
- Dependency graphs between bindings
- Multiple sink adapters
- Template tagged literal DSL

---

## Anthropic Primary (not multi-provider from day 1)

**Decision:** Support only Anthropic Claude in phase 1.

**Rationale:**
- Claude is the best model for agentic coding (tool use quality, instruction following)
- Anthropic has the most effective prompt caching (direct cost savings)
- One provider means simpler code, fewer edge cases
- Multi-provider adds complexity with limited benefit in phase 1

**Future path:**
- Add OpenAI when needed (new formatting function, no architectural change)
- Add Google when needed (same)
- The ctx layer's section system is provider-agnostic by design

---

## Hybrid Search (BM25 + Vector) with RRF

**Decision:** Combine keyword and semantic search using Reciprocal Rank Fusion.

**Rationale:**
- BM25 excels at exact matches (function names, error messages, identifiers)
- Vector search excels at conceptual similarity (finding relevant code by description)
- Neither alone is sufficient for code search
- RRF is simple, effective, and doesn't require training a fusion model
- Both search types run in < 1ms locally, so combining them adds negligible latency

**Implementation:**
```
score(doc) = Σ 1/(k + rank_in_list_i)  for each list where doc appears
```
- k = 60 (standard RRF constant)
- Weight BM25 at 0.3, vector at 0.7 (tunable)
- Deduplicate by chunk rowid

**Alternatives considered:**
- Vector only — misses exact identifier matches
- BM25 only — misses conceptual/semantic relationships
- Learned fusion — requires training data, adds complexity
- Re-ranking with a cross-encoder — adds latency, model dependency

---

## Conversation Compaction (not truncation)

**Decision:** Agent-initiated summarization with persistent markers, not automatic truncation.

**Rationale:**
- Automatic truncation silently loses context (the agent doesn't know what was removed)
- Agent-initiated compaction is explicit (the agent decides what's important to retain)
- Markers are persistent (the summary survives across sessions)
- The agent can reference the summary and knows its limitations
- Better user experience (user sees compaction happen, can inspect summaries)

**How it works:**
1. Agent observes it's approaching context limits
2. Agent generates a summary of earlier turns
3. Agent calls `compact_conversation(up_to_turn, summary)` tool
4. Context assembly replaces old messages with the summary
5. Summary is inspectable in the database

---

## MCP for Both Internal and External (not separate APIs)

**Decision:** One MCP server serves both the agent's own tools and external clients.

**Rationale:**
- Single source of truth for the agent's capabilities
- External clients get the same interface the agent uses
- Testing the MCP server tests the agent's tools implicitly
- Cursor/Claude Desktop integration comes for free
- Clean protocol boundary (MCP is well-specified)

**Internal vs. external differences:**
- Internal: tools called as direct functions for performance (MCP is optional transport)
- External: tools called via stdio/HTTP MCP transport
- Same implementations, different transports

---

## pnpm Workspaces with Grouped Packages

**Decision:** Separate npm packages grouped under `packages/agent/` directory.

**Rationale:**
- `agent-db` has native dependencies (SQLite extensions) that shouldn't be pulled by packages that don't need them
- Clear dependency directions enforced by package boundaries
- Each package can have its own test suite and build config
- Visual grouping under `agent/` shows these are related
- Can be published independently if needed

**Workspace config:**
```yaml
packages:
  - "packages/agent/*"
  - "packages/sync"
  - "packages/worker"
  - "apps/*"
  - "services/*"
```

---

## Incremental Indexing via File Hashes (not CocoIndex pipeline)

**Decision:** Simple hash-based change detection rather than a full pipeline engine.

**Rationale:**
- CocoIndex (used by cocoindex-code) is a Rust-backed pipeline engine — heavy dependency
- For our use case, the problem is simpler: detect changed files, re-chunk, re-embed
- Content hashing + file_tree table gives us incremental behavior with zero dependencies
- Git integration (diff against last indexed commit) provides an even faster path
- The indexer is < 200 lines of TypeScript, fully understandable

**Trade-offs accepted:**
- No fancy pipeline scheduling or parallel resolution
- Full re-index required if the chunking strategy changes (rare)
- No automatic index invalidation on config change (manual `--force` flag)

---

## Dual Context Layer: ctx base + livectx sources

**Decision:** Use `@gents/agent-ctx` as the base prompt layer everywhere. Add `@livectx/core` sources incrementally — in the CLI for optional live data, fully in the cloud worker.

**Rationale:**
- The base ctx layer handles prompt structure, caching, and SQLite reads — this is always needed
- livectx sources slot into the same `definePrompt` sections array via async resolvers
- The CLI can progressively adopt livectx sources gated on credential availability (e.g., Render API token) — no live data if no credentials, graceful degradation
- The cloud worker uses livectx fully: SWR caching, push invalidation via webhooks, retry
- One prompt architecture, graduated levels of live data

**What uses what:**

| Environment | Context Layer | Live data |
|---|---|---|
| CLI (local, no creds) | `@gents/agent-ctx` | SQLite only — skills, conversation, code index |
| CLI (local, with creds) | `@gents/agent-ctx` + `@livectx/core` | SQLite + optional Render status, GitHub state |
| Cloud worker | `@gents/agent-ctx` + `@livectx/core` | SQLite + full infra/GitHub/fleet/CI data |
| Dashboard | N/A (reads Postgres via API) | No prompt assembly needed |

**Trade-offs accepted:**
- livectx becomes an optional dependency of the CLI (only loaded when API credentials are configured)
- Two context "modes" in the CLI (local-only vs. local+live) — but the difference is just whether livectx sections are in the array
- livectx is a vendored dependency (same as openforge-v2 approach)

---

## Agent Blueprints (Declarative Agent Provisioning)

**Decision:** New agent databases are created from blueprints that pre-load tools, permissions, exclusion patterns, and configuration.

**Rationale:**
- Different task types need different capabilities (PR review agent shouldn't have file_write)
- Permission and cost configuration should be declarative, not imperative
- Webhook-triggered tasks need consistent, reproducible agent configurations
- Blueprints can include seed conversation or instructions for domain-specific agents
- The database IS the configuration — no external config files to keep in sync

**Alternatives considered:**
- Runtime configuration only — fragile, no reproducibility
- Config files alongside the database — split state, harder to transfer
- Plugin system — over-engineered for this use case

---

## Pluggable Storage Backend (not hardcoded S3)

**Decision:** Agent database transfer uses a `StorageProvider` interface with multiple implementations.

**Rationale:**
- Different deployments have different storage needs (AWS, Cloudflare, GCS, local dev)
- S3-compatible APIs are ubiquitous but not universal
- R2 has zero egress fees (significant for frequent agent.db transfers)
- Local filesystem storage is essential for development without cloud dependencies
- The storage layer is simple (upload, download, list, delete) — abstraction cost is minimal

**Implementations:** S3, R2, GCS, Render persistent disk, local filesystem.

**The key insight:** pulling an agent.db from object storage is simpler and more reliable than Postgres-level sync. The database file IS the complete transfer unit. No partial sync, no schema mismatches, no CRDT complexity for phase 2.

---

## File Exclusion: .gitignore + Defaults + Blueprints

**Decision:** Multi-layer exclusion system to prevent indexing irrelevant files.

**Rationale:**
- `node_modules/` alone can contain hundreds of thousands of files — indexing it would take hours and produce useless results
- .gitignore already captures most of what should be excluded — respecting it is baseline
- Hardcoded defaults catch common cases that .gitignore might miss (IDE dirs, binary files, lock files)
- Blueprint-level patterns allow per-task-type customization (e.g., "index only Go files for this task")
- User overrides via CLI flags provide escape hatches

**Priority order:** Hardcoded > Defaults > .gitignore > Blueprint > User overrides. Include patterns can override excludes for specific paths.
