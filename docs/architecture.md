# gents — Architecture

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLOUD LAYER                              │
│                                                                  │
│  ┌───────────────────────────────┐  ┌────────────────────────┐  │
│  │  Next.js App (Render)         │  │  Render Workflows       │  │
│  │                               │  │  (the brain)            │  │
│  │  Dashboard + API + Auth       │  │  agent loop + agent-db  │  │
│  │  Webhooks + SSE               │  │  LLM calls + ctx        │  │
│  │  Postgres (tasks, logs)       │  │  ↕ HTTP to sandbox      │  │
│  └───────────────────────────────┘  └────────────────────────┘  │
│                                                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                      dispatch / attach
                               │
┌──────────────────────────────┼──────────────────────────────────┐
│                        LOCAL LAYER                                │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    gents CLI                              │    │
│  │  chat · search · index · inspect · mcp · dispatch        │    │
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

| Table | Purpose |
|---|---|
| `messages` | Conversation history (user, assistant, tool messages) |
| `compaction_markers` | Summaries replacing old messages when context grows too long |
| `events` | Append-only log of everything that happened |
| `code_chunks` | Chunked code with embeddings for semantic search |
| `code_fts` | FTS5 virtual table over code_chunks for BM25 |
| `file_tree` | Filesystem state with content hashes for incremental indexing |
| `tool_cache` | Memoized tool outputs |
| `config` | Agent configuration (model, provider, preferences) |

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

All section resolvers read from the local SQLite database. Resolution is synchronous and microsecond-fast. Cloud runners use the same ctx layer — no separate context system needed.

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
runner           ← depends on agent/loop, agent/db (runs in workflow, calls sandbox over HTTP)
apps/cli         ← depends on agent/loop, agent/mcp, agent/db
apps/web         ← depends on WorkflowService, SandboxService, AuthService (Next.js + Postgres)
```

Each package can be used independently. `agent/db` alone is a code search engine. `agent/ctx` alone is a prompt formatter. `agent/mcp` alone is an MCP server for code intelligence.

---

## Cloud Architecture (Phase 2)

### Design Principle

The same agent loop code runs locally and in cloud workflows. The difference: locally, tools execute on the same machine. In the cloud, the workflow runs the agent loop and tools execute against a remote sandbox over HTTP. The sandbox is stateless and dumb — all intelligence is in the workflow.

### Components

| Component | Tech | Role |
|---|---|---|
| Next.js App | Next.js on Render | Dashboard + API routes + webhook handler + auth (one deploy) |
| WorkflowService | Render Workflows | Durable task orchestration (survives transient failures) |
| SandboxService | E2B / Fly / Modal (pluggable) | Isolated execution environments (file ops + shell, accessed over HTTP) |
| AuthService | NextAuth + API keys | User auth and programmatic access |
| Postgres | Render Managed | Tasks, logs, messages, routing rules |

### How It Works

```
1. Task creation:
   - GitHub webhook arrives at Next.js app
   - OR user dispatches from CLI / dashboard
2. Next.js app writes task to Postgres, dispatches Render Workflow
3. Workflow starts:
   a. Provisions sandbox via SandboxService (E2B, Fly, etc.)
   b. Clones repo + installs deps in sandbox (commands over HTTP)
   c. Creates fresh .agent.db locally in the workflow
   d. Runs agent loop IN THE WORKFLOW:
      - LLM reasoning + ctx assembly happen in workflow
      - Tool calls (bash, file ops) execute in sandbox over HTTP
      - code_search runs locally against agent-db
4. During execution:
   - Workflow POSTs events to Next.js app after each turn
   - Next.js app stores in Postgres, broadcasts via SSE
   - Users watch from CLI or dashboard
   - Users can send steering messages (picked up between turns)
5. On completion:
   - Workflow reports final result (PR URL, comments posted, etc.)
   - Optionally uploads .agent.db for later inspection
   - Sandbox is destroyed via SandboxService
```

### Conversation Tracking and Steering

The conversation lives in the Next.js app's Postgres — not inside the runner's private database. This enables:

- **Multiple viewers** — any team member can watch a running task from CLI or web
- **Steering** — send messages that the runner picks up between turns
- **Real-time streaming** — SSE from Next.js app to all connected clients

```
Runner (doing work)              Next.js App              User (CLI or Web)
       │                              │                         │
       │  POST /api/tasks/:id/events  │                         │
       │─────────────────────────────►│                         │
       │                              │  SSE broadcast          │
       │                              │────────────────────────►│
       │                              │                         │
       │                              │  POST message           │
       │                              │◄────────────────────────│
       │                              │                         │
       │  GET /api/tasks/:id/messages │                         │
       │◄─────────────────────────────│                         │
       │                              │                         │
       │  [injects as next user turn] │                         │
```

### Dispatch (Local → Cloud)

```
User: gents dispatch "Fix the auth tests"
  1. CLI calls: POST /api/tasks { repo, ref, instructions, blueprint }
  2. Next.js app creates task in Postgres, dispatches Render Workflow
  3. Workflow provisions sandbox, runs agent loop (tools execute in sandbox over HTTP)
  4. CLI receives task ID
  5. User can attach: gents attach <task-id>
```

### Attach (Watch + Steer)

```
User: gents attach <task-id>
  1. CLI connects to: GET /api/tasks/<id>/events (SSE)
  2. Events stream to terminal in real-time
  3. User types messages → POST /api/tasks/<id>/messages
  4. Runner picks up messages next turn
```

### Postgres Schema

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  blueprint TEXT,
  repo TEXT,
  ref TEXT,
  instructions TEXT,
  origin TEXT,              -- 'webhook', 'cli', 'schedule', 'dashboard'
  workflow_id TEXT,          -- reference to WorkflowService run
  sandbox_id TEXT,          -- reference to SandboxService instance
  cost_usd NUMERIC DEFAULT 0,
  turn_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_by TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,             -- PR URL, comments posted, errors
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE task_logs (
  id SERIAL PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  type TEXT,                -- 'message', 'tool_call', 'tool_result', 'error', 'status'
  role TEXT,                -- 'assistant', 'system'
  content JSONB,
  ts TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE task_messages (
  id SERIAL PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  content TEXT NOT NULL,
  sent_by TEXT,
  picked_up BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE routing_rules (
  id TEXT PRIMARY KEY,
  event TEXT,               -- 'pull_request.opened', 'push', 'issue.labeled'
  filter JSONB,             -- branch patterns, label matches, path patterns
  blueprint TEXT,
  instructions TEXT,
  enabled BOOLEAN DEFAULT true
);
```

### Infrastructure

```yaml
# render.yaml
services:
  - type: web
    name: gents
    runtime: node
    buildCommand: pnpm build
    startCommand: pnpm start
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: gents-db
          property: connectionString
      - key: GITHUB_APP_PRIVATE_KEY
        sync: false
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: SANDBOX_PROVIDER
        value: e2b
      - key: SANDBOX_API_KEY
        sync: false

databases:
  - name: gents-db
    plan: starter
```

One web service. One database. Workflows orchestrate execution via Render Workflows. Sandboxes are provisioned externally via the SandboxService abstraction.

---

## Security Model

### Local
- API keys stored in system keychain or `~/.gents/config` (600 permissions)
- Tool governance restricts file access to repo boundaries
- Credential redaction scrubs secrets from LLM context

### Cloud
- GitHub OAuth via NextAuth for user authentication
- API key auth for CLI and programmatic access
- Runner sandboxes are isolated (ephemeral containers, destroyed on completion)
- Secrets injected into runners via environment variables, never stored in Postgres
