# Task Lifecycle (`services/tasks`)

**Status:** Proposed
**Package:** `@gents/tasks`
**Depends on:** PostgreSQL, `@gents/workflow`

---

## Purpose

The tasks service owns the entire lifecycle of a gents task — from creation through dispatch, execution tracking, steering, and completion. It is the central orchestration layer that ties together the other services:

- Receives task requests from webhooks, the CLI, the dashboard, or scheduled triggers
- Persists task state and logs in Postgres
- Assembles `RunnerSpec` payloads and dispatches them via the `WorkflowService`
- Ingests callback events from running agents to update task state
- Manages steering messages (human-in-the-loop mid-task guidance)
- Tracks costs and turn counts for billing and guardrails

---

## File Layout

```
services/tasks/
  src/
    index.ts                 # barrel exports
    types.ts                 # Task, TaskLog, TaskMessage, RoutingRule types
    repository.ts            # Postgres queries (tasks CRUD)
    dispatch.ts              # Create task + dispatch workflow
    events.ts                # Ingest events from runners, update task state
    messages.ts              # Steering message management
    scheduler.ts             # Future: cron-based task scheduling
  package.json
  tsconfig.json
```

---

## Types

### Task

```typescript
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type TaskOrigin = "webhook" | "cli" | "schedule" | "dashboard";

export interface Task {
  id: string;
  status: TaskStatus;
  blueprint?: string;         // which agent blueprint to use
  repo?: string;              // "owner/repo"
  ref?: string;               // git ref (branch, tag, SHA)
  instructions?: string;      // resolved instruction text
  origin: TaskOrigin;         // how the task was created
  workflowId?: string;        // Render workflow ID (set after dispatch)
  sandboxId?: string;         // sandbox ID (set by runner)
  costUsd: number;            // running total of LLM costs
  turnCount: number;          // number of agent turns completed
  lastError?: string;         // most recent error message
  createdBy?: string;         // user ID who created the task
  startedAt?: Date;
  completedAt?: Date;
  result?: Record<string, unknown>;  // structured result (PR URL, summary, etc.)
  createdAt: Date;
}
```

### Task State Machine

```
                   dispatch()
  ┌─────────┐    ───────────►    ┌─────────┐
  │ pending  │                   │ running  │
  └─────────┘                   └────┬─────┘
       │                             │
       │  dispatch fails             │  agent completes
       ▼                             ▼
  ┌─────────┐                   ┌───────────┐
  │ failed   │◄──── error ──────│ completed  │
  └─────────┘                   └───────────┘
       ▲                             ▲
       │                             │
       │  cancel()                   │
       │                        ┌───────────┐
       └────────────────────────│ cancelled  │
                                └───────────┘
```

**Transition rules:**
- `pending → running`: Workflow dispatched successfully
- `pending → failed`: Workflow dispatch failed
- `running → completed`: Agent finished successfully (callback received)
- `running → failed`: Agent encountered an unrecoverable error
- `running → cancelled`: User or system cancelled the task
- Terminal states (`completed`, `failed`, `cancelled`): No further transitions

### CreateTaskInput

```typescript
export interface CreateTaskInput {
  blueprint?: string;
  repo: string;
  ref: string;
  instructions: string;
  origin: TaskOrigin;
  createdBy?: string;
  constraints?: {
    maxTurns?: number;
    maxCostUsd?: number;
    timeoutMinutes?: number;
  };
  metadata?: Record<string, unknown>;
}
```

### TaskLog

```typescript
export interface TaskLog {
  id: number;
  taskId: string;
  type: "message" | "tool_call" | "tool_result" | "error" | "status";
  role?: "assistant" | "system";
  content: Record<string, unknown>;
  ts: Date;
}
```

Logs are the canonical record of everything that happened during a task. They are append-only and never modified.

| Log Type | Description | Example Content |
|---|---|---|
| `message` | An LLM message (assistant response or system prompt) | `{ text: "I'll start by running the tests..." }` |
| `tool_call` | Agent invoked a tool | `{ tool: "exec", args: { command: "npm test" } }` |
| `tool_result` | Tool returned a result | `{ tool: "exec", exitCode: 0, stdout: "..." }` |
| `error` | An error occurred | `{ message: "Sandbox OOM killed", code: "SANDBOX_OOM" }` |
| `status` | Task status changed | `{ from: "pending", to: "running" }` |

### TaskMessage (Steering)

