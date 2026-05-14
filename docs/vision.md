# gents — Vision

A software engineering agent where the agent's mind is a SQLite database.

---

## The Idea

Most coding agents are stateless processes that forget everything between sessions, depend on cloud services for search and memory, and lose all context when they crash. gents inverts this.

In gents, an agent IS its database. Conversation history, code understanding, event log, tool results — all stored in a single portable SQLite file. The agent loop is a stateless function that opens the database, reads state, reasons, acts, writes results, and closes. Kill the process at any point. Reopen the database. Continue exactly where you left off.

Locally, the agent works fully offline with sub-millisecond code search powered by sqlite-vector and local embeddings via Nomic Embed. No external services required for the core intelligence loop.

In the cloud, a single Next.js app on Render serves as both dashboard and API. It dispatches Render Workflows that provision sandboxes, clone repos, run the agent loop, and report back. GitHub webhooks trigger autonomous work. Teams watch progress and steer running agents from the web or CLI.

The bridge between local and cloud is the Next.js app's API. Dispatch a task from the CLI or dashboard. Attach to a running task to watch its conversation and send steering messages. The same agent loop code runs everywhere.

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

2. **A cloud task runner with dashboard** that dispatches agents as ephemeral jobs, reacts to GitHub webhooks, provides a web UI for team visibility and steering, and lets multiple people plug into a running agent's conversation.

3. **A composable toolkit** of packages that can be used independently: code search engine, prompt assembly layer, tool execution framework, MCP server.

---

## What gents Is Not

- Not a hosted SaaS. Self-hosted on your own infrastructure (Render).
- Not a chat wrapper. The agent executes real work: edits files, runs tests, creates PRs.
- Not dependent on any single LLM provider. Anthropic is primary, others can be added.
- Not a framework you extend with plugins. It's an opinionated agent with specific built-in capabilities.
