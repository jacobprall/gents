# gents — CLI

The primary interface for phase 1. A local-first interactive coding agent.

---

## Commands

### gents chat

Start or resume an interactive agent session.

```
gents chat [options]

Options:
  --repo <path>        Repository path (default: current directory)
  --session <id>       Resume specific session (default: last active)
  --new                Force new session
  --model <model>      Override model (default: from config)
  --no-index           Skip index freshness check
  --no-confirm         Skip confirmation prompts for destructive tools
```

**Behavior:**
1. Opens (or creates) `.gents/default.agent.db` in the repo
2. If index is stale or missing, prompts for initial indexing
3. Enters REPL: user types messages, agent responds with streaming output
4. Tool executions shown inline (file edits, bash output, search results)
5. Session persists in the database — exit and resume anytime

**Special commands in chat:**
- `/exit` or Ctrl+D — exit cleanly
- `/compact` — trigger conversation compaction
- `/search <query>` — direct code search (bypasses LLM)
- `/index` — re-index the codebase
- `/cost` — show session cost so far
- `/fork` — fork current session into a new database
- `/status` — show index and session statistics

### gents search

Direct code search without the agent loop. Useful as a standalone tool.

```
gents search <query> [options]

Options:
  --repo <path>        Repository path (default: current directory)
  --limit <n>          Max results (default: 20)
  --lang <language>    Filter by language
  --path <glob>        Filter by path pattern
  --mode <mode>        Search mode: hybrid (default), bm25, vector
  --json               Output as JSON
```

**Example:**
```
$ gents search "authentication middleware"

  src/middleware/auth.ts:12-45 (score: 0.92)
  ─────────────────────────────
  export function authMiddleware(req: Request, res: Response, next: Next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    ...

  src/routes/login.ts:28-67 (score: 0.87)
  ─────────────────────────────
  async function handleLogin(req: Request, res: Response) {
    const { email, password } = req.body;
    const user = await findUserByEmail(email);
    ...
```

### gents index

Build or update the code search index.

```
gents index [options]

Options:
  --repo <path>        Repository path (default: current directory)
  --force              Full re-index (ignore file hashes)
  --include <glob>     Additional include patterns
  --exclude <glob>     Additional exclude patterns
  --stats              Show detailed indexing statistics
```

**Output:**
```
$ gents index

  Indexing /Users/me/project...
  Model: nomic-embed-text-v1.5 (loaded)
  Files scanned: 247
  Changed since last index: 12
  Chunks created: 38
  Embeddings generated: 38
  Time: 2.3s

  Index stats:
    Total files: 247
    Total chunks: 4,891
    Languages: TypeScript (189), Python (34), Markdown (24)
    Database size: 47MB
```

### gents inspect

Browse an agent database. Opens a read-only view of the database contents.

```
gents inspect [db-path] [options]

Options:
  --table <name>       Show specific table contents
  --events             Show recent events
  --conversation       Show conversation history
  --stats              Show database statistics
  --sql <query>        Run arbitrary read-only SQL
```

**Example:**
```
$ gents inspect --stats

  Database: .gents/default.agent.db (47MB)
  Created: 2026-05-13 14:30:00
  Last activity: 2026-05-13 16:45:12

  Tables:
    messages:           142 rows (28 turns)
    events:             387 rows
    code_chunks:      4,891 rows
    file_tree:          247 rows
    tool_cache:          23 rows
    compaction_markers:   1 row

  Session cost: $2.34
  Models used: claude-sonnet-4-20250514
```

### gents mcp

Start the MCP server for integration with Cursor, Claude Desktop, or other MCP clients.

```
gents mcp [options]

Options:
  --repo <path>        Repository path (default: current directory)
  --transport <type>   Transport: stdio (default), http
  --port <port>        Port for HTTP transport (default: 3100)
```

**Cursor integration:**
```json
// .cursor/mcp.json
{
  "mcpServers": {
    "gents": {
      "command": "gents",
      "args": ["mcp", "--repo", "."]
    }
  }
}
```

### gents config

Manage global configuration.

```
gents config [options]

Options:
  --set <key> <value>  Set a config value
  --get <key>          Get a config value
  --list               Show all config
  --reset              Reset to defaults
```

**Config keys:**
- `anthropic_api_key` — Anthropic API key
- `model` — Default model (e.g. `claude-sonnet-4-20250514`)
- `models_dir` — Path to GGUF models directory
- `max_cost_per_session` — Default session cost limit (USD)
- `confirm_destructive` — Require confirmation for writes/bash (true/false)
- `auto_index` — Auto-index on session start (true/false)
- `chunk_size` — Chunk size for indexing (default: 1000)
- `chunk_overlap` — Chunk overlap (default: 150)

### gents dispatch (Phase 2)

Create a cloud task. The Next.js app launches a runner to execute it.