```typescript
export interface TaskMessage {
  id: number;
  taskId: string;
  content: string;           // human-written instruction
  sentBy?: string;           // user ID
  pickedUp: boolean;         // has the runner consumed this message?
  createdAt: Date;
}
```

Steering messages let a human inject guidance into a running task. The runner polls for pending messages and incorporates them into the agent's context.

### RoutingRule

```typescript
export interface RoutingRule {
  id: string;
  event: string;             // "push", "pull_request.opened", etc.
  filter: {
    branches?: string[];     // glob patterns
    labels?: string[];       // exact match
    paths?: string[];        // glob patterns
  };
  blueprint: string;         // agent blueprint to use
  instructions: string;      // template with {{variables}}
  enabled: boolean;
  createdAt: Date;
}
```

---

## Task Repository (Postgres)

The repository handles all database operations. It accepts a `pg.Pool` and uses parameterized queries.

```typescript
export class TaskRepository {
  constructor(private pool: Pool) {}

  // --- Tasks ---
  async create(input: CreateTaskInput): Promise<Task>;
  async getById(id: string): Promise<Task | null>;
  async list(opts: {
    status?: TaskStatus;
    repo?: string;
    origin?: string;
    createdBy?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ tasks: Task[]; total: number }>;
  async updateStatus(id: string, status: TaskStatus, extra?: Partial<Task>): Promise<void>;

  // --- Logs ---
  async appendLogs(taskId: string, logs: Omit<TaskLog, "id" | "ts">[]): Promise<void>;
  async getLogs(taskId: string, opts?: { limit?: number; offset?: number }): Promise<TaskLog[]>;
  async getLogsSince(taskId: string, since: Date): Promise<TaskLog[]>;
  async updateMetrics(taskId: string, costDelta: number, turnDelta: number): Promise<void>;

  // --- Steering Messages ---
  async sendMessage(taskId: string, content: string, sentBy: string): Promise<TaskMessage>;
  async getPendingMessages(taskId: string): Promise<TaskMessage[]>;
  async markMessagesPickedUp(messageIds: number[]): Promise<void>;

  // --- Routing Rules ---
  async listRoutingRules(opts?: { enabled?: boolean }): Promise<RoutingRule[]>;
  async createRoutingRule(input: Omit<RoutingRule, "id" | "createdAt">): Promise<RoutingRule>;
  async updateRoutingRule(id: string, input: Partial<RoutingRule>): Promise<void>;
  async deleteRoutingRule(id: string): Promise<void>;
}
```

### Query Design Notes

- **Pagination**: `list()` returns `{ tasks, total }` for paginated UIs. Uses `LIMIT`/`OFFSET` with a parallel `COUNT(*)` query.
- **Dynamic filtering**: `list()` builds WHERE clauses dynamically from the provided options. Only non-null filters are applied.
- **Batched log inserts**: `appendLogs()` uses a single multi-row INSERT for efficiency. Runners may flush dozens of log entries per callback.
- **Index strategy**: indexes on `tasks(status)`, `tasks(created_by)`, `tasks(repo)`, `task_logs(task_id, ts)`, `task_messages(task_id, picked_up)`.

---

## Task Dispatcher

Orchestrates task creation, `RunnerSpec` assembly, and workflow dispatch.

```typescript
export interface DispatchConfig {
  appUrl: string;
  anthropicKey: string;
  githubToken: string;
  callbackSecret: string;
  defaultMaxTurns: number;
  defaultMaxCostUsd: number;
  defaultTimeoutMinutes: number;
}

export class TaskDispatcher {
  constructor(
    private repo: TaskRepository,
    private workflowService: WorkflowService,
    private config: DispatchConfig,
  ) {}

  async dispatch(input: CreateTaskInput): Promise<Task> {
    // 1. Create task in pending state
    const task = await this.repo.create(input);

    // 2. Build RunnerSpec
    const spec: RunnerSpec = {
      taskId: task.id,
      repo: input.repo,
      ref: input.ref,
      blueprint: input.blueprint || "default",
      instructions: input.instructions,
      callbackUrl: `${this.config.appUrl}/api/tasks/${task.id}/callback`,
      callbackSecret: this.config.callbackSecret,
      constraints: {
        maxTurns: input.constraints?.maxTurns || this.config.defaultMaxTurns,
        maxCostUsd: input.constraints?.maxCostUsd || this.config.defaultMaxCostUsd,
        timeoutMinutes: input.constraints?.timeoutMinutes || this.config.defaultTimeoutMinutes,
      },
      secrets: {
        anthropicKey: this.config.anthropicKey,
        githubToken: this.config.githubToken,
      },
    };

    // 3. Dispatch workflow
    try {
      const { workflowId } = await this.workflowService.dispatch(spec);
      await this.repo.updateStatus(task.id, "running", {
        workflowId,
        startedAt: new Date(),
      });
      return { ...task, status: "running", workflowId };
    } catch (error) {
      await this.repo.updateStatus(task.id, "failed", {
        lastError: error instanceof Error ? error.message : "Dispatch failed",
        completedAt: new Date(),
      });
      throw error;
    }
  }

  async cancel(taskId: string): Promise<void> {
    const task = await this.repo.getById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== "running")
      throw new Error(`Cannot cancel task in status: ${task.status}`);

    if (task.workflowId) {
      await this.workflowService.cancel(task.workflowId);
    }

    await this.repo.updateStatus(taskId, "cancelled", {
      completedAt: new Date(),
    });
  }
}
```

