# Implementation Plan: `apps/web` (Next.js Dashboard + API)

The Next.js app is the user-facing shell for the gents cloud platform. It provides a real-time dashboard for monitoring agent tasks, API routes consumed by the CLI and webhook integrations, and configuration UI for routing rules, API keys, and blueprints.

---

## Architecture Overview

The web app is intentionally thin. Business logic lives in the services layer (`@gents/workflow`, `@gents/sandbox`, `@gents/auth`, `@gents/github`, `@gents/tasks`). The web app's responsibilities are:

1. **HTTP layer**: parse requests, authenticate, call services, serialize responses
2. **Real-time UI**: SSE-powered live conversation viewer
3. **Configuration UI**: routing rules, API keys, settings
4. **Auth glue**: NextAuth session management, OAuth callbacks

---

## Project Structure

```
apps/web/
  package.json
  next.config.ts
  tailwind.config.ts
  tsconfig.json
  src/
    app/
      layout.tsx                 # Root layout (auth provider, nav, theme)
      page.tsx                   # Dashboard home (redirects to /tasks)
      loading.tsx                # Global loading skeleton
      error.tsx                  # Global error boundary
      not-found.tsx              # 404 page
      tasks/
        page.tsx                 # Task list (filterable, sortable)
        loading.tsx              # Skeleton for task list
        [id]/
          page.tsx               # Task detail (live conversation)
          loading.tsx            # Skeleton for task detail
      rules/
        page.tsx                 # Routing rules management
      settings/
        page.tsx                 # API keys, sandbox config, profile
        keys/
          page.tsx               # Dedicated API key management
      api/
        auth/[...nextauth]/
          route.ts               # NextAuth handler
        health/
          route.ts               # Health check (DB ping, service status)
        webhooks/
          github/
            route.ts             # GitHub webhook ingestion
        tasks/
          route.ts               # GET (list) + POST (create)
          [id]/
            route.ts             # GET (detail)
            events/
              route.ts           # GET SSE stream
            messages/
              route.ts           # POST steering message
            cancel/
              route.ts           # POST cancel
            callback/
              route.ts           # POST from runner (event ingestion)
            logs/
              route.ts           # GET paginated logs
        rules/
          route.ts               # GET + POST routing rules
          [id]/
            route.ts             # PUT + DELETE routing rule
        keys/
          route.ts               # GET + POST API keys
          [id]/
            route.ts             # DELETE API key
    components/
      layout/
        nav.tsx                  # Side navigation
        header.tsx               # Top bar with user menu
        sidebar.tsx              # Collapsible sidebar
      tasks/
        task-list.tsx            # Task table with status badges
        task-list-filters.tsx    # Status, repo, origin filters
        task-detail.tsx          # Live conversation viewer
        task-actions.tsx         # Cancel, retry, steer buttons
      conversation/
        conversation.tsx         # Message stream renderer
        message-bubble.tsx       # Individual message display
        tool-call.tsx            # Collapsible tool execution display
        tool-result.tsx          # Tool output with syntax highlighting
        steering-input.tsx       # Text input for sending messages
        cost-ticker.tsx          # Live cost/turn counter
      rules/
        rule-editor.tsx          # Routing rule form (create/edit)
        rule-list.tsx            # Routing rules table
        event-picker.tsx         # GitHub event type selector
      settings/
        api-key-list.tsx         # API key table with copy/revoke
        api-key-create.tsx       # Create key dialog
        sandbox-config.tsx       # Sandbox provider selection
      shared/
        status-badge.tsx         # Task status indicator (colored dot + label)
        empty-state.tsx          # Empty state illustrations
        confirm-dialog.tsx       # Destructive action confirmation
        code-block.tsx           # Syntax-highlighted code
        relative-time.tsx        # "3 minutes ago" timestamps
    lib/
      db.ts                      # Postgres pool (singleton)
      services.ts                # Instantiate all services
      auth.ts                    # NextAuth config (GitHub provider)
      sse.ts                     # SSE helper for streaming responses
      api-helpers.ts             # Shared request parsing, error responses
      validation.ts              # Zod schemas for API inputs
    hooks/
      use-task-events.ts         # Client-side SSE hook for live conversation
      use-tasks.ts               # SWR hook for task list with polling
      use-routing-rules.ts       # SWR hook for routing rules
      use-api-keys.ts            # SWR hook for API keys
  migrations/
    001_initial.sql              # tasks, task_logs, task_messages, routing_rules
    002_auth.sql                 # users, api_keys, sessions
  public/
    favicon.ico
```

