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

## Simplified Context Layer (one layer everywhere)

**Decision:** Build a minimal prompt assembly system (`@gents/agent-ctx`) and use it everywhere — local CLI and cloud runners alike.

**Rationale:**
- The prompt layer is purpose-built for gents: declarative sections, static/dynamic placement, cache breakpoint — ~200 lines
- SQLite-backed sections return in microseconds — no caching, async resolution, or SWR needed
- Cloud runners use the same ctx layer as local. They don't need "ambient awareness" of infrastructure — they have tools for that.
- Remote data (Render service status, GitHub PR state) is accessed via tools, not prompt context. The agent decides when to fetch.
- One context system to understand, test, and maintain

**What the layer provides:**
- Declarative prompt sections
- Static/dynamic placement
- Cache breakpoint for Anthropic prefix caching
- Clean separation between data resolution and output formatting
- Async resolver support (for any future needs)

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

## Tools for Remote Data (not ambient context)

**Decision:** Remote data (Render API, GitHub API) is accessed via agent tools, not injected into prompt context.

**Rationale:**
- The agent decides when to fetch remote data (on-demand, not every turn)
- No second data plane needed (no SWR cache, no push invalidation, no subscriptions)
- Fits the "agent = stateless function over DB" model — tools are the established data access pattern
- Simpler to implement: one tool definition vs. a caching layer with freshness management
- Works identically in local CLI and cloud runners

**What uses what:**

| Environment | Context Layer | Remote Data |
|---|---|---|
| CLI (local) | `@gents/agent-ctx` | Via tools (render_list_services, etc.) when API key configured |
| Cloud runner | `@gents/agent-ctx` | Via same tools, always available (keys in runner env) |
| Dashboard | N/A (reads Postgres) | Direct API calls from Next.js server components |

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

## Workflow = Brain, Sandbox = Hands (split execution)

**Decision:** The agent loop (LLM reasoning, agent-db, ctx) runs inside the Render Workflow. The sandbox is a dumb remote execution environment accessed over HTTP for file operations and shell commands.

**Rationale:**
- Render Workflows provide durable orchestration — survives transient failures, tracks lifecycle
- The sandbox doesn't need agent code, LLM keys, or SQLite extensions — just git, runtimes, and an HTTP API
- Separation of concerns: Workflow = thinking (cheap), Sandbox = doing (isolated, ephemeral)
- Sandbox provider is pluggable (E2B, Fly Machines, Modal, Docker) via SandboxService abstraction
- LLM keys stay in the workflow, never exposed to the sandbox environment
- code_search runs locally in the workflow (fast SQLite queries), only file/exec tools go remote

**What runs where:**
- **In workflow:** agent-db, agent-loop, ctx assembly, LLM calls, code_search, event reporting
- **In sandbox (over HTTP):** bash execution, file_read, file_write, file_edit, git operations, dependency installs

**Service abstractions:**
- `WorkflowService` — dispatches and tracks Render Workflows
- `SandboxService` — provisions/destroys isolated execution environments
- `AuthService` — user auth (NextAuth) and API key management

**Trade-offs accepted:**
- HTTP latency on every tool call to sandbox (acceptable: 10-50ms per call vs. 10-60s per LLM turn)
- Can't "resume" a failed task from the exact point of failure (workflow re-launches with same spec)
- Indexing requires reading files over HTTP from sandbox (one-time cost at task start)
- Agent db is not the transfer unit between local and cloud (local dispatch sends a spec, not a file)

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

---

## Agent Identity via sqlite-sync site_id

**Decision:** Every agent database gets a unique identity from sqlite-sync's `cloudsync_siteid()` rather than a separately generated UUID.

**Rationale:**
- sqlite-sync assigns a 16-byte `site_id` to each database when the extension is first loaded — auto-generated, persistent, unique per DB
- No schema changes needed — `cloudsync_siteid()` is a SQL function, not a table column
- Survives forks correctly — a forked database gets a new site_id (the extension handles this)
- The extension is loaded with the same non-fatal pattern as sqlite-vector/sqlite-ai — if it's unavailable, gents works fine without identity tracking
- Useful for optional db preservation: when a runner uploads its agent.db for debugging, the site_id provides a unique key

**How it works:**
- `@sqliteai/sqlite-sync` is an optional dependency of `@gents/agent-db`
- On database creation, `cloudsync_siteid()` is called and the hex-encoded result is stored on the `AgentDB.siteId` field
- Locally, human-friendly filenames (`default.agent.db`, `refactor.agent.db`) remain — the site_id is the canonical identity for machine use

**Trade-offs accepted:**
- Adds a native extension dependency (same pattern as sqlite-vector, non-fatal if missing)
- site_id is a hex blob string, not a human-readable UUID (but consistent with how sqlite-sync uses it internally)

---

## Next.js as Unified Cloud Service (not microservices)

**Decision:** The entire cloud platform is a single Next.js app — dashboard, API, webhook handler, and auth in one deploy.

**Rationale:**
- Small teams won't operate 5 microservices (Gateway, Worker, Dashboard, auth, forge, task, sandbox, deploy)
- Next.js provides everything needed: React UI (dashboard), API routes (gateway), SSR (auth), and Server-Sent Events (live streaming)
- One deploy to Render, one service to monitor, one codebase to understand
- Next.js on Render runs as a persistent Node process, so SSE and long-lived connections work natively
- NextAuth handles GitHub OAuth with minimal config — no custom auth service needed
- API routes replace the separate Hono gateway — same functionality, fewer moving parts

**Alternatives considered:**
- Separate Hono Gateway + Next.js Dashboard + Worker service — more flexible but 3x operational complexity
- Express/Fastify API + SPA frontend — loses SSR benefits, requires separate deploy
- Serverless functions (Vercel) — cold starts break SSE, connection limits

**Trade-offs accepted:**
- Monolithic deploy means scaling the dashboard also scales the API (fine for small teams)
- Next.js adds framework overhead compared to a bare Hono server (acceptable for the unified benefit)
- If a team outgrows the single-service model, they can split later (but most never will)
