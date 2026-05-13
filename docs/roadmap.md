# gents — Roadmap

---

## Phase 1: Local-First CLI Agent

The foundation. A fully functional local coding agent with excellent code intelligence.

### Milestones

**M0: Spike (1-2 days)**
- Verify Bun SQLite loads sqlite-vector + sqlite-ai extensions
- Load Nomic Embed GGUF, generate embeddings, store, query
- End-to-end: chunk a file → embed → insert → vector search → return results
- Confirm performance: embedding throughput, search latency

**M1: agent-db (3-5 days)**
- Schema definition and migrations
- Extension loading (sqlite-vector, sqlite-ai)
- Nomic Embed model loading and embedding generation
- Chunking engine (language-aware recursive splitting)
- Incremental indexer (file tree diffing, selective re-index)
- Hybrid search (BM25 + vector + reciprocal rank fusion)
- Conversation storage and retrieval
- Compaction marker system
- Event log

**M2: agent-ctx + agent-tools (2-3 days)**
- Prompt section system with static/dynamic placement
- Cache breakpoint and Anthropic formatting
- Tool registry with Zod validation
- Built-in tools: file_read, file_write, file_edit, bash, code_search, file_search, git_status, git_diff, git_commit, compact_conversation

**M3: agent-hooks + agent-loop (3-4 days)**
- Hook pipeline (pre-LLM, post-LLM, pre-tool, post-tool)
- Cost guard implementation
- Credential redaction
- Confirmation gate (CLI interactive)
- Agent loop: turn-based execution with streaming
- LLM call to Anthropic with tool use
- Tool execution with error handling
- Durability: resume from last event on crash

**M4: agent-mcp (1-2 days)**
- MCP server with code_search, compact_conversation, index tools
- stdio transport for Cursor/Claude Desktop integration
- Resource exposure (conversation, events, config)

**M5: CLI app (2-3 days)**
- Interactive REPL with streaming output
- Commands: chat, search, index, inspect, mcp, config
- First-run experience (config setup, model download, initial index)
- Session management (.gents/ directory)
- Tool output formatting

**M6: Polish (2-3 days)**
- Error handling and recovery
- Edge cases (large files, binary files, empty repos)
- Performance optimization (batch embedding, connection pooling)
- Documentation and README
- Basic test suite

**Total Phase 1: ~3-4 weeks**

### Deliverable

A `gents` CLI that you install, point at a repo, and start having an intelligent coding conversation with. Works fully offline after initial setup. Sub-millisecond code search. Persistent sessions. Forkable. MCP-compatible.

---

## Phase 2: Cloud Platform

Turn the local agent into a fleet of cloud-deployed autonomous engineers.

### Milestones

**M7: sync package**
- Database upload/download to object storage
- Event forwarding (agent-db events → HTTP POST → Gateway)
- Handoff protocol (CLI → Cloud)
- Attach protocol (Cloud → CLI streaming)

**M8: worker package**
- Render Workflow integration
- Persistent disk management for agent databases
- Task execution: download db → run loop → forward events
- Steering: accept commands between turns
- Durability: crash recovery via database state

**M9: Gateway**
- Hono API server
- Task CRUD endpoints
- SSE event streaming
- GitHub OAuth
- JWT middleware
- Health checks

**M10: Services**
- auth: API keys, OAuth flow, JWT issuance
- forge: GitHub webhook parsing, routing rules, task creation
- task: Task lifecycle management, event pagination

**M11: Web Dashboard**
- Next.js app
- Task list/detail views
- Live event streaming
- Steering UI (send messages, pause, cancel)
- Cost/metrics views

**M12: CLI Cloud Commands**
- `gents handoff` — upload and dispatch to cloud
- `gents attach` — connect to running cloud task
- `gents task create/list/cancel` — manage cloud tasks

### Deliverable

A self-hosted platform on Render that runs coding agents in the cloud. GitHub events trigger autonomous work. Dashboard provides fleet visibility. Local CLI seamlessly hands off to and connects with cloud agents.

---

## Phase 3: Advanced (Future)

**sqlite-sync CRDT replication** — Bidirectional sync between local SQLite and cloud Postgres. Full offline support with eventual consistency. Eliminates the upload/download pattern in favor of continuous sync.

**Long-term memory** — Agent accumulates knowledge across sessions. Facts extracted from conversations and code analysis persist in a memory table with vector search. New sessions start with relevant context from past work.

**Multi-agent coordination** — Multiple agents working on related tasks. Shared knowledge via synced memory. Parent/child task hierarchies. Delegation patterns.

**Sandbox isolation** — Docker-based execution environments for cloud agents. Network controls, filesystem isolation, resource limits.

**Custom tool packages** — User-defined tools installable as npm packages. Tool marketplace or registry.

**Local model support** — Optional local LLM via llama.cpp/Ollama for fully offline operation. Smaller models for tool selection, larger for reasoning.

---

## Technical Risks

| Risk | Impact | Mitigation |
|---|---|---|
| sqlite-vector/sqlite-ai extension loading in Bun | Blocks everything | Spike first (M0). Fallback: better-sqlite3. |
| Nomic Embed quality for code search | Core UX | Test on real repos during M1. Fallback: cloud embedding API. |
| Embedding throughput for large repos | First-run experience | Background indexing, progress UI. Target: 200 chunks/sec. |
| Context window management | Agent quality | Compaction system + careful section budgeting in ctx. |
| Anthropic API reliability | Agent availability | Retry with exponential backoff. Future: multi-provider. |
| Database size for large repos | Disk usage | Quantized vectors (Float16/Int8), exclude patterns, index only source. |

---

## Non-Goals (Things We Will Not Build)

- Plugin/extension system for arbitrary user code in the agent
- GUI desktop application
- Mobile app
- Multi-tenant SaaS (this is self-hosted)
- Integration with every possible LLM provider (Anthropic primary, add others as needed)
- Replacing existing IDEs or editors (complement them via MCP)
