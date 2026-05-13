# gents — Cloud Platform (Phase 2)

The cloud platform turns gents from a local coding agent into a fleet of autonomous software engineers that react to events, run long-lived tasks, and report through a dashboard.

---

## Why Cloud

The local agent is excellent for interactive work: you chat, it codes, you iterate. But some work doesn't fit that model:

- **Long-running tasks** — "Migrate all 200 API endpoints to the new auth middleware" takes hours. You don't want to keep your laptop open.
- **Event-driven work** — A GitHub issue is labeled `gents:fix`. The agent should start working without you.
- **Parallel tasks** — Five PRs need review. Five agents run simultaneously.
- **Team visibility** — Your teammate wants to see what the agent is doing on their PR.

The cloud platform handles these. The same agent loop, the same database, the same tools — just running on Render instead of your laptop.

---

## livectx in the Cloud

The local agent uses a simplified context layer (`ctx`) because all data is in a local SQLite database — synchronous reads, no caching needed. The cloud worker has a fundamentally different context problem: it needs live data from external services.

### Why livectx Matters Here

Cloud agents need context that doesn't live in their database:

| Context Source | Nature | livectx Feature Used |
|---|---|---|
| Render service status | Live, changes during task | SWR cache with short staleTime |
| GitHub PR state | Updated by external actors | Push invalidation via webhook |
| CI/CD pipeline results | Async, arrives mid-task | Subscription + cache invalidation |
| Deploy preview URLs | Created during task | Dependency graph (deploy depends on build) |
| Other agent task status | Fleet coordination | Async resolution, periodic refresh |
| Review comments | Arrive during long tasks | Push invalidation via webhook |

livectx's async resolution, SWR caching, dependency graphs, and push invalidation are designed for exactly this: assembling context from multiple remote sources with different freshness requirements.

### Composition: ctx + livectx

The cloud worker composes both layers into a single prompt:

```typescript
import { definePrompt } from "@gents/agent-ctx";
import { source, prompt as livePrompt, cacheBreakpoint } from "@livectx/core";

// Local bindings (fast, from SQLite)
const localSections = [
  { name: "system", placement: "static", resolve: (db) => systemPrompt },
  { name: "project", placement: "static", resolve: (db) => getProjectOverview(db) },
  { name: "conversation", placement: "dynamic", resolve: (db) => getConversation(db) },
];

// Remote bindings (async, cached via livectx)
const prState = source({
  key: ["github", "pr", prNumber],
  resolver: () => github.pulls.get({ pull_number: prNumber }),
  staleTime: "30s",
  placement: "dynamic",
});

const deployStatus = source({
  key: ["render", "deploy", serviceId],
  resolver: () => render.getServiceStatus(serviceId),
  staleTime: "10s",
  placement: "dynamic",
});

const ciResults = source({
  key: ["github", "checks", headSha],
  resolver: () => github.checks.listForRef({ ref: headSha }),
  staleTime: "1m",
  subscribe: true,  // invalidate on webhook push
  placement: "dynamic",
});
```

The static prefix (system prompt, project overview) uses Anthropic cache_control. Dynamic sections mix local SQLite reads and livectx-resolved remote data. livectx handles the complexity of stale data, retries, and push invalidation so the agent loop doesn't have to.

---

## Components

### Gateway (Hono on Bun)

The API server. Handles:
- REST endpoints for task CRUD, event queries, session management
- SSE for live event streaming to dashboard
- GitHub OAuth for user authentication
- GitHub webhook ingestion and routing
- Task dispatch to Render Workflows
- Health checks and monitoring

Port 4100. Stateless (reads from Postgres). Horizontally scalable.

### Worker (Render Workflows)

