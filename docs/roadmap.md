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

Turn the local agent into a team tool with cloud execution, webhook triggers, and a shared dashboard.

### Milestones

**M7: Runner Package + Service Abstractions (3-5 days)**
- `@gents/runner` package — headless agent loop execution
- RunnerSpec interface (task ID, repo, ref, instructions, constraints, callback URL)
- SandboxService interface + E2B implementation (primary provider)
- WorkflowService interface + Render Workflows implementation
- AuthService interface + NextAuth implementation
- Event callback: POST events to Next.js app after each turn
- Message polling: check for steering messages between turns
- Constraints enforcement: max turns, max cost, timeout
- Optional .agent.db preservation on completion

**M8: Next.js App — API Layer (3-5 days)**
- Next.js project setup on Render
- API routes: task CRUD, SSE event streaming, message posting
- GitHub webhook handler with signature verification
- Routing rules engine (match webhook events to blueprints)
- Render Workflows integration (dispatch via WorkflowService)
- SandboxService wiring (provision/destroy sandboxes)
- NextAuth with GitHub OAuth provider (via AuthService)
- API key auth for CLI access
- Postgres schema and migrations (tasks, task_logs, task_messages, routing_rules)

**M9: Next.js App — Dashboard (3-4 days)**
- Task list page (filter by status, repo, blueprint)
- Task detail page with live conversation (SSE-driven)
- Steering UI (send messages to running agents, cancel tasks)
- Routing rules configuration page
- Settings page (API keys, default blueprints, cost limits)

**M10: CLI Cloud Commands (2-3 days)**
- `gents dispatch` — create task via API, receive task ID
- `gents attach` — SSE stream + interactive steering from terminal
- `gents tasks` — list/view cloud tasks
- Config: `api_url`, `api_key` for connecting to the Next.js app

**M11: Integration + Deploy (2-3 days)**
- End-to-end test: webhook → task creation → workflow dispatch → sandbox provision → agent execution → PR opened
- Docker sandbox provider for local development/testing
- render.yaml for one-command deploy
- Documentation for sandbox provider setup (E2B API key, etc.)

### Deliverable

A self-hosted app on Render that runs coding agents in the cloud. Deploy with `render deploy`. Connect GitHub. Configure routing rules. Agents run on PRs, pushes, and issues. Team watches and steers from dashboard or CLI.

**Total Phase 2: ~3-4 weeks**

---

## Phase 3: Advanced (Future)

**Long-term memory** — Agent accumulates knowledge across sessions. Facts extracted from conversations and code analysis persist in a memory table with vector search. New sessions start with relevant context from past work.

**Multi-agent coordination** — Multiple agents working on related tasks. A dispatch agent can break work into sub-tasks and launch multiple runners. Parent/child task hierarchies. Shared context via the Next.js app.

**Sandbox hardening** — Network controls, filesystem isolation, resource limits for runners. Docker-in-Docker for user-defined build environments.

**Runner templates and marketplace** — Pre-built runner configurations for common workflows (security audit, dependency updates, test generation, documentation). Shareable across teams.

**Scheduled tasks** — Cron-style recurring task dispatch. Daily security scans, weekly dependency checks, periodic code quality reviews.

**Local model support** — Optional local LLM via llama.cpp/Ollama for fully offline operation. Smaller models for tool selection, larger for reasoning.

**Custom tool packages** — User-defined tools installable as npm packages. Extend agent capabilities per-team.

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
| Sandbox cold start (provision + clone + install) | Task latency | Shallow clones, pre-warmed sandboxes (provider-dependent). |
| Render Workflow dispatch latency | Time to first turn | Accept 10-30s startup. Sandbox provisioning dominates. |
| Sandbox provider reliability | Task success rate | SandboxService abstraction allows provider swap. Start with E2B. |

---

## Non-Goals (Things We Will Not Build)

- Plugin/extension system for arbitrary user code in the agent
- GUI desktop application
- Mobile app
- Multi-tenant SaaS (this is self-hosted)
- Integration with every possible LLM provider (Anthropic primary, add others as needed)
- Replacing existing IDEs or editors (complement them via MCP)
