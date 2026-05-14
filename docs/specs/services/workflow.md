# WorkflowService (`services/workflow`)

**Status:** Proposed
**Package:** `@gents/workflow`
**Depends on:** Render Workflows API

---

## Purpose

The WorkflowService dispatches and tracks Render Workflows. It is the bridge between gents task orchestration and the actual compute that runs the agent. When a task is created (from a webhook, the CLI, or the dashboard), the TaskDispatcher builds a `RunnerSpec` and hands it to the WorkflowService, which submits it to Render's Workflow API and tracks execution to completion.

The service is provider-abstracted: the interface is stable, and the Render implementation can be swapped for a local or mock backend in tests and development.

---

## File Layout

```
services/workflow/
  src/
    index.ts                 # barrel exports
    types.ts                 # WorkflowService interface, WorkflowStatus, WorkflowRun
    render-workflow.ts       # RenderWorkflowService implementation
    mock-workflow.ts         # MockWorkflowService for tests/dev
  package.json
  tsconfig.json
```

---

## Interface

```typescript
// services/workflow/src/types.ts

export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface WorkflowRun {
  id: string;
  status: WorkflowStatus;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowService {
  dispatch(spec: RunnerSpec): Promise<{ workflowId: string }>;
  getStatus(workflowId: string): Promise<WorkflowRun>;
  cancel(workflowId: string): Promise<void>;
  list(opts?: { status?: WorkflowStatus; limit?: number }): Promise<WorkflowRun[]>;
}
```

### Method Semantics

| Method | Description | Idempotency |
|---|---|---|
| `dispatch` | Submit a RunnerSpec to the workflow backend. Returns an opaque workflow ID. | Not idempotent — each call creates a new workflow run. Callers must deduplicate upstream. |
| `getStatus` | Retrieve the current status of a workflow run. | Safe / read-only. |
| `cancel` | Request cancellation of a running workflow. No-op if already terminal. | Idempotent — cancelling an already-cancelled or completed run is a no-op. |
| `list` | List workflow runs, optionally filtered by status. Paginated. | Safe / read-only. |

### RunnerSpec (Cross-Service Type)

The `RunnerSpec` is the payload passed to the workflow. It contains everything the runner needs to clone, configure, and execute the agent:

```typescript
interface RunnerSpec {
  taskId: string;
  repo: string;
  ref: string;
  blueprint: string;
  instructions: string;
  callbackUrl: string;
  callbackSecret: string;
  constraints: {
    maxTurns: number;
    maxCostUsd: number;
    timeoutMinutes: number;
  };
  secrets: {
    anthropicKey: string;
    githubToken: string;
  };
}
```

> **Note:** `RunnerSpec` is shared across services. It should live in a shared types package (e.g. `@gents/types`) or be defined in `@gents/tasks` and re-exported.

---

## Render Implementation

```typescript
// services/workflow/src/render-workflow.ts

import type { WorkflowService, WorkflowRun } from "./types";

export class RenderWorkflowService implements WorkflowService {
  constructor(private config: { apiKey: string; serviceId: string }) {}

  async dispatch(spec: RunnerSpec): Promise<{ workflowId: string }> {
    const res = await fetch(
      `https://api.render.com/v1/services/${this.config.serviceId}/workflows`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: spec }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new WorkflowDispatchError(
        `Render API returned ${res.status}: ${body}`,
        res.status
      );
    }

    const data = await res.json();
    return { workflowId: data.id };
  }

  async getStatus(workflowId: string): Promise<WorkflowRun> {
    const res = await fetch(
      `https://api.render.com/v1/workflows/${workflowId}`,
      { headers: { Authorization: `Bearer ${this.config.apiKey}` } }
    );
    if (!res.ok) throw new Error(`Failed to get workflow status: ${res.status}`);
    const data = await res.json();
    return {
      id: data.id,
      status: mapRenderStatus(data.status),
      startedAt: data.startedAt ? new Date(data.startedAt) : undefined,
      completedAt: data.completedAt ? new Date(data.completedAt) : undefined,
      error: data.error,
    };
  }

  async cancel(workflowId: string): Promise<void> {
    const res = await fetch(
      `https://api.render.com/v1/workflows/${workflowId}/cancel`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      }
    );
    if (!res.ok) throw new Error(`Failed to cancel workflow: ${res.status}`);
  }

  async list(opts?: { status?: WorkflowStatus; limit?: number }): Promise<WorkflowRun[]> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit) params.set("limit", String(opts.limit));

    const res = await fetch(
      `https://api.render.com/v1/services/${this.config.serviceId}/workflows?${params}`,
      { headers: { Authorization: `Bearer ${this.config.apiKey}` } }
    );
    if (!res.ok) throw new Error(`Failed to list workflows: ${res.status}`);
    const data = await res.json();
    return data.map(mapWorkflowRun);
  }
}

export class WorkflowDispatchError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "WorkflowDispatchError";
  }
}

function mapRenderStatus(renderStatus: string): WorkflowStatus {
  const mapping: Record<string, WorkflowStatus> = {
    queued: "pending",
    in_progress: "running",
    succeeded: "completed",
    failed: "failed",
    cancelled: "cancelled",
  };
  return mapping[renderStatus] || "pending";
}
```

### Render API Assumptions

The implementation assumes the following Render Workflows API shape:

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/services/:id/workflows` | POST | Create a new workflow run |
| `/v1/workflows/:id` | GET | Get workflow run status |
| `/v1/workflows/:id/cancel` | POST | Cancel a running workflow |
| `/v1/services/:id/workflows` | GET | List workflow runs for a service |