### Dispatch Flow

```
dispatch(input)
  │
  ├─ 1. TaskRepository.create(input) → Task (status: pending)
  │
  ├─ 2. Build RunnerSpec from input + config
  │     ├─ callbackUrl = appUrl + /api/tasks/:id/callback
  │     ├─ constraints = input overrides + defaults
  │     └─ secrets = from DispatchConfig
  │
  ├─ 3. WorkflowService.dispatch(spec) → { workflowId }
  │     ├─ Success → updateStatus(running, { workflowId, startedAt })
  │     └─ Failure → updateStatus(failed, { lastError, completedAt })
  │
  └─ 4. Return updated Task
```

---

## Event Ingestion

The runner sends callback events to `POST /api/tasks/:id/callback` as the agent executes. The events service processes these callbacks:

```typescript
// services/tasks/src/events.ts

export interface TaskCallback {
  type: "log" | "status" | "metrics" | "complete" | "error";
  logs?: Omit<TaskLog, "id" | "ts">[];
  status?: TaskStatus;
  costDelta?: number;
  turnDelta?: number;
  result?: Record<string, unknown>;
  error?: string;
}

export class TaskEventHandler {
  constructor(private repo: TaskRepository) {}

  async handleCallback(taskId: string, callback: TaskCallback): Promise<void> {
    switch (callback.type) {
      case "log":
        if (callback.logs?.length) {
          await this.repo.appendLogs(taskId, callback.logs);
        }
        break;

      case "metrics":
        if (callback.costDelta || callback.turnDelta) {
          await this.repo.updateMetrics(
            taskId,
            callback.costDelta || 0,
            callback.turnDelta || 0
          );
        }
        break;

      case "complete":
        await this.repo.updateStatus(taskId, "completed", {
          completedAt: new Date(),
          result: callback.result,
        });
        break;

      case "error":
        await this.repo.updateStatus(taskId, "failed", {
          lastError: callback.error,
          completedAt: new Date(),
        });
        break;

      case "status":
        if (callback.status) {
          await this.repo.updateStatus(taskId, callback.status);
        }
        break;
    }
  }
}
```

### Callback Security

The callback URL includes the task ID in the path. The runner authenticates callbacks using a shared secret:

```
POST /api/tasks/:id/callback
Authorization: Bearer <CALLBACK_SECRET>
Content-Type: application/json

{ "type": "log", "logs": [...] }
```

The web layer verifies the `CALLBACK_SECRET` before passing the event to `TaskEventHandler`.

---

## Steering Messages

Steering messages provide human-in-the-loop control over running tasks:

### Send Flow (Dashboard/CLI → Runner)

```
User types message in dashboard
  → POST /api/tasks/:id/messages { content: "Focus on the auth module" }
  → TaskRepository.sendMessage(taskId, content, userId)
  → Message stored with picked_up = false
```

### Receive Flow (Runner → Agent)

```
Runner polls for messages between turns
  → GET /api/tasks/:id/messages?pending=true
  → TaskRepository.getPendingMessages(taskId)
  → Runner incorporates message into agent's context
  → POST /api/tasks/:id/messages/ack { ids: [1, 2, 3] }
  → TaskRepository.markMessagesPickedUp(ids)
```

### Design Decisions