---

## Dependencies

```json
{
  "name": "@gents/web",
  "dependencies": {
    "next": "^15",
    "react": "^19",
    "react-dom": "^19",
    "next-auth": "^5",
    "@auth/pg-adapter": "latest",
    "pg": "^8",
    "tailwindcss": "^4",
    "swr": "^2",
    "zod": "^3",
    "nanoid": "^5",
    "@gents/workflow": "workspace:*",
    "@gents/sandbox": "workspace:*",
    "@gents/auth": "workspace:*",
    "@gents/github": "workspace:*",
    "@gents/tasks": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/react": "^19",
    "@types/pg": "^8"
  }
}
```

---

## Service Initialization

All services are instantiated once in a shared module. No ambient singletons — env vars are read here and passed as explicit config.

```typescript
// apps/web/src/lib/services.ts

import { Pool } from "pg";
import { RenderWorkflowService } from "@gents/workflow";
import { createSandboxService } from "@gents/sandbox";
import { NextAuthService } from "@gents/auth";
import { TaskRepository, TaskDispatcher } from "@gents/tasks";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const taskRepo = new TaskRepository(pool);

export const workflowService = new RenderWorkflowService({
  apiKey: process.env.RENDER_API_KEY!,
  serviceId: process.env.RENDER_WORKFLOW_SERVICE_ID!,
});

export const sandboxService = createSandboxService(
  (process.env.SANDBOX_PROVIDER || "e2b") as SandboxProvider,
  { apiKey: process.env.SANDBOX_API_KEY! }
);

export const authService = new NextAuthService(pool);

export const taskDispatcher = new TaskDispatcher(taskRepo, workflowService, {
  appUrl: process.env.NEXTAUTH_URL || "http://localhost:3000",
  anthropicKey: process.env.ANTHROPIC_API_KEY!,
  githubToken: process.env.GITHUB_TOKEN!,
  callbackSecret: process.env.CALLBACK_SECRET!,
  defaultMaxTurns: parseInt(process.env.DEFAULT_MAX_TURNS || "25"),
  defaultMaxCostUsd: parseFloat(process.env.DEFAULT_MAX_COST_USD || "10"),
  defaultTimeoutMinutes: parseInt(process.env.DEFAULT_TIMEOUT_MINUTES || "120"),
});
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string |
| `NEXTAUTH_URL` | Yes | Canonical app URL (e.g. `https://gents.example.com`) |
| `NEXTAUTH_SECRET` | Yes | NextAuth encryption secret |
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth app client secret |
| `GITHUB_WEBHOOK_SECRET` | Yes | Shared secret for webhook signature verification |
| `RENDER_API_KEY` | Yes | Render API key for workflow dispatch |
| `RENDER_WORKFLOW_SERVICE_ID` | Yes | Render service ID for the workflow runner |
| `SANDBOX_PROVIDER` | No | `e2b` (default), `fly`, or `docker` |
| `SANDBOX_API_KEY` | Yes | API key for the sandbox provider |
| `ANTHROPIC_API_KEY` | Yes | Passed to runners as a secret |
| `GITHUB_TOKEN` | Yes | Passed to runners for repo access |
| `CALLBACK_SECRET` | Yes | Shared secret for runner → app callbacks |
| `DEFAULT_MAX_TURNS` | No | Default max agent turns (default: 25) |
| `DEFAULT_MAX_COST_USD` | No | Default max cost per task (default: 10) |
| `DEFAULT_TIMEOUT_MINUTES` | No | Default task timeout (default: 120) |

---

## API Routes — Detailed Implementations

### Authentication Middleware Pattern

Every API route follows the same auth pattern:

```typescript
// apps/web/src/lib/api-helpers.ts

import { authenticateRequest } from "@gents/auth";
import { authService } from "./services";

export async function withAuth(request: Request): Promise<User> {
  const user = await authenticateRequest(request, authService);
  if (!user) {
    throw new ApiError("Unauthorized", 401);
  }
  return user;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return Response.json(
      { error: "Validation failed", details: error.flatten() },
      { status: 400 }
    );
  }
  console.error("Unhandled error:", error);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}
```

### POST /api/tasks — Create Task

```typescript
// apps/web/src/app/api/tasks/route.ts

import { withAuth, errorResponse } from "@/lib/api-helpers";
import { taskDispatcher, taskRepo } from "@/lib/services";
import { z } from "zod";

const CreateTaskSchema = z.object({
  repo: z.string().url(),
  ref: z.string().default("main"),
  instructions: z.string().min(1).max(10000),
  blueprint: z.string().optional(),
  constraints: z.object({
    maxTurns: z.number().int().min(1).max(100).optional(),
    maxCostUsd: z.number().min(0.01).max(100).optional(),
    timeoutMinutes: z.number().int().min(1).max(480).optional(),
  }).optional(),
});

export async function POST(request: Request) {
  try {
    const user = await withAuth(request);
    const body = await request.json();
    const input = CreateTaskSchema.parse(body);

    const task = await taskDispatcher.dispatch({
      ...input,
      origin: detectOrigin(request),
      createdBy: user.id,
    });

    return Response.json(task, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const user = await withAuth(request);
    const { searchParams } = new URL(request.url);

    const result = await taskRepo.list({
      status: searchParams.get("status") as TaskStatus || undefined,
      repo: searchParams.get("repo") || undefined,
      createdBy: searchParams.get("mine") === "true" ? user.id : undefined,
      limit: parseInt(searchParams.get("limit") || "20"),
      offset: parseInt(searchParams.get("offset") || "0"),
    });

    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

function detectOrigin(request: Request): TaskOrigin {
  const ua = request.headers.get("user-agent") || "";
  if (ua.includes("gents-cli")) return "cli";
  return "dashboard";
}
```

### GET /api/tasks/:id — Task Detail

```typescript
// apps/web/src/app/api/tasks/[id]/route.ts

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await withAuth(request);
    const task = await taskRepo.getById(params.id);
    if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
    return Response.json(task);
  } catch (error) {
    return errorResponse(error);
  }
}
```

### GET /api/tasks/:id/events — SSE Stream

The real-time event stream for the live conversation viewer. Sends existing logs as an initial batch, then streams new events as they arrive.