**Response shape (assumed):**

```json
{
  "id": "wf-abc123",
  "status": "in_progress",
  "startedAt": "2025-01-01T00:00:00Z",
  "completedAt": null,
  "error": null
}
```

These must be validated against the actual Render API documentation before implementation begins.

---

## Mock Implementation

```typescript
// services/workflow/src/mock-workflow.ts

export class MockWorkflowService implements WorkflowService {
  private runs = new Map<string, WorkflowRun>();

  async dispatch(spec: RunnerSpec): Promise<{ workflowId: string }> {
    const id = `mock-wf-${Date.now()}`;
    this.runs.set(id, { id, status: "running", startedAt: new Date() });
    return { workflowId: id };
  }

  async getStatus(workflowId: string): Promise<WorkflowRun> {
    const run = this.runs.get(workflowId);
    if (!run) throw new Error(`Unknown workflow: ${workflowId}`);
    return run;
  }

  async cancel(workflowId: string): Promise<void> {
    const run = this.runs.get(workflowId);
    if (run) run.status = "cancelled";
  }

  async list(): Promise<WorkflowRun[]> {
    return Array.from(this.runs.values());
  }

  // --- Test helpers ---

  complete(workflowId: string, result?: Record<string, unknown>): void {
    const run = this.runs.get(workflowId);
    if (run) {
      run.status = "completed";
      run.completedAt = new Date();
    }
  }

  fail(workflowId: string, error: string): void {
    const run = this.runs.get(workflowId);
    if (run) {
      run.status = "failed";
      run.error = error;
      run.completedAt = new Date();
    }
  }

  reset(): void {
    this.runs.clear();
  }

  getRuns(): WorkflowRun[] {
    return Array.from(this.runs.values());
  }
}
```

---

## Implementation Plan

### Phase 1: Types & Mock (Day 1)

1. Scaffold the `services/workflow` package with `package.json`, `tsconfig.json`
2. Define `types.ts` with `WorkflowService`, `WorkflowStatus`, `WorkflowRun`
3. Define the shared `RunnerSpec` type (decide location: `@gents/types` or `@gents/tasks`)
4. Implement `MockWorkflowService` with full test helper API
5. Write unit tests against the mock to validate interface contract

### Phase 2: Render Implementation (Day 2)

1. Verify the Render Workflows API against their documentation — confirm endpoints, request/response shapes, status enums, pagination model, and error format
2. Implement `RenderWorkflowService` with proper error mapping
3. Implement `WorkflowDispatchError` with structured error details
4. Add retry logic for transient 5xx errors (exponential backoff, max 3 attempts)
5. Add request timeout handling (abort controller with 30s default)

### Phase 3: Integration & Hardening (Day 3)

1. Integration test against a real Render service (can use a test service or staging)
2. Add rate-limit awareness — detect 429 responses and back off
3. Add structured logging (accepts logger via constructor)
4. Wire into the `TaskDispatcher` in `@gents/tasks`

---

## Error Handling

| Error | Type | HTTP Status | Recovery |
|---|---|---|---|
| Render API returns 4xx | `WorkflowDispatchError` | 400/422 | Do not retry. Fail the task with the error message. |
| Render API returns 5xx | `WorkflowDispatchError` | 500/502/503 | Retry up to 3 times with exponential backoff. |
| Render API returns 429 | `WorkflowDispatchError` | 429 | Back off using `Retry-After` header, then retry. |
| Network error / timeout | `Error` | — | Retry up to 3 times. |
| Unknown workflow ID | `Error` | 404 | Do not retry. The workflow may have been purged. |

---

## Observability

- **Metrics to track:** dispatch latency, dispatch success/failure rate, workflow duration (start to completion), active workflow count
- **Logging:** log dispatch attempts, failures, status transitions. Use structured JSON logging with `workflowId` and `taskId` as correlation fields.
- **Alerting:** alert on dispatch failure rate > 5% over 5 minutes, or on workflows stuck in "running" for longer than the configured timeout.

---

## Open Questions

### Must-resolve before implementation

1. **Render Workflows API shape**: We need to verify the exact request/response format, pagination model, and status enum values from Render's docs. The interface abstracts this but the implementation must match.

2. **Webhook vs. polling for status**: Can we register a webhook with Render to get notified of workflow completion instead of polling `getStatus`? If webhooks are supported, the architecture shifts from poll-based to event-driven, which affects the entire callback flow.

3. **Rate limits**: What are the Render API rate limits? Do we need a queue or token bucket in front of `dispatch`? If the platform dispatches many tasks at once (e.g. a GitHub push triggers 10 routing rules), we need to avoid hammering the API.

### Should-resolve before production

4. **Retry policy**: Should `dispatch` retry on transient 5xx errors? Current plan is exponential backoff with max 3 attempts, but this needs validation against Render's idempotency guarantees. If Render doesn't deduplicate, a retry could create duplicate workflow runs.

5. **Workflow timeout**: Does Render enforce its own timeout, or do we need to implement a reaper that cancels stale workflows? If Render doesn't auto-cancel, a crashed runner could leave a workflow in "running" forever.

6. **Workflow metadata/output**: Can we attach metadata to a workflow run (e.g. the resulting PR URL, final cost)? Or do we need to store all result data in our own `tasks` table?

### Can-defer to v2

7. **Multi-region dispatch**: If Render supports multiple regions, should we allow routing tasks to specific regions based on the repo's location or the user's preference?

8. **Workflow streaming**: Can we stream workflow logs in real-time from Render, or are logs only available after completion? This affects the live task view in the dashboard.