- Messages are **fire-and-forget** from the sender's perspective — there's no guarantee when (or if) the runner picks them up
- Messages are incorporated as system messages in the agent's context, not as user messages
- The runner decides when to check for messages (typically between turns)
- Messages are marked as picked up to prevent re-delivery, but the original is preserved for audit

---

## Database Schema

See [database.md](./database.md) for full migration SQL. Task-specific tables:

### `tasks`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | CUID or nanoid |
| `status` | TEXT | One of: pending, running, completed, failed, cancelled |
| `blueprint` | TEXT | Agent blueprint name |
| `repo` | TEXT | "owner/repo" |
| `ref` | TEXT | Git ref |
| `instructions` | TEXT | Resolved instruction text |
| `origin` | TEXT | webhook, cli, schedule, dashboard |
| `workflow_id` | TEXT | Render workflow ID |
| `sandbox_id` | TEXT | Sandbox ID |
| `cost_usd` | NUMERIC | Running cost total |
| `turn_count` | INTEGER | Number of agent turns |
| `last_error` | TEXT | Most recent error |
| `created_by` | TEXT | User ID |
| `started_at` | TIMESTAMPTZ | When the workflow started |
| `completed_at` | TIMESTAMPTZ | When the task reached terminal state |
| `result` | JSONB | Structured result data |
| `metadata` | JSONB | Arbitrary metadata |
| `created_at` | TIMESTAMPTZ | Auto-set |

### `task_logs`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | Auto-increment |
| `task_id` | TEXT FK → tasks | CASCADE delete |
| `type` | TEXT | message, tool_call, tool_result, error, status |
| `role` | TEXT | assistant, system (nullable) |
| `content` | JSONB | Log payload |
| `ts` | TIMESTAMPTZ | Auto-set |

### `task_messages`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | Auto-increment |
| `task_id` | TEXT FK → tasks | CASCADE delete |
| `content` | TEXT | Message text |
| `sent_by` | TEXT | User ID |
| `picked_up` | BOOLEAN | Has the runner consumed this? |
| `created_at` | TIMESTAMPTZ | Auto-set |

### `routing_rules`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | CUID or nanoid |
| `event` | TEXT | Event key (e.g. "push", "pull_request.opened") |
| `filter` | JSONB | `{ branches?, labels?, paths? }` |
| `blueprint` | TEXT | Agent blueprint |
| `instructions` | TEXT | Instruction template with `{{variables}}` |
| `enabled` | BOOLEAN | Whether the rule is active |
| `created_at` | TIMESTAMPTZ | Auto-set |

---

## Implementation Plan

### Phase 1: Types & Repository (Day 1)

1. Scaffold `services/tasks` package
2. Define all types in `types.ts`
3. Implement `TaskRepository` — tasks CRUD, log operations, message operations
4. Write tests against a test Postgres database (use testcontainers or a shared test DB)
5. Implement row mapping helpers (`mapRow`, `mapLogRow`, `mapMessageRow`, `mapRuleRow`)

### Phase 2: Dispatcher (Day 2)

1. Implement `TaskDispatcher` with `dispatch()` and `cancel()`
2. Wire `TaskDispatcher` to `MockWorkflowService` for testing
3. Test the full dispatch flow: create → dispatch → status transitions
4. Test error paths: dispatch failure → task marked as failed
5. Test cancel: running task → cancel → workflow cancelled + task marked cancelled

### Phase 3: Event Ingestion (Day 3)

1. Implement `TaskEventHandler` with `handleCallback()`
2. Build the callback API route in `apps/web`: `POST /api/tasks/:id/callback`
3. Implement callback authentication (verify `CALLBACK_SECRET`)
4. Test: dispatch task → send log callbacks → verify logs stored → send complete → verify state

### Phase 4: Steering Messages (Day 4)

1. Implement message send/receive/ack in the repository
2. Build API routes: `POST /api/tasks/:id/messages`, `GET /api/tasks/:id/messages?pending=true`
3. Build CLI command: `gents task message <taskId> "focus on auth"`
4. Test the full loop: send message → runner polls → message picked up → acknowledged

### Phase 5: Routing Rules (Day 5)

1. Implement routing rules CRUD in the repository
2. Build API routes for managing rules
3. Build dashboard UI for creating/editing routing rules
4. Integrate with the GitHub webhook handler (`findMatchingRules` → `dispatch`)

### Phase 6: Real-Time Updates (Future)

1. Implement Postgres `LISTEN/NOTIFY` on `task_logs` inserts
2. Replace polling-based SSE endpoint with NOTIFY-driven push
3. Add WebSocket support for the dashboard live view