```typescript
// apps/web/src/app/api/tasks/[id]/events/route.ts

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await withAuth(request);
    const taskId = params.id;
    const encoder = new TextEncoder();
    let lastSeen = new Date(0);

    const stream = new ReadableStream({
      async start(controller) {
        // Send existing logs as initial batch
        const existingLogs = await taskRepo.getLogs(taskId, { limit: 500 });
        for (const log of existingLogs) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(log)}\n\n`)
          );
          lastSeen = log.ts;
        }

        // Send current task state
        const task = await taskRepo.getById(taskId);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "task_state", task })}\n\n`)
        );

        // If task is already done, close the stream
        if (task && ["completed", "failed", "cancelled"].includes(task.status)) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "done", status: task.status })}\n\n`)
          );
          controller.close();
          return;
        }

        // Poll for new logs
        // TODO: Replace with Postgres LISTEN/NOTIFY for lower latency
        const interval = setInterval(async () => {
          try {
            const newLogs = await taskRepo.getLogsSince(taskId, lastSeen);
            for (const log of newLogs) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(log)}\n\n`)
              );
              lastSeen = log.ts;
            }

            const currentTask = await taskRepo.getById(taskId);
            if (currentTask && ["completed", "failed", "cancelled"].includes(currentTask.status)) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "done", status: currentTask.status, result: currentTask.result })}\n\n`)
              );
              clearInterval(interval);
              controller.close();
            }
          } catch (err) {
            console.error("SSE poll error:", err);
          }
        }, 1000);

        // Send keepalive pings every 15 seconds
        const pingInterval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            clearInterval(pingInterval);
          }
        }, 15000);

        request.signal.addEventListener("abort", () => {
          clearInterval(interval);
          clearInterval(pingInterval);
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
```

### POST /api/tasks/:id/callback — Runner Event Ingestion

This endpoint is called by the workflow runner to report progress. It is **not** user-authenticated — instead it uses a shared callback secret.

```typescript
// apps/web/src/app/api/tasks/[id]/callback/route.ts

const CallbackEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("events"),
    events: z.array(z.object({
      type: z.enum(["message", "tool_call", "tool_result", "error", "status"]),
      role: z.enum(["assistant", "system"]).optional(),
      content: z.record(z.unknown()),
    })),
    costDelta: z.number().optional(),
    turnDelta: z.number().optional(),
  }),
  z.object({
    type: z.literal("messages_request"),
  }),
  z.object({
    type: z.literal("completion"),
    status: z.enum(["completed", "failed"]),
    result: z.record(z.unknown()).optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("heartbeat"),
    costUsd: z.number().optional(),
    turnCount: z.number().optional(),
  }),
]);

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const token = request.headers.get("x-callback-token");
  if (token !== process.env.CALLBACK_SECRET) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const taskId = params.id;
  const body = CallbackEventSchema.parse(await request.json());

  switch (body.type) {
    case "events":
      await taskRepo.appendLogs(taskId, body.events);
      if (body.costDelta || body.turnDelta) {
        await taskRepo.updateMetrics(taskId, body.costDelta || 0, body.turnDelta || 0);
      }
      break;

    case "messages_request": {
      const pending = await taskRepo.getPendingMessages(taskId);
      await taskRepo.markMessagesPickedUp(pending.map(m => m.id));
      return Response.json({ messages: pending });
    }

    case "completion":
      await taskRepo.updateStatus(taskId, body.status, {
        completedAt: new Date(),
        result: body.result,
        lastError: body.error,
      });
      break;

    case "heartbeat":
      // Just confirms the task is still alive; optionally sync metrics
      if (body.costUsd !== undefined || body.turnCount !== undefined) {
        await taskRepo.updateMetrics(taskId, 0, 0);
      }
      break;
  }

  return Response.json({ ok: true });
}
```

### POST /api/tasks/:id/messages — Steering

```typescript
// apps/web/src/app/api/tasks/[id]/messages/route.ts

