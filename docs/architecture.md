# gents — Architecture

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLOUD LAYER                              │
│                                                                  │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Gateway  │  │ Render       │  │  Web     │  │ Postgres  │  │
│  │ (Hono)   │  │ Workflows    │  │Dashboard │  │ (fleet)   │  │
│  └──────────┘  └──────────────┘  └──────────┘  └───────────┘  │
│                                                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                         sync / upload
                               │
┌──────────────────────────────┼──────────────────────────────────┐
│                        LOCAL LAYER                                │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    gents CLI                              │    │
│  │  chat · search · index · inspect · mcp · handoff         │    │
│  └────────────────────────────┬─────────────────────────────┘    │
│                               │                                   │
│  ┌────────────────────────────┼─────────────────────────────┐    │
│  │                      Agent Loop                           │    │
│  │  assemble context → call LLM → execute tools → repeat    │    │
│  └────────────────────────────┬─────────────────────────────┘    │
│                               │                                   │
│  ┌────────────────────────────┼─────────────────────────────┐    │
│  │                    Agent Database                          │    │
│  │                                                           │    │
│  │  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌──────────────┐  │    │
│  │  │messages │ │code_chunks│ │events  │ │ file_tree    │  │    │
│  │  │         │ │+ FTS5    │ │        │ │              │  │    │
│  │  │         │ │+ vectors │ │        │ │              │  │    │
│  │  └─────────┘ └──────────┘ └────────┘ └──────────────┘  │    │
│  │                                                           │    │
│  │  SQLite + sqlite-vector + sqlite-ai (Nomic Embed GGUF)   │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## The Agent Database

Every agent session produces a `.agent.db` file. This file IS the agent — its conversation, its understanding of the code, its decisions, and its execution history.

### Extensions

| Extension | Role |
|---|---|
| sqlite-vector | Sub-millisecond approximate nearest neighbor search over code embeddings |
| sqlite-ai | On-device embedding generation via Nomic Embed v1.5 GGUF (~150MB, 768 dims) |
| FTS5 | Built-in BM25 full-text search for keyword matching |

### Tables

| Table | Purpose | Syncs to Cloud |
|---|---|---|
| `messages` | Conversation history (user, assistant, tool messages) | Yes |
| `compaction_markers` | Summaries replacing old messages when context grows too long | Yes |
| `events` | Append-only log of everything that happened | Yes |
| `code_chunks` | Chunked code with embeddings for semantic search | No (rebuild locally) |
| `code_fts` | FTS5 virtual table over code_chunks for BM25 | No (rebuild locally) |
| `file_tree` | Filesystem state with content hashes for incremental indexing | No |
| `tool_cache` | Memoized tool outputs | No |
| `config` | Agent configuration (model, provider, preferences) | No |

### Hybrid Code Search

Two search strategies combined via Reciprocal Rank Fusion:

1. **BM25 keyword search** — FTS5 index matches exact identifiers, function names, error messages
2. **Semantic vector search** — sqlite-vector finds conceptually similar code even when terminology differs

Both queries return in under 1ms on repositories with tens of thousands of chunks. No external service. No network call.

### Incremental Indexing

The `file_tree` table stores content hashes for every tracked file. On each session start:

1. Walk filesystem, compute hashes for each file
2. Compare against stored hashes — identify added, changed, removed files
3. Re-chunk and re-embed only changed files via sqlite-ai
4. Rebuild FTS index
5. Update file_tree with new hashes

First index of a large repo: 30-60 seconds (dominated by embedding generation). Subsequent runs: sub-second for typical commits.

### Conversation Compaction

When the conversation grows too long for the context window, the agent can compact earlier turns:

1. Agent calls `compact_conversation` tool
2. The tool summarizes messages up to a specified turn
3. A `compaction_marker` is written with the summary
4. When assembling context, messages before the marker are replaced with the summary

This is agent-initiated (the agent decides when to compact based on context pressure) rather than automatic truncation that loses information silently.

---

## The Agent Loop

A stateless function that operates on a database:

```
turn(db, userMessage):
  1. Write user message to db
  2. Write turn.started event
  3. Check index freshness → incremental re-index if needed
  4. Assemble context (ctx reads from db):
     - Static: system prompt + project overview + relevant code
     - Cache breakpoint (Anthropic prefix caching)
     - Dynamic: search results + conversation history
  5. Run pre-LLM hooks (cost check, credential redaction)
  6. Stream LLM response (Anthropic Claude)
  7. Run post-LLM hooks
  8. If tool calls → execute tools → write results → goto 4
  9. If text → write assistant message → write turn.completed → return
```

The loop has no in-memory state. Kill the process at any point between database writes. Reopen the database, read the last event, determine where to resume.

---

## Context Assembly (ctx)

A simplified prompt engineering layer focused on two things:

1. **Declarative composition** — Named prompt sections with static/dynamic placement
2. **LLM prefix caching** — Cache breakpoint tells Anthropic "everything above this is stable across turns"

The static prefix (system prompt, project structure, code overview) is identical across turns. Anthropic caches it, saving 30-50% on input tokens over a multi-turn session. The dynamic suffix (current search results, recent conversation) changes each turn.

All section resolvers read from the local SQLite database. Resolution is synchronous and microsecond-fast.

---

## MCP Server

A single MCP server exposes the agent database for two audiences:

**Internal (agent as client):** Some agent tools are implemented as MCP operations. The `compact_conversation` tool, `code_search` tool, and `index_status` tool all route through the MCP server. This means the agent interacts with its own database through a well-defined protocol.