The execution engine. Each task gets a durable workflow run:
- Persistent disk with the agent's `.agent.db` file
- Timeout: 2 hours default, configurable per task
- Automatic retry on crash (reopen database, continue from last event)
- Isolated execution environment (agent can't affect other tasks)

The worker:
1. Downloads/creates the `.agent.db` on persistent disk
2. Runs the agent loop against it
3. Forwards events to Postgres for dashboard visibility
4. Accepts steering commands (pause, cancel, redirect) via the database
5. On completion: marks task done, persists final database state

### Dashboard (Next.js)

Fleet-wide visibility:
- **Task list** — all active/completed/failed tasks with status
- **Task detail** — live event stream, conversation view, tool execution log
- **Fleet view** — resource usage, cost tracking, agent health
- **Steering** — send messages to running agents, pause/cancel tasks
- **Settings** — user config, API keys, project defaults

### Postgres (Render Managed)

Fleet-wide aggregate state:
- `users` — authentication, preferences
- `tasks` — metadata, status, cost, assignment
- `task_events` — events forwarded from agent databases
- `api_keys` — programmatic access
- `sessions` — auth sessions

Postgres is NOT the agent's primary store. It's the dashboard's read model. The agent writes to its SQLite database; events are forwarded to Postgres asynchronously.

---

## Task Lifecycle

```
Created → Queued → Running → Completed
                          ↘ Failed
                          ↘ Paused → Running (resumed)
                          ↘ Cancelled
```

### Task Creation

Tasks can be created from:
- **CLI** (`gents task create "..."`) — calls Gateway API
- **Dashboard** — web UI form
- **GitHub webhook** — issue/PR events matching routing rules
- **API** — programmatic access via API key

### Task Execution

```
1. Gateway receives task creation request
2. Gateway writes task metadata to Postgres (status: queued)
3. Gateway dispatches Render Workflow with task ID
4. Worker starts:
   a. If task has a database (handoff): download .agent.db
   b. If new task: create fresh .agent.db, run indexing
5. Worker runs agent loop:
   - Each turn: read from db, call LLM, execute tools, write to db
   - After each turn: forward events to Gateway → Postgres
   - Check for steering commands between turns
6. Agent completes (or fails/times out)
7. Worker marks task done, uploads final .agent.db to storage
8. Gateway updates Postgres task status
```

### Steering

Users can interact with running cloud agents:
- **Send message** — inject a user message into the conversation (agent picks it up next turn)
- **Pause** — agent finishes current turn then stops
- **Resume** — paused agent continues
- **Cancel** — agent stops, task marked cancelled
- **Redirect** — send a new instruction that overrides the current task direction

Steering commands are written to the agent's database (or a command queue table). The agent loop checks for commands between turns.

---

## Storage Backend (Pluggable)

Agent databases are transferred between local and cloud via a pluggable `StorageProvider`. This is simpler and more portable than syncing state through Postgres — the database file IS the state transfer mechanism.

```typescript
interface StorageProvider {
  upload(localPath: string, key: string): Promise<string>
  download(key: string, localPath: string): Promise<void>
  list(prefix: string): Promise<StorageEntry[]>
  delete(key: string): Promise<void>
  getSignedUrl?(key: string, expiresIn: number): Promise<string>
}
```

### Implementations

| Provider | Config | Use Case |
|---|---|---|
| `storage-s3` | `{ bucket, region, credentials }` | AWS — widely supported, mature |
| `storage-r2` | `{ bucket, accountId, credentials }` | Cloudflare R2 — S3-compatible, zero egress fees |
| `storage-gcs` | `{ bucket, credentials }` | Google Cloud Storage |
| `storage-render` | `{ serviceId }` | Render persistent disk (direct mount) |
| `storage-local` | `{ basePath }` | Local filesystem — dev, single-machine setups |

The storage provider is configured per deployment. A typical Render setup uses S3 or R2. Development uses `storage-local`. The Gateway config specifies which provider to use, and both CLI and Worker resolve the same provider.

### Key Naming Convention

```
gents/<org>/<project>/<task-id>/agent.db        # Active task database
gents/<org>/<project>/<task-id>/agent.db.final   # Completed task snapshot
```

---

## Handoff Protocol

### Local → Cloud

```
User: gents handoff

1. CLI reads current .agent.db
2. CLI uploads .agent.db via StorageProvider
3. CLI calls: POST /api/tasks
   {
     "type": "handoff",
     "storage_key": "gents/org/project/task-id/agent.db",
     "instructions": "Continue from where I left off"
   }
4. Gateway creates task, dispatches workflow
5. Worker pulls .agent.db from storage to persistent disk
6. Worker runs agent-loop against the database
7. CLI receives task ID, can attach later
```

### Cloud → Local (Attach)

```
User: gents attach <task-id>

1. CLI connects to: GET /api/tasks/<id>/events (SSE)
2. Events stream to terminal in real-time
3. User types messages → POST /api/tasks/<id>/messages
4. Agent picks up messages next turn
5. On exit: CLI can download final .agent.db
```

### Fork

```
User: gents fork [--from <task-id>] [--from <db-path>]

1. CLI obtains source .agent.db (download from cloud or copy local)
2. CLI creates new database file (copy)
3. User provides new instructions
4. Agent runs with full history context but new direction
```

---

## Services

### auth

- GitHub OAuth flow for web login
- JWT token issuance and verification
- API key management (create, rotate, revoke)
- Role-based access (admin, member, viewer)
- Middleware for Gateway routes

### forge

- GitHub webhook signature verification
- Event parsing (issues, PRs, comments, pushes, labels)
- Routing rules engine (label → task mapping, file pattern → task mapping)
- Deduplication (don't create duplicate tasks for the same event)
- Task template resolution (what instructions to give the agent for each event type)

### task

- Task CRUD operations
- Event pagination and filtering
- Status transitions with validation
- Cost aggregation
- Fork relationship tracking

### sandbox (Phase 2+)

- Cloud environment provisioning for agent execution
- Repository cloning with token injection
- Dependency installation
- Isolated filesystem per task
- Resource limits (CPU, memory, disk)

### deploy (Phase 2+, if needed)

- Preview environment management
- Deploy on PR creation, tear down on merge/close
- Integration with Render deploy API

---

## Event Forwarding and Data Modeling

### Three-Tier Read Pattern (from openforge-v2)

Proven pattern carried forward: raw events for audit, denormalized current state for API, time-bucketed rollups for dashboards.

```
Agent DB (SQLite)          Gateway             Postgres
     │                       │                    │
     │  events written       │                    │
     │  during turn          │                    │
     │                       │                    │
     │  POST /api/tasks/     │                    │
     │  <id>/events          │                    │
     │──────────────────────►│                    │
     │                       │  INSERT INTO       │
     │                       │  task_events       │
     │                       │  (raw events)      │
     │                       │───────────────────►│
     │                       │                    │
     │                       │  UPDATE tasks      │
     │                       │  (denormalized)    │
     │                       │───────────────────►│
     │                       │                    │
     │                       │  UPSERT            │
     │                       │  task_metrics_     │
     │                       │  hourly            │
     │                       │───────────────────►│
     │                       │                    │
     │                       │  SSE broadcast     │
     │                       │───────────────────►│ Dashboard
     │                       │                    │
```

### Postgres Schema (Fleet View)

```sql
-- Tier 1: Raw events (append-only, per-task)
CREATE TABLE task_events (
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  version SMALLINT NOT NULL DEFAULT 1,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_task_events_task_ts ON task_events(task_id, ts);
CREATE INDEX idx_task_events_task_type ON task_events(task_id, type, ts);

-- Tier 2: Denormalized current state (one row per task)
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  description TEXT,
  repo_url TEXT,
  model TEXT,
  origin TEXT,                          -- 'cli', 'dashboard', 'webhook', 'api'
  blueprint TEXT,                       -- which AgentBlueprint was used
  storage_key TEXT,                     -- location of .agent.db in storage
  total_input_tokens BIGINT DEFAULT 0,
  total_output_tokens BIGINT DEFAULT 0,
  total_cost_usd NUMERIC DEFAULT 0,
  turn_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_by TEXT,
  parent_task_id TEXT,                  -- for forks
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Tier 3: Time-series rollups (hourly buckets)
CREATE TABLE task_metrics_hourly (
  task_id TEXT NOT NULL,
  hour TIMESTAMPTZ NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, hour)
);
```

### Event Processing in Gateway

On receiving forwarded events, the Gateway executes all three writes in a single transaction:

1. **INSERT** raw event into `task_events`
2. **UPDATE** `tasks` row with projection (status transitions, cost increments, error tracking)
3. **UPSERT** `task_metrics_hourly` with bucketed counters

Only three event types feed the hourly rollup (same as openforge-v2):
- `agent.cost.incurred` → tokens, cost
- `agent.tool.succeeded` → tool_calls
- `message.sent` → messages

### Replayable Projections

The `tasks` denormalized row can be reconstructed by replaying `task_events`. This is used for:
- Fork accounting (reset semantic state, preserve numeric totals)
- Data integrity verification
- Migration and schema evolution

The worker forwards events in batches after each turn. If the network is unavailable, events queue locally in the agent-db and forward on recovery.

---

## Infrastructure (Render)

```yaml
# render.yaml
services:
  - type: web
    name: gents-gateway
    runtime: node
    buildCommand: pnpm install && pnpm build
    startCommand: bun apps/gateway/src/index.ts
    healthCheckPath: /api/health
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: gents-db
          property: connectionString
      - key: GITHUB_CLIENT_ID
        sync: false
      - key: GITHUB_CLIENT_SECRET
        sync: false
      - key: JWT_SECRET
        generateValue: true

  - type: web
    name: gents-web
    runtime: node
    buildCommand: pnpm install && pnpm --filter @gents/web build
    startCommand: pnpm --filter @gents/web start
    envVars:
      - key: NEXT_PUBLIC_API_URL
        fromService:
          name: gents-gateway
          type: web
          property: url

databases:
  - name: gents-db
    plan: standard
    postgresMajorVersion: 16
```

The worker runs as a separate Render Workflow (configured outside the Blueprint, triggered via Render API from the Gateway).

---

## Cost Model

### Per-Agent Costs

- LLM tokens (primary cost) — tracked per-turn in agent-db, aggregated to Postgres
- Embedding generation (indexing) — local Nomic Embed, no API cost
- Compute (Render Workflow) — per-minute while running
- Storage (persistent disk + object storage) — per-GB

### Controls

- Per-task cost limits (set at creation)
- Per-user daily/monthly budgets
- Per-organization fleet limits
- Cost guard hook pauses agent before exceeding limit
- Dashboard shows real-time spend across fleet