const SteeringMessageSchema = z.object({
  content: z.string().min(1).max(5000),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await withAuth(request);
    const task = await taskRepo.getById(params.id);
    if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
    if (task.status !== "running") {
      return Response.json({ error: "Task is not running" }, { status: 409 });
    }

    const body = SteeringMessageSchema.parse(await request.json());
    const message = await taskRepo.sendMessage(params.id, body.content, user.id);
    return Response.json(message, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
```

### POST /api/tasks/:id/cancel

```typescript
// apps/web/src/app/api/tasks/[id]/cancel/route.ts

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await withAuth(request);
    await taskDispatcher.cancel(params.id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
```

### POST /api/webhooks/github

```typescript
// apps/web/src/app/api/webhooks/github/route.ts

import { verifyWebhookSignature, parseWebhookEvent, findMatchingRules, resolveInstructions } from "@gents/github";
import { taskDispatcher, taskRepo } from "@/lib/services";

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256") || "";

  if (!verifyWebhookSignature(body, signature, process.env.GITHUB_WEBHOOK_SECRET!)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = parseWebhookEvent(request.headers, body);

  // Ignore bot-generated events to prevent infinite loops
  if (event.sender.login.endsWith("[bot]")) {
    return Response.json({ ok: true, skipped: "bot event" });
  }

  const rules = await taskRepo.listRoutingRules({ enabled: true });
  const matchedRules = findMatchingRules(event, rules);

  const dispatched: string[] = [];
  for (const rule of matchedRules) {
    try {
      const task = await taskDispatcher.dispatch({
        repo: event.repository.clone_url,
        ref: event.ref || extractRef(event),
        blueprint: rule.blueprint,
        instructions: resolveInstructions(rule.instructions, event),
        origin: "webhook",
      });
      dispatched.push(task.id);
    } catch (err) {
      console.error(`Failed to dispatch for rule ${rule.id}:`, err);
    }
  }

  return Response.json({
    ok: true,
    event: `${event.event}.${event.action || ""}`,
    rulesMatched: matchedRules.length,
    tasksDispatched: dispatched,
  });
}

function extractRef(event: GitHubWebhookEvent): string {
  const pr = event.payload as { pull_request?: { head?: { ref?: string } } };
  if (pr.pull_request?.head?.ref) return pr.pull_request.head.ref;
  return event.ref || "main";
}
```

### Routing Rules API

```typescript
// apps/web/src/app/api/rules/route.ts

const CreateRuleSchema = z.object({
  event: z.string().min(1),
  filter: z.object({
    branches: z.array(z.string()).optional(),
    labels: z.array(z.string()).optional(),
    paths: z.array(z.string()).optional(),
  }).default({}),
  blueprint: z.string().min(1),
  instructions: z.string().min(1),
  enabled: z.boolean().default(true),
});

export async function GET(request: Request) {
  try {
    await withAuth(request);
    const rules = await taskRepo.listRoutingRules();
    return Response.json(rules);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await withAuth(request);
    const body = CreateRuleSchema.parse(await request.json());
    const rule = await taskRepo.createRoutingRule(body);
    return Response.json(rule, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
```

### API Keys

```typescript
// apps/web/src/app/api/keys/route.ts

export async function GET(request: Request) {
  try {
    const user = await withAuth(request);
    const keys = await authService.listApiKeys(user.id);
    return Response.json(keys);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await withAuth(request);
    const { name } = z.object({ name: z.string().min(1).max(100) }).parse(await request.json());
    const { key, apiKey } = await authService.createApiKey(user.id, name);
    // key is only returned once — client must copy it immediately
    return Response.json({ key, ...apiKey }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
```

### Health Check

```typescript
// apps/web/src/app/api/health/route.ts

export async function GET() {
  const checks: Record<string, "ok" | "error"> = {};

  try {
    await pool.query("SELECT 1");
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }

  const healthy = Object.values(checks).every(v => v === "ok");
  return Response.json(
    { status: healthy ? "healthy" : "degraded", checks },
    { status: healthy ? 200 : 503 }
  );
}
```

---

## Dashboard Components

### Task List Page

The main view. Displays all tasks in a filterable, sortable table.

```typescript
// apps/web/src/app/tasks/page.tsx

import { TaskList } from "@/components/tasks/task-list";
import { TaskListFilters } from "@/components/tasks/task-list-filters";

export default function TasksPage() {
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <NewTaskButton />
      </div>
      <TaskListFilters />
      <TaskList />
    </div>
  );
}
```

**Task list component:**

```typescript
// apps/web/src/components/tasks/task-list.tsx

"use client";

import useSWR from "swr";
import { StatusBadge } from "@/components/shared/status-badge";
import { RelativeTime } from "@/components/shared/relative-time";
import Link from "next/link";

export function TaskList({ filters }: { filters?: TaskFilters }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.repo) params.set("repo", filters.repo);

  const { data, isLoading } = useSWR(
    `/api/tasks?${params}`,
    fetcher,
    { refreshInterval: 5000 }
  );

  if (isLoading) return <TaskListSkeleton />;

  return (
    <table className="w-full">
      <thead>
        <tr className="text-left text-sm text-muted-foreground border-b">
          <th className="py-3 px-4">Status</th>
          <th className="py-3 px-4">Instructions</th>
          <th className="py-3 px-4">Repo</th>
          <th className="py-3 px-4">Origin</th>
          <th className="py-3 px-4">Cost</th>
          <th className="py-3 px-4">Turns</th>
          <th className="py-3 px-4">Created</th>
        </tr>
      </thead>
      <tbody>
        {data?.tasks.map((task: Task) => (
          <tr key={task.id} className="border-b hover:bg-muted/50 transition-colors">
            <td className="py-3 px-4">
              <StatusBadge status={task.status} />
            </td>
            <td className="py-3 px-4">
              <Link href={`/tasks/${task.id}`} className="hover:underline font-medium">
                {task.instructions?.slice(0, 80)}
                {task.instructions && task.instructions.length > 80 ? "…" : ""}
              </Link>
            </td>
            <td className="py-3 px-4 text-sm text-muted-foreground font-mono">
              {extractRepoName(task.repo)}
            </td>
            <td className="py-3 px-4 text-sm capitalize">{task.origin}</td>
            <td className="py-3 px-4 text-sm font-mono">${task.costUsd.toFixed(2)}</td>
            <td className="py-3 px-4 text-sm font-mono">{task.turnCount}</td>
            <td className="py-3 px-4 text-sm">
              <RelativeTime date={task.createdAt} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### Task Detail Page (Live Conversation)

The core feature. Renders the agent's conversation in real-time via SSE.

```typescript
// apps/web/src/app/tasks/[id]/page.tsx

"use client";

import { useTaskEvents } from "@/hooks/use-task-events";
import { Conversation } from "@/components/conversation/conversation";
import { SteeringInput } from "@/components/conversation/steering-input";
import { StatusBadge } from "@/components/shared/status-badge";
import { CostTicker } from "@/components/conversation/cost-ticker";

export default function TaskDetailPage({ params }: { params: { id: string } }) {
  const { events, task, isLive } = useTaskEvents(params.id);

  return (
    <div className="flex flex-col h-full">
      <header className="border-b px-6 py-4 flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold truncate">
            {task?.instructions?.slice(0, 80)}
          </h1>
          <p className="text-sm text-muted-foreground">
            {task?.repo} · {task?.ref}
          </p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {task && <CostTicker costUsd={task.costUsd} turnCount={task.turnCount} />}
          <StatusBadge status={task?.status} />
          {isLive && <CancelButton taskId={params.id} />}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <Conversation events={events} />
      </div>

      {isLive && (
        <div className="border-t px-6 py-4 shrink-0">
          <SteeringInput taskId={params.id} />
        </div>
      )}
    </div>
  );
}
```

### Conversation Renderer

```typescript
// apps/web/src/components/conversation/conversation.tsx

"use client";

import { MessageBubble } from "./message-bubble";
import { ToolCall } from "./tool-call";

export function Conversation({ events }: { events: TaskLog[] }) {
  return (
    <div className="space-y-4">
      {events.map((event, i) => {
        switch (event.type) {
          case "message":
            return (
              <MessageBubble
                key={event.id || i}
                role={event.role || "assistant"}
                content={event.content}
              />
            );
          case "tool_call":
            return (
              <ToolCall
                key={event.id || i}
                name={event.content.name as string}
                input={event.content.input}
                result={findToolResult(events, event)}
              />
            );
          case "error":
            return (
              <div key={event.id || i} className="bg-destructive/10 text-destructive p-4 rounded-lg text-sm font-mono">
                {event.content.message || JSON.stringify(event.content)}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
```

### Tool Call Display

Tool calls are collapsible. Shows the tool name, a summary of the input, and the result once available.

```typescript
// apps/web/src/components/conversation/tool-call.tsx

"use client";

import { useState } from "react";
import { CodeBlock } from "@/components/shared/code-block";

export function ToolCall({ name, input, result }: {
  name: string;
  input: unknown;
  result?: unknown;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-sm hover:bg-muted/50 transition-colors"
      >
        <span className={`transition-transform ${expanded ? "rotate-90" : ""}`}>▶</span>
        <span className="font-mono font-medium">{name}</span>
        {result !== undefined ? (
          <span className="ml-auto text-xs text-green-600">completed</span>
        ) : (
          <span className="ml-auto text-xs text-amber-600 animate-pulse">running…</span>
        )}
      </button>

      {expanded && (
        <div className="border-t px-4 py-3 space-y-2 bg-muted/20">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Input</p>
            <CodeBlock language="json" code={JSON.stringify(input, null, 2)} />
          </div>
          {result !== undefined && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Result</p>
              <CodeBlock language="json" code={JSON.stringify(result, null, 2)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

### Steering Input

```typescript
// apps/web/src/components/conversation/steering-input.tsx

"use client";

import { useState, useRef } from "react";

export function SteeringInput({ taskId }: { taskId: string }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function handleSend() {
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      await fetch(`/api/tasks/${taskId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
      setMessage("");
      inputRef.current?.focus();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex gap-2">
      <textarea
        ref={inputRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
        placeholder="Send a message to steer the agent…"
        className="flex-1 resize-none rounded-lg border px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        rows={1}
      />
      <button
        onClick={handleSend}
        disabled={!message.trim() || sending}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {sending ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
```

### SSE Hook

```typescript
// apps/web/src/hooks/use-task-events.ts

import { useEffect, useState, useCallback } from "react";

export function useTaskEvents(taskId: string) {
  const [events, setEvents] = useState<TaskLog[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [isLive, setIsLive] = useState(true);
  const [connectionState, setConnectionState] = useState<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let retryCount = 0;
    const maxRetries = 5;

    function connect() {
      eventSource = new EventSource(`/api/tasks/${taskId}/events`);
      setConnectionState("connecting");

      eventSource.onopen = () => {
        setConnectionState("open");
        retryCount = 0;
      };

      eventSource.onmessage = (e) => {
        const data = JSON.parse(e.data);

        if (data.type === "task_state") {
          setTask(data.task);
          return;
        }

        if (data.type === "done") {
          setIsLive(false);
          setTask(prev => prev ? { ...prev, status: data.status } : null);
          eventSource?.close();
          setConnectionState("closed");
          return;
        }

        setEvents(prev => [...prev, data]);
      };

      eventSource.onerror = () => {
        eventSource?.close();
        setConnectionState("closed");

        if (retryCount < maxRetries) {
          retryCount++;
          const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
          setTimeout(connect, delay);
        } else {
          setIsLive(false);
        }
      };
    }

    connect();
    return () => {
      eventSource?.close();
    };
  }, [taskId]);

  return { events, task, isLive, connectionState };
}
```

---

## Auth Configuration

### NextAuth Setup

```typescript
// apps/web/src/lib/auth.ts

import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { Pool } from "pg";
import PostgresAdapter from "@auth/pg-adapter";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PostgresAdapter(pool),
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
  pages: {
    signIn: "/auth/signin",
  },
});
```

### Root Layout

```typescript
// apps/web/src/app/layout.tsx

import { auth } from "@/lib/auth";
import { Nav } from "@/components/layout/nav";
import { redirect } from "next/navigation";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session?.user) {
    redirect("/auth/signin");
  }

  return (
    <html lang="en" className="h-full">
      <body className="h-full flex">
        <Nav user={session.user} />
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </body>
    </html>
  );
}
```

---

## SSE Helper

Reusable utility for building SSE responses across different routes.

```typescript
// apps/web/src/lib/sse.ts

export function createSSEStream(
  init: (controller: ReadableStreamDefaultController) => () => void
): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      cleanup = init({
        ...controller,
        enqueue(data: unknown) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        },
        ping() {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        },
      } as any);
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

---

## Validation Schemas

Centralized Zod schemas for all API inputs.

```typescript
// apps/web/src/lib/validation.ts

import { z } from "zod";

export const CreateTaskSchema = z.object({
  repo: z.string().min(1),
  ref: z.string().default("main"),
  instructions: z.string().min(1).max(10000),
  blueprint: z.string().optional(),
  constraints: z.object({
    maxTurns: z.number().int().min(1).max(100).optional(),
    maxCostUsd: z.number().min(0.01).max(100).optional(),
    timeoutMinutes: z.number().int().min(1).max(480).optional(),
  }).optional(),
});

export const SteeringMessageSchema = z.object({
  content: z.string().min(1).max(5000),
});

export const CreateRuleSchema = z.object({
  event: z.string().min(1),
  filter: z.object({
    branches: z.array(z.string()).optional(),
    labels: z.array(z.string()).optional(),
    paths: z.array(z.string()).optional(),
  }).default({}),
  blueprint: z.string().min(1),
  instructions: z.string().min(1).max(10000),
  enabled: z.boolean().default(true),
});

export const UpdateRuleSchema = CreateRuleSchema.partial();

export const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(100),
});
```

---

## Implementation Order

### Phase A: Scaffold & Auth (2–3 days)

1. **Bootstrap Next.js app** — `create-next-app` with TypeScript, Tailwind, App Router
2. **Postgres connection** — pool singleton, health check endpoint
3. **Run migrations** — simple SQL runner or use `node-pg-migrate`
4. **NextAuth setup** — GitHub provider, session callbacks, sign-in page
5. **Auth middleware** — `withAuth` helper, API key verification via `@gents/auth`

### Phase B: API Routes (2–3 days)

6. **Tasks CRUD** — `POST /api/tasks`, `GET /api/tasks`, `GET /api/tasks/:id`
7. **Callback endpoint** — `POST /api/tasks/:id/callback` for runner events
8. **SSE streaming** — `GET /api/tasks/:id/events` with poll-based updates
9. **Steering messages** — `POST /api/tasks/:id/messages`
10. **GitHub webhook** — `POST /api/webhooks/github` with signature verification
11. **Routing rules** — CRUD for routing rules
12. **API keys** — CRUD for API keys

### Phase C: Dashboard UI (2–3 days)

13. **Layout** — sidebar navigation, header, responsive shell
14. **Task list page** — table with status badges, filters, auto-refresh
15. **Task detail page** — live conversation viewer via SSE
16. **Conversation components** — message bubbles, tool calls, error display
17. **Steering input** — send messages to running tasks
18. **Routing rules page** — CRUD form with event picker, filter builder
19. **Settings page** — API key management, sandbox config display

### Phase D: Polish & Deploy (1–2 days)

20. **Loading states** — skeletons for all pages
21. **Error boundaries** — global and per-page error handling
22. **Empty states** — illustrations for "no tasks yet", "no rules", etc.
23. **`render.yaml`** — deploy config for one-command Render deploy
24. **E2E smoke test** — create task via API, verify SSE stream, cancel

---

## Outstanding Questions

### Architecture

- **SSE vs. WebSocket**: SSE is simpler but unidirectional. If we later need bidirectional streaming (e.g. interactive terminal), do we need WebSocket from the start?
- **Postgres LISTEN/NOTIFY for SSE**: polling at 1s is fine for v1 but adds unnecessary load at scale. When do we switch? What's the NOTIFY payload shape?
- **Edge runtime**: can any API routes run on the Edge runtime, or do they all need Node.js for Postgres? SSE routes might benefit from edge for lower latency.
- **Server Actions**: should we use Next.js Server Actions for form mutations (rules, settings) instead of explicit API routes? Tradeoff: simpler code vs. loss of API surface for CLI.

### UI/UX

- **Conversation pagination**: agent conversations can have thousands of events. Do we virtualize the list? Paginate? Load more on scroll?
- **Tool call rendering**: some tools produce large outputs (file reads, diffs). How do we render these? Truncate with "show more"? Syntax highlighting for code?
- **Real-time cost display**: should the cost ticker update in real-time via SSE, or is periodic refresh sufficient?
- **Dark mode**: do we support it from v1? Tailwind makes it straightforward but doubles the design surface.
- **Mobile responsiveness**: is the dashboard mobile-friendly, or is it desktop-only for v1?

### Auth & Security

- **CORS**: the API is consumed by the CLI (different origin). What's the CORS policy?
- **Rate limiting**: do we rate limit API routes? Where does that run — Next.js middleware, a reverse proxy, or the auth layer?
- **Callback security**: the callback endpoint uses a shared secret. Should each task have a unique callback token? What if the secret is compromised?
- **CSP headers**: what Content Security Policy do we set? The SSE endpoint and any external assets need to be allowed.

### Infrastructure

- **Migration tool**: raw SQL files with a shell script, or a proper tool like `node-pg-migrate` / Drizzle Kit? Raw SQL is simpler but lacks rollback.
- **Monorepo build**: how does Turborepo cache builds for `@gents/web`? Does Next.js handle workspace dependencies correctly with `workspace:*`?
- **Deployment**: single Render Web Service, or separate services for the web app and API? Does Render's free tier support SSE connections?
- **Static assets**: do we need a CDN for static assets, or is Render's built-in static serving sufficient?
- **Database pooling**: Next.js serverless functions can exhaust Postgres connections. Do we need PgBouncer or Render's built-in connection pooling?

### Data

- **Log retention**: task logs can grow large. Do we auto-archive or purge after N days? Separate hot/cold storage?
- **Pagination strategy**: cursor-based or offset-based? Cursor-based is better for real-time data but more complex.
- **Search**: do users need full-text search over task instructions or logs? Postgres `tsvector` or an external service?
