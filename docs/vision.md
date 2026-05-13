# gents — Vision

A software engineering agent where the agent's mind is a SQLite database.

---

## The Idea

Most coding agents are stateless processes that forget everything between sessions, depend on cloud services for search and memory, and lose all context when they crash. gents inverts this.

In gents, an agent IS its database. Conversation history, code understanding, event log, tool results — all stored in a single portable SQLite file. The agent loop is a stateless function that opens the database, reads state, reasons, acts, writes results, and closes. Kill the process at any point. Reopen the database. Continue exactly where you left off.

Locally, the agent works fully offline with sub-millisecond code search powered by sqlite-vector and local embeddings via Nomic Embed. No external services required for the core intelligence loop.

In the cloud, the same agent database runs inside Render durable workflows. Long-running tasks get their own cloud environments with persistent disks. The dashboard shows fleet-wide progress. GitHub webhooks trigger autonomous work.

The bridge between local and cloud is the database itself. Hand off a task by uploading the `.agent.db` file. Attach to a cloud task by syncing its database back. Fork a task by copying the file.

---

## Core Principles

**Local-first.** The agent works offline. Cloud is an option, not a requirement.

**Agent as database.** All state lives in SQLite. No hidden in-memory state, no external dependencies for core functionality.

**Composable.** Each package is independently useful. The code search engine works without the agent loop. The context layer works without SQLite. The MCP server works with or without the CLI.

**Portable.** Fork an agent: copy a file. Transfer between machines: move a file. Inspect an agent's reasoning: open the database in any SQLite client.

**Durable by construction.** The database is the checkpoint. No workflow framework needed for local durability. Every write is a recoverable state.

---

## What gents Is

1. **A local-first CLI coding agent** that understands your codebase through hybrid semantic + keyword search, maintains conversation context across sessions, and executes code changes autonomously.

2. **A cloud SWE agent platform** that runs long-lived tasks in durable cloud environments, reacts to GitHub events, provisions infrastructure, manages fleet-wide operations, and provides a web dashboard for oversight.

3. **A composable toolkit** of packages that can be used independently: code search engine, prompt assembly layer, tool execution framework, MCP server.

---

## What gents Is Not

- Not a hosted SaaS. Self-hosted on your own infrastructure (Render).
- Not a chat wrapper. The agent executes real work: edits files, runs tests, creates PRs.
- Not dependent on any single LLM provider. Anthropic is primary, others can be added.
- Not a framework you extend with plugins. It's an opinionated agent with specific built-in capabilities.