```
gents dispatch <instructions> [options]

Options:
  --repo <url>           Repository URL (default: current repo's remote)
  --ref <branch|sha>     Branch or commit (default: current branch)
  --blueprint <name>     Agent blueprint to use (default: "default")
  --max-turns <n>        Maximum agent turns (default: 25)
  --max-cost <usd>       Cost limit in USD (default: 10.00)
  --timeout <minutes>    Timeout in minutes (default: 120)
  --attach               Immediately attach after dispatch
```

**Example:**
```
$ gents dispatch "Fix the failing auth tests and open a PR" --attach

  Task created: a3f2b1c
  Runner starting...

  Agent: I'll look at the failing tests.
    ├ bash: npm test -- auth.test.ts
    ...
```

### gents attach (Phase 2)

Connect to a running cloud task. Stream events and send steering messages.

```
gents attach <task-id> [options]

Options:
  --no-interactive     Watch only (don't allow sending messages)
```

**Behavior:**
1. Connects to SSE endpoint: `GET /api/tasks/<id>/events`
2. Streams conversation and tool calls to terminal in real-time
3. User can type messages (sent via POST /api/tasks/<id>/messages)
4. Agent picks up messages on its next turn
5. Ctrl+D or `/exit` detaches without cancelling the task

### gents tasks (Phase 2)

List and manage cloud tasks.

```
gents tasks [options]

Options:
  --status <status>    Filter by status (pending, running, completed, failed)
  --repo <url>         Filter by repository
  --limit <n>          Max results (default: 20)
  --json               Output as JSON
```

**Example:**
```
$ gents tasks --status running

  ID       Status    Blueprint        Repo                  Age
  a3f2b1c  running   default          org/api-server        12m
  b7d4e2a  running   security-review  org/web-app           3m
```

### gents fork

Fork a local agent session.

```
gents fork [options]

Options:
  --from <path|id>     Source database or session (default: current)
  --name <name>        Name for the fork
```

---

## First-Run Experience

```
$ cd ~/projects/my-app
$ gents chat

  gents v0.1.0

  No configuration found. Let's set up.
  Anthropic API key: sk-ant-••••••••••••

  No code index found for /Users/me/projects/my-app.
  Downloading Nomic Embed model (150MB)... done.
  Building initial index...
    Scanning files: 312 files found
    Chunking: 6,234 chunks created
    Generating embeddings: ████████████████████ 100% (42s)
    Building search index: done

  Ready. Type your message or /help for commands.

  You: Fix the failing test in auth.test.ts

  gents: I'll look at the failing test and fix it.

  [code_search] "auth.test.ts failing test"
  [file_read] src/tests/auth.test.ts
  [bash] npm test -- auth.test.ts 2>&1 | tail -20
  ...
```

---

## Session Management

Sessions are stored as `.agent.db` files in the repo's `.gents/` directory:

```
my-app/
  .gents/
    default.agent.db          # Default session (gents chat)
    sessions/
      fix-auth-bug.agent.db   # Named session (gents chat --session fix-auth-bug)
      refactor-api.agent.db
```

**Lifecycle:**
- `gents chat` — opens/creates `default.agent.db`, resumes if exists
- `gents chat --new` — archives current default, creates fresh
- `gents chat --session <name>` — opens/creates named session
- `gents fork` — copies current session to a new file
- Sessions persist indefinitely until explicitly deleted

**The `.gents/` directory should be gitignored** — agent databases contain conversation history and tool outputs that are user-specific and potentially sensitive.

---

## Output Format

### Streaming

Agent responses stream token-by-token. Tool calls are shown with:
- Tool name and input summary on invocation
- Collapsible output on completion
- Error highlighting on failure

### Tool Display

```
  ┌ code_search("authentication flow")
  │ 5 results found
  │   src/middleware/auth.ts:12-45
  │   src/routes/login.ts:28-67
  │   src/services/auth-service.ts:1-34
  │   ...
  └ done (3ms)

  ┌ file_edit src/middleware/auth.ts
  │ - const token = req.headers.authorization?.split(' ')[1];
  │ + const token = extractBearerToken(req.headers.authorization);
  └ done

  ┌ bash: npm test -- auth.test.ts
  │ PASS src/tests/auth.test.ts
  │   ✓ authenticates valid token (12ms)
  │   ✓ rejects expired token (8ms)
  │   ✓ handles missing header (5ms)
  └ exit 0 (1.2s)
```

---

## Environment Variables

| Variable | Purpose | Required |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (overrides config) | Yes (or in config) |
| `GENTS_MODEL` | Override default model | No |
| `GENTS_MODELS_DIR` | Directory for GGUF models | No |
| `GENTS_CONFIG_DIR` | Override config directory (~/.gents) | No |
| `GENTS_NO_COLOR` | Disable color output | No |
| `GENTS_LOG_LEVEL` | Logging level (debug, info, warn, error) | No |
| `GENTS_API_URL` | URL of the gents Next.js app (for dispatch/attach) | No |
| `GENTS_API_KEY` | API key for cloud access | No |