**External (other LLM clients):** The same MCP server is exposed over stdio for Cursor, Claude Desktop, or any MCP-compatible client. External consumers can:
- Search code semantically
- Read the agent's conversation
- Trigger indexing
- Inspect agent state

This makes gents composable with other tools in the ecosystem.

---

## Tools

Built-in tool set for software engineering:

| Tool | Description |
|---|---|
| `file_read` | Read file contents (full or line range) |
| `file_write` | Write/create files |
| `file_edit` | Targeted string replacement in files |
| `code_search` | Hybrid BM25 + vector search via agent-db |
| `file_search` | Glob/regex file finding |
| `bash` | Shell command execution with timeout |
| `git_status` | Repository status |
| `git_diff` | Show changes |
| `git_commit` | Stage and commit |
| `compact_conversation` | Summarize and compact old messages |

Tools are registered with Zod schemas for input validation. The hook pipeline gates execution (cost limits, path restrictions, confirmation for destructive operations).

---

## Hooks Pipeline

Middleware that runs at defined lifecycle points:

| Hook | Trigger | Purpose |
|---|---|---|
| Cost guard | Pre-LLM, post-LLM | Enforce per-turn and per-session spend limits |
| Credential redaction | Post-tool | Scrub secrets from tool output before sending to LLM |
| Tool governance | Pre-tool | Allow/deny lists, path restrictions |
| Confirmation gate | Pre-tool (CLI) | Ask user before destructive operations |

Hooks compose via a simple pipeline. Each hook can pass, reject, or transform.

---

## Dependency Flow

```
agent/db         ← depends on nothing (SQLite + extensions only)
agent/ctx        ← depends on agent/db (resolvers read from db)
agent/tools      ← depends on agent/db (code_search, compact_conversation)
agent/hooks      ← depends on nothing (pure middleware)
agent/otel       ← depends on nothing (instrumentation wrappers)
agent/loop       ← depends on agent/db, agent/ctx, agent/tools, agent/hooks, agent/otel
agent/mcp        ← depends on agent/db, agent/tools
apps/cli         ← depends on agent/loop, agent/mcp, agent/db
```

Each package can be used independently. `agent/db` alone is a code search engine. `agent/ctx` alone is a prompt formatter. `agent/mcp` alone is an MCP server for code intelligence.

---

## Cloud Architecture (Phase 2)

### Components

| Component | Tech | Role |
|---|---|---|
| Gateway | Hono on Bun | REST/SSE API, auth, webhook routing, task dispatch |
| Worker | Render Workflows | Durable agent execution with persistent disk |
| Dashboard | Next.js | Fleet view, task detail, live event streaming |
| Postgres | Render managed | Fleet-wide aggregate state (tasks, users, metrics) |

### How It Works

1. **Task creation:** User (CLI, dashboard, or GitHub webhook) creates a task via Gateway API
2. **Dispatch:** Gateway writes task metadata to Postgres, dispatches Render Workflow
3. **Execution:** Worker claims task, creates/downloads `.agent.db` on persistent disk, runs agent-loop
4. **Visibility:** Events from agent-db are forwarded to Postgres; dashboard reads via SSE
5. **Steering:** User sends commands (pause, cancel, redirect) via Gateway → Worker picks them up
6. **Completion:** Agent finishes, results persisted in database, task marked complete in Postgres

### Handoff (Local → Cloud)

```
User: gents handoff
  1. CLI uploads .agent.db to cloud storage
  2. CLI calls Gateway: POST /tasks with db reference
  3. Gateway dispatches Render Workflow
  4. Worker downloads .agent.db to persistent disk
  5. Worker runs agent-loop against the database
  6. Events stream to dashboard via SSE
  7. User can attach: gents attach <task-id> (stream events back to CLI)
```

### Attach (Cloud → Local)

```
User: gents attach <task-id>
  1. CLI connects to Gateway SSE endpoint
  2. Events stream to terminal in real-time
  3. User can send steering commands (type messages, pause, redirect)
  4. On completion: CLI can download the .agent.db for local inspection
```

### Fork

```
User: gents fork <task-id>
  1. Download the .agent.db at its current state
  2. Copy to new local file
  3. Resume with divergent instructions
  4. Two independent agents with shared history up to fork point
```

---

## Services (Phase 2)

| Service | Responsibility |
|---|---|
| auth | API key management, GitHub OAuth, JWT middleware |
| forge | GitHub webhook parsing, routing rules, webhook → task mapping |
| task | Task CRUD, event pagination, workflow dispatch |
| sandbox | Cloud environment provisioning (repo clone, dependency install) |
| deploy | Preview environment management (Render deploy provider) |

---

## Sync Strategy (Phase 2+)

Three levels, implemented in order:

### Level 1: REST Upload/Download (Phase 2)
Simple file transfer. Upload `.agent.db` for handoff. Download for attach/inspect. Works immediately, no infrastructure beyond object storage.

### Level 2: Event Forwarding (Phase 2)
Agent-db emits events → HTTP POST to Gateway → Postgres insert. Dashboard gets real-time visibility without full database sync. One-directional (agent → cloud).

### Level 3: CRDT Sync (Phase 3, if validated)
sqlite-sync CRDT replication between local SQLite and cloud Postgres. Bidirectional, conflict-free. Local edits and cloud steering commands merge automatically. Full offline support with eventual consistency.

---

## Security Model

### Local
- API keys stored in system keychain or `~/.gents/config` (600 permissions)
- Tool governance restricts file access to repo boundaries
- Credential redaction scrubs secrets from LLM context

### Cloud
- GitHub OAuth for user authentication
- JWT tokens for API access
- API key auth for programmatic access
- Per-user and per-project permission policies
- Sandbox isolation for agent execution environments