---

## Error Handling

| Error | Cause | Recovery |
|---|---|---|
| Task not found | Invalid task ID | Return 404. |
| Invalid status transition | e.g. trying to cancel a completed task | Return 409 Conflict with explanation. |
| Dispatch failure | WorkflowService.dispatch() threw | Mark task as failed, preserve error message, re-throw. |
| Callback auth failure | Invalid CALLBACK_SECRET | Return 401. Log the attempt. |
| Log insert failure | Database error during appendLogs | Retry once. If still failing, log the error but don't fail the callback (logs are non-critical). |
| Message send to completed task | User sends message to a task that already finished | Return 409. The message cannot be delivered. |
| Concurrent status update | Two callbacks race to update the same task | Use optimistic concurrency — `UPDATE ... WHERE status = $expected_status`. |

---

## Cost Tracking

Cost tracking is per-task with running totals:

```
Runner sends callback:
  { type: "metrics", costDelta: 0.003, turnDelta: 1 }

Repository:
  UPDATE tasks SET cost_usd = cost_usd + 0.003, turn_count = turn_count + 1
  WHERE id = $taskId
```

### Guardrails

The runner is responsible for enforcing cost and turn limits:

- Before each turn, the runner checks `costUsd < maxCostUsd` and `turnCount < maxTurns`
- If a limit is exceeded, the runner sends a `{ type: "error", error: "Cost limit exceeded" }` callback and exits
- The platform enforces timeouts via the workflow timeout (Render-side) and a reaper (platform-side)

### Future: Per-Model Breakdown

For v2, consider a `task_costs` table:

```sql
CREATE TABLE task_costs (
  id SERIAL PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  model TEXT NOT NULL,          -- "claude-sonnet-4-20250514", "gpt-4o", etc.
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd NUMERIC,
  ts TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Observability

- **Metrics:** tasks created/sec (by origin), task duration distribution, task status distribution, cost per task, turns per task, dispatch latency, callback processing latency
- **Logging:** log task creation (id, origin, repo, instructions preview), log status transitions, log dispatch attempts/results, log callback events
- **Alerting:** alert on failed dispatch rate > 10%, alert on tasks stuck in "running" past timeout, alert on per-user cost exceeding threshold

---

## Open Questions

### Must-resolve before implementation

1. **Task ownership & tenancy**: Tasks are currently global with an optional `createdBy`. Do we need org/team-level isolation in the query layer? If yes, we need a `team_id` or `org_id` column and row-level security.

2. **Callback security**: The current design uses a shared `CALLBACK_SECRET` for all tasks. Should each task get a unique callback token to prevent cross-task replay? A per-task token is more secure but requires the token to be passed in the `RunnerSpec` and verified on each callback.

3. **Concurrent dispatch limits**: Should we enforce max concurrent running tasks per user/org to prevent runaway costs? Where is the limit enforced — in the dispatcher (check before creating) or in a rate limiter?

### Should-resolve before production

4. **Cost tracking granularity**: `costUsd` is a running total. Do we need per-turn cost breakdown? Per-model cost tracking? The current design is simple but limits billing analysis.

5. **Log volume**: Agent conversations can produce thousands of log entries. Do we need log compression, batched inserts, or a separate log store (e.g. ClickHouse)? For v1, Postgres is fine, but at scale the `task_logs` table could grow very large.

6. **Postgres LISTEN/NOTIFY**: The SSE endpoint for live task logs currently polls. `LISTEN/NOTIFY` on the `task_logs` table would reduce latency and database load. When do we implement this?

7. **Retry semantics**: If a workflow fails mid-run (infra error, not agent error), can we retry the task? What state needs to be preserved? Does the agent resume from where it left off, or start over?

### Can-defer to v2

8. **Task retention**: How long do we keep completed task data and logs? Do we need an archival or purge policy? Consider: 90-day retention for logs, indefinite for task metadata.

9. **Scheduled tasks**: The `scheduler.ts` placeholder suggests cron support. Scope: cron expressions stored in routing rules? A separate `schedules` table? Integration with the dashboard for schedule management?

10. **Task dependencies**: Can a task depend on another task (e.g. "run tests after deploy")? This would require a DAG scheduler, which is significant scope.

11. **Task cloning/re-run**: Can users re-run a failed task with the same inputs? This is a UX convenience that requires storing the original `CreateTaskInput` or deriving it from the task record.
