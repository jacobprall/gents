# Implementation Plan: `apps/web` + `services/`

A thorough implementation plan for the Next.js app (`apps/web`) and the services layer (`services/`) that power the gents cloud platform.

---

## Overview

```
gents/
  apps/
    web/                    ← Next.js app (dashboard + API)
  services/
    workflow/               ← WorkflowService (Render Workflows)
    sandbox/                ← SandboxService (E2B, Fly, Docker)
    auth/                   ← AuthService (NextAuth + API keys)
    github/                 ← GitHub webhook parsing + API client
    tasks/                  ← Task lifecycle (CRUD, dispatch, events)
```

The Next.js app is the user-facing shell. The services layer contains the business logic and provider abstractions. Services are framework-agnostic TypeScript — they can be used by the Next.js app, by tests, or by the Render Workflow runner.

---

## Part 1: Services Layer (`services/`)

### `services/workflow` — WorkflowService

Dispatches and tracks Render Workflows.

```
services/workflow/
  src/
    index.ts                 # exports
    types.ts                 # WorkflowService interface, WorkflowStatus, etc.
    render-workflow.ts       # RenderWorkflowService implementation
    mock-workflow.ts         # MockWorkflowService for tests/dev
```

**Interface:**

```typescript
// services/workflow/src/types.ts

export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface WorkflowRun {
  id: string;
  status: WorkflowStatus;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface WorkflowService {
  dispatch(spec: RunnerSpec): Promise<{ workflowId: string }>;
  getStatus(workflowId: string): Promise<WorkflowRun>;
  cancel(workflowId: string): Promise<void>;
  list(opts?: { status?: WorkflowStatus; limit?: number }): Promise<WorkflowRun[]>;
}
```

**Render implementation:**

```typescript
// services/workflow/src/render-workflow.ts

import type { WorkflowService, WorkflowRun } from "./types";

export class RenderWorkflowService implements WorkflowService {
  constructor(private config: { apiKey: string; serviceId: string }) {}

  async dispatch(spec: RunnerSpec): Promise<{ workflowId: string }> {
    // POST to Render Workflows API
    // Pass RunnerSpec as workflow input
    const res = await fetch(`https://api.render.com/v1/services/${this.config.serviceId}/workflows`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: spec }),
    });
    const data = await res.json();
    return { workflowId: data.id };
  }

  async getStatus(workflowId: string): Promise<WorkflowRun> {
    // GET workflow status from Render API
  }

  async cancel(workflowId: string): Promise<void> {
    // DELETE or POST cancel to Render API
  }
}
```

---

### `services/sandbox` — SandboxService

Provisions and manages isolated execution environments.

```
services/sandbox/
  src/
    index.ts                 # exports + factory
    types.ts                 # SandboxService, Sandbox, SandboxConfig interfaces
    providers/
      e2b.ts                 # E2BSandboxService
      fly.ts                 # FlySandboxService
      docker.ts              # DockerSandboxService (local dev)
    factory.ts               # createSandboxService(provider, config)
```

**Interface:**

```typescript
// services/sandbox/src/types.ts

export interface SandboxConfig {
  image?: string;
  timeout: number;          // minutes
  resources?: { cpu?: string; memory?: string };
  env?: Record<string, string>;
}

export interface Sandbox {
  id: string;
  status: "creating" | "ready" | "running" | "stopped";
  url: string;

  exec(command: string, opts?: ExecOpts): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string, opts?: { recursive?: boolean }): Promise<DirEntry[]>;
  uploadFiles(files: FileUpload[]): Promise<void>;
  downloadFiles(paths: string[]): Promise<FileDownload[]>;
}

export interface ExecOpts {
  cwd?: string;
  timeout?: number;         // seconds
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface SandboxService {
  create(config: SandboxConfig): Promise<Sandbox>;
  destroy(sandboxId: string): Promise<void>;
  get(sandboxId: string): Promise<Sandbox | null>;
}
```

**Factory:**

```typescript
// services/sandbox/src/factory.ts

export type SandboxProvider = "e2b" | "fly" | "modal" | "docker";

export function createSandboxService(
  provider: SandboxProvider,
  config: Record<string, string>
): SandboxService {
  switch (provider) {
    case "e2b": return new E2BSandboxService(config);
    case "fly": return new FlySandboxService(config);
    case "docker": return new DockerSandboxService(config);
    default: throw new Error(`Unknown sandbox provider: ${provider}`);
  }
}
```

**E2B implementation (primary):**

```typescript
// services/sandbox/src/providers/e2b.ts

import { Sandbox as E2BSandbox } from "@e2b/code-interpreter"; // or @e2b/sdk

export class E2BSandboxService implements SandboxService {
  constructor(private config: { apiKey: string }) {}

  async create(config: SandboxConfig): Promise<Sandbox> {
    const sbx = await E2BSandbox.create({
      apiKey: this.config.apiKey,
      timeout: config.timeout * 60 * 1000,
      metadata: config.env,
    });
    return new E2BSandboxAdapter(sbx);
  }

  async destroy(sandboxId: string): Promise<void> {
    await E2BSandbox.kill(sandboxId, { apiKey: this.config.apiKey });
  }
}

class E2BSandboxAdapter implements Sandbox {
  constructor(private sbx: E2BSandbox) {}

  get id() { return this.sbx.sandboxId; }
  get status() { return "ready" as const; }
  get url() { return `https://${this.sbx.getHost(80)}`; }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    const result = await this.sbx.commands.run(command, {
      cwd: opts?.cwd,
      timeout: opts?.timeout ? opts.timeout * 1000 : undefined,
      envs: opts?.env,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async readFile(path: string): Promise<string> {
    return await this.sbx.files.read(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sbx.files.write(path, content);
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const entries = await this.sbx.files.list(path);
    return entries.map(e => ({ name: e.name, path: e.path, type: e.type, size: e.size }));
  }
}
```

---

### `services/auth` — AuthService

Authentication and API key management.

```
services/auth/
  src/
    index.ts
    types.ts                 # AuthService interface, User, ApiKey types
    nextauth-service.ts      # NextAuth-backed implementation
    api-key.ts               # API key generation, hashing, verification
    middleware.ts            # Auth middleware for API routes
```

**Interface:**

```typescript
// services/auth/src/types.ts

export interface User {
  id: string;
  githubId: string;
  name: string;
  email: string;
  avatarUrl?: string;
}

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  prefix: string;          // first 8 chars, for display
  createdAt: Date;
  lastUsedAt?: Date;
}

export interface AuthService {
  // Session-based (NextAuth)
  getSessionUser(request: Request): Promise<User | null>;

  // API key-based (CLI, programmatic)
  verifyApiKey(key: string): Promise<User | null>;
  createApiKey(userId: string, name: string): Promise<{ key: string; apiKey: ApiKey }>;
  revokeApiKey(keyId: string): Promise<void>;
  listApiKeys(userId: string): Promise<ApiKey[]>;
}
```

**API key implementation:**

```typescript
// services/auth/src/api-key.ts

import { randomBytes, createHash } from "crypto";

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const raw = randomBytes(32).toString("base64url");
  const key = `gnt_${raw}`;
  const hash = createHash("sha256").update(key).digest("hex");
  const prefix = key.slice(0, 12);
  return { key, hash, prefix };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
```

**Middleware:**

```typescript
// services/auth/src/middleware.ts

export async function authenticateRequest(
  request: Request,
  authService: AuthService
): Promise<User | null> {
  // Check for API key in Authorization header
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer gnt_")) {
    return authService.verifyApiKey(authHeader.slice(7));
  }

  // Fall back to session-based auth
  return authService.getSessionUser(request);
}
```

---

### `services/github` — GitHub Integration

Webhook parsing, verification, and API client.

```
services/github/
  src/
    index.ts
    types.ts                 # GitHubEvent, WebhookPayload types
    webhook-parser.ts        # Parse + verify webhook signatures
    routing.ts               # Match events against routing rules
    client.ts                # GitHub API client (Octokit wrapper)
    templates.ts             # Instruction template resolution
```

**Webhook parsing:**

```typescript
// services/github/src/webhook-parser.ts

import { createHmac } from "crypto";

export interface GitHubWebhookEvent {
  event: string;             // 'push', 'pull_request', 'issues', etc.
  action?: string;           // 'opened', 'closed', 'labeled', etc.
  delivery: string;          // unique delivery ID
  payload: Record<string, unknown>;
  repository: { clone_url: string; full_name: string };
  ref?: string;
  sender: { login: string };
}

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function parseWebhookEvent(
  headers: Headers,
  body: string
): GitHubWebhookEvent {
  const event = headers.get("x-github-event")!;
  const delivery = headers.get("x-github-delivery")!;
  const payload = JSON.parse(body);
  return {
    event,
    action: payload.action,
    delivery,
    payload,
    repository: payload.repository,
    ref: payload.ref,
    sender: payload.sender,
  };
}
```

**Routing:**

```typescript
// services/github/src/routing.ts

import type { RoutingRule } from "../tasks/types";
import type { GitHubWebhookEvent } from "./types";

export function matchesRule(event: GitHubWebhookEvent, rule: RoutingRule): boolean {
  // Match event type (e.g. "pull_request.opened")
  const eventKey = event.action ? `${event.event}.${event.action}` : event.event;
  if (rule.event !== eventKey && rule.event !== event.event) return false;

  // Match filters
  if (rule.filter.branches?.length) {
    const branch = extractBranch(event);
    if (!rule.filter.branches.some(b => matchGlob(branch, b))) return false;
  }

  if (rule.filter.labels?.length) {
    const labels = extractLabels(event);
    if (!rule.filter.labels.some(l => labels.includes(l))) return false;
  }

  if (rule.filter.paths?.length) {
    const changedFiles = extractChangedFiles(event);
    if (!rule.filter.paths.some(p => changedFiles.some(f => matchGlob(f, p)))) return false;
  }

  return true;
}

export function resolveInstructions(template: string, event: GitHubWebhookEvent): string {
  return template
    .replace(/\{\{repo\}\}/g, event.repository.full_name)
    .replace(/\{\{ref\}\}/g, event.ref || "")
    .replace(/\{\{sender\}\}/g, event.sender.login)
    .replace(/\{\{event\}\}/g, event.event)
    .replace(/\{\{action\}\}/g, event.action || "");
}
```

---

### `services/tasks` — Task Lifecycle

CRUD operations, event ingestion, and dispatch.

```
services/tasks/
  src/
    index.ts
    types.ts                 # Task, TaskLog, TaskMessage, RoutingRule types
    repository.ts            # Postgres queries (tasks CRUD)
    dispatch.ts              # Create task + dispatch workflow
    events.ts                # Ingest events from runners, update task state
    messages.ts              # Steering message management
```

**Types:**

```typescript
// services/tasks/src/types.ts

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type TaskOrigin = "webhook" | "cli" | "schedule" | "dashboard";

export interface Task {
  id: string;
  status: TaskStatus;
  blueprint?: string;
  repo?: string;
  ref?: string;
  instructions?: string;
  origin: TaskOrigin;
  workflowId?: string;
  sandboxId?: string;
  costUsd: number;
  turnCount: number;
  lastError?: string;
  createdBy?: string;
  startedAt?: Date;
  completedAt?: Date;
  result?: Record<string, unknown>;
  createdAt: Date;
}

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
}

export interface TaskLog {
  id: number;
  taskId: string;
  type: "message" | "tool_call" | "tool_result" | "error" | "status";
  role?: "assistant" | "system";
  content: Record<string, unknown>;
  ts: Date;
}

export interface TaskMessage {
  id: number;
  taskId: string;
  content: string;
  sentBy?: string;
  pickedUp: boolean;
  createdAt: Date;
}

export interface RoutingRule {
  id: string;
  event: string;
  filter: {
    branches?: string[];
    labels?: string[];
    paths?: string[];
  };
  blueprint: string;
  instructions: string;
  enabled: boolean;
  createdAt: Date;
}
```

**Repository (Postgres queries):**

```typescript
// services/tasks/src/repository.ts

import type { Pool } from "pg";
import type { Task, CreateTaskInput, TaskLog, TaskMessage } from "./types";

export class TaskRepository {
  constructor(private pool: Pool) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const id = generateId();
    const result = await this.pool.query(
      `INSERT INTO tasks (id, status, blueprint, repo, ref, instructions, origin, created_by)
       VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, input.blueprint, input.repo, input.ref, input.instructions, input.origin, input.createdBy]
    );
    return mapRow(result.rows[0]);
  }

  async getById(id: string): Promise<Task | null> { /* ... */ }
  async list(opts: { status?: string; repo?: string; limit?: number; offset?: number }): Promise<Task[]> { /* ... */ }
  async updateStatus(id: string, status: TaskStatus, extra?: Partial<Task>): Promise<void> { /* ... */ }

  // Event ingestion from runner callbacks
  async appendLogs(taskId: string, logs: Omit<TaskLog, "id" | "ts">[]): Promise<void> { /* ... */ }
  async updateMetrics(taskId: string, costDelta: number, turnDelta: number): Promise<void> { /* ... */ }

  // Steering messages
  async sendMessage(taskId: string, content: string, sentBy: string): Promise<TaskMessage> { /* ... */ }
  async getPendingMessages(taskId: string): Promise<TaskMessage[]> { /* ... */ }
  async markMessagesPickedUp(messageIds: number[]): Promise<void> { /* ... */ }

  // Routing rules
  async listRoutingRules(): Promise<RoutingRule[]> { /* ... */ }
  async createRoutingRule(input: Omit<RoutingRule, "id" | "createdAt">): Promise<RoutingRule> { /* ... */ }
  async updateRoutingRule(id: string, input: Partial<RoutingRule>): Promise<void> { /* ... */ }
  async deleteRoutingRule(id: string): Promise<void> { /* ... */ }
}
```

**Dispatch (orchestrates task creation + workflow launch):**

```typescript
// services/tasks/src/dispatch.ts

export class TaskDispatcher {
  constructor(
    private repo: TaskRepository,
    private workflowService: WorkflowService,
    private config: DispatchConfig,
  ) {}

  async dispatch(input: CreateTaskInput): Promise<Task> {
    // Create task in Postgres
    const task = await this.repo.create(input);

    // Build RunnerSpec
    const spec: RunnerSpec = {
      taskId: task.id,
      repo: input.repo,
      ref: input.ref,
      blueprint: input.blueprint || "default",
      instructions: input.instructions,
      callbackUrl: `${this.config.appUrl}/api/tasks/${task.id}/callback`,
      constraints: {
        maxTurns: input.constraints?.maxTurns || 25,
        maxCostUsd: input.constraints?.maxCostUsd || 10,
        timeoutMinutes: input.constraints?.timeoutMinutes || 120,
      },
      secrets: {
        anthropicKey: this.config.anthropicKey,
        githubToken: this.config.githubToken,
      },
    };

    // Dispatch workflow
    const { workflowId } = await this.workflowService.dispatch(spec);
    await this.repo.updateStatus(task.id, "running", {
      workflowId,
      startedAt: new Date(),
    });

    return { ...task, status: "running", workflowId };
  }
}
```

---

## Part 2: Next.js App (`apps/web`)

### Project Structure

```
apps/web/
  package.json
  next.config.ts
  tailwind.config.ts
  tsconfig.json
  src/
    app/
      layout.tsx             # Root layout (auth provider, nav)
      page.tsx               # Dashboard home (redirects to /tasks)
      tasks/
        page.tsx             # Task list
        [id]/
          page.tsx           # Task detail (live conversation)
      rules/
        page.tsx             # Routing rules config
      settings/
        page.tsx             # API keys, sandbox config, blueprints
      api/
        auth/[...nextauth]/
          route.ts           # NextAuth handler
        health/
          route.ts           # Health check
        webhooks/
          github/
            route.ts         # GitHub webhook handler
        tasks/
          route.ts           # GET (list) + POST (create)
          [id]/
            route.ts         # GET (detail)
            events/
              route.ts       # GET SSE stream
            messages/
              route.ts       # POST steering message
            cancel/
              route.ts       # POST cancel
            callback/
              route.ts       # POST from runner (event ingestion)
            logs/
              route.ts       # GET paginated logs
        rules/
          route.ts           # GET + POST routing rules
          [id]/
            route.ts         # PUT + DELETE routing rule
        keys/
          route.ts           # GET + POST API keys
          [id]/
            route.ts         # DELETE API key
    components/
      task-list.tsx          # Task table with status badges
      task-detail.tsx        # Live conversation viewer
      conversation.tsx       # Message bubbles (assistant, tool calls, user steering)
      tool-call.tsx          # Collapsible tool execution display
      steering-input.tsx     # Text input for sending messages to running task
      rule-editor.tsx        # Routing rule form
      nav.tsx                # Side/top navigation
      status-badge.tsx       # Task status indicator
    lib/
      db.ts                  # Postgres pool (singleton)
      services.ts            # Instantiate services (WorkflowService, SandboxService, AuthService)
      auth.ts                # NextAuth config
      sse.ts                 # SSE helper for streaming events
    hooks/
      use-task-events.ts     # Client-side SSE hook for live conversation
      use-tasks.ts           # SWR hook for task list
```

### Dependencies

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
    "nanoid": "^5"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/react": "^19",
    "@types/pg": "^8"
  }
}
```

---

### Key API Route Implementations

**POST /api/tasks (create task):**

```typescript
// apps/web/src/app/api/tasks/route.ts

import { authenticateRequest } from "@gents/auth";
import { taskDispatcher } from "@/lib/services";

export async function POST(request: Request) {
  const user = await authenticateRequest(request, authService);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const input = CreateTaskSchema.parse(body);

  const task = await taskDispatcher.dispatch({
    ...input,
    origin: "cli",  // or detect from request context
    createdBy: user.id,
  });

  return Response.json(task, { status: 201 });
}

export async function GET(request: Request) {
  const user = await authenticateRequest(request, authService);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const tasks = await taskRepo.list({
    status: searchParams.get("status") || undefined,
    repo: searchParams.get("repo") || undefined,
    limit: parseInt(searchParams.get("limit") || "20"),
  });

  return Response.json(tasks);
}
```

**GET /api/tasks/:id/events (SSE stream):**

```typescript
// apps/web/src/app/api/tasks/[id]/events/route.ts

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const user = await authenticateRequest(request, authService);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const taskId = params.id;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Send existing logs as initial batch
      const existingLogs = await taskRepo.getLogs(taskId, { limit: 100 });
      for (const log of existingLogs) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(log)}\n\n`));
      }

      // Poll for new logs (in production, use Postgres LISTEN/NOTIFY)
      const interval = setInterval(async () => {
        const newLogs = await taskRepo.getLogsSince(taskId, lastSeen);
        for (const log of newLogs) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(log)}\n\n`));
          lastSeen = log.ts;
        }

        // Check if task is done
        const task = await taskRepo.getById(taskId);
        if (task && ["completed", "failed", "cancelled"].includes(task.status)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", status: task.status })}\n\n`));
          clearInterval(interval);
          controller.close();
        }
      }, 1000);

      request.signal.addEventListener("abort", () => {
        clearInterval(interval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

**POST /api/tasks/:id/callback (from runner):**

```typescript
// apps/web/src/app/api/tasks/[id]/callback/route.ts

export async function POST(request: Request, { params }: { params: { id: string } }) {
  // Verify callback token (shared secret between app and workflow)
  const token = request.headers.get("x-callback-token");
  if (token !== process.env.CALLBACK_SECRET) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const taskId = params.id;
  const body = await request.json();

  switch (body.type) {
    case "events":
      await taskRepo.appendLogs(taskId, body.events);
      await taskRepo.updateMetrics(taskId, body.costDelta || 0, body.turnDelta || 0);
      break;

    case "messages_request":
      const pending = await taskRepo.getPendingMessages(taskId);
      await taskRepo.markMessagesPickedUp(pending.map(m => m.id));
      return Response.json({ messages: pending });

    case "completion":
      await taskRepo.updateStatus(taskId, body.status, {
        completedAt: new Date(),
        result: body.result,
        lastError: body.error,
      });
      break;
  }

  return Response.json({ ok: true });
}
```

**POST /api/webhooks/github:**

```typescript
// apps/web/src/app/api/webhooks/github/route.ts

import { verifyWebhookSignature, parseWebhookEvent } from "@gents/github";
import { matchesRule, resolveInstructions } from "@gents/github";

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256") || "";

  if (!verifyWebhookSignature(body, signature, process.env.GITHUB_WEBHOOK_SECRET!)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = parseWebhookEvent(request.headers, body);
  const rules = await taskRepo.listRoutingRules();

  for (const rule of rules) {
    if (matchesRule(event, rule)) {
      await taskDispatcher.dispatch({
        repo: event.repository.clone_url,
        ref: event.ref || extractRef(event),
        blueprint: rule.blueprint,
        instructions: resolveInstructions(rule.instructions, event),
        origin: "webhook",
      });
    }
  }

  return Response.json({ ok: true });
}
```

---

### Dashboard Components

**Task Detail (live conversation):**

```typescript
// apps/web/src/app/tasks/[id]/page.tsx

"use client";

import { useTaskEvents } from "@/hooks/use-task-events";
import { Conversation } from "@/components/conversation";
import { SteeringInput } from "@/components/steering-input";
import { StatusBadge } from "@/components/status-badge";

export default function TaskDetailPage({ params }: { params: { id: string } }) {
  const { events, task, isLive } = useTaskEvents(params.id);

  return (
    <div className="flex flex-col h-full">
      <header className="border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{task?.instructions?.slice(0, 80)}</h1>
          <p className="text-sm text-muted-foreground">{task?.repo} · {task?.ref}</p>
        </div>
        <StatusBadge status={task?.status} />
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <Conversation events={events} />
      </div>

      {isLive && (
        <div className="border-t px-6 py-4">
          <SteeringInput taskId={params.id} />
        </div>
      )}
    </div>
  );
}
```

**SSE hook:**

```typescript
// apps/web/src/hooks/use-task-events.ts

import { useEffect, useState, useRef } from "react";

export function useTaskEvents(taskId: string) {
  const [events, setEvents] = useState<TaskLog[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [isLive, setIsLive] = useState(true);

  useEffect(() => {
    const eventSource = new EventSource(`/api/tasks/${taskId}/events`);

    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === "done") {
        setIsLive(false);
        eventSource.close();
      } else {
        setEvents(prev => [...prev, data]);
      }
    };

    eventSource.onerror = () => {
      setIsLive(false);
      eventSource.close();
    };

    return () => eventSource.close();
  }, [taskId]);

  return { events, task, isLive };
}
```

---

### Service Initialization

```typescript
// apps/web/src/lib/services.ts

import { Pool } from "pg";
import { RenderWorkflowService } from "@gents/workflow";
import { createSandboxService } from "@gents/sandbox";
import { NextAuthService } from "@gents/auth";
import { TaskRepository } from "@gents/tasks";
import { TaskDispatcher } from "@gents/tasks";

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
});
```

---

### Database Migrations

```
apps/web/
  migrations/
    001_initial.sql          # tasks, task_logs, task_messages, routing_rules
    002_auth.sql             # users, api_keys, sessions (NextAuth)
```

```sql
-- migrations/001_initial.sql

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  blueprint TEXT,
  repo TEXT,
  ref TEXT,
  instructions TEXT,
  origin TEXT,
  workflow_id TEXT,
  sandbox_id TEXT,
  cost_usd NUMERIC DEFAULT 0,
  turn_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_by TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE task_logs (
  id SERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  role TEXT,
  content JSONB NOT NULL,
  ts TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_task_logs_task_ts ON task_logs(task_id, ts);

CREATE TABLE task_messages (
  id SERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  sent_by TEXT,
  picked_up BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_task_messages_pending ON task_messages(task_id, picked_up) WHERE NOT picked_up;

CREATE TABLE routing_rules (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  filter JSONB DEFAULT '{}'::jsonb,
  blueprint TEXT NOT NULL,
  instructions TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

```sql
-- migrations/002_auth.sql

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE NOT NULL,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hash TEXT NOT NULL,        -- sha256 of the key
  prefix TEXT NOT NULL,      -- first 12 chars for display
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_api_keys_hash ON api_keys(hash);

-- NextAuth sessions (if using database strategy)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  session_token TEXT UNIQUE NOT NULL
);
```

---

## Part 3: Workspace Configuration

### pnpm-workspace.yaml additions

```yaml
packages:
  - "packages/agent/*"
  - "packages/runner"
  - "services/*"
  - "apps/*"
```

### Package naming

| Directory | Package Name | Purpose |
|---|---|---|
| `services/workflow` | `@gents/workflow` | WorkflowService interface + Render implementation |
| `services/sandbox` | `@gents/sandbox` | SandboxService interface + provider implementations |
| `services/auth` | `@gents/auth` | AuthService interface + NextAuth implementation |
| `services/github` | `@gents/github` | Webhook parsing, routing, GitHub API client |
| `services/tasks` | `@gents/tasks` | Task repository, dispatcher, types |
| `apps/web` | `@gents/web` | Next.js app |

---

## Part 4: Implementation Order

### Phase A: Foundation (2-3 days)

1. **Scaffold services packages** — types.ts + index.ts for each service, no implementations yet
2. **Scaffold `apps/web`** — Next.js project, Tailwind, basic layout, Postgres connection
3. **Database migrations** — create tables with a simple migration runner
4. **Auth setup** — NextAuth with GitHub provider, session + API key middleware

### Phase B: Core API (2-3 days)

5. **TaskRepository** — full Postgres CRUD for tasks, logs, messages, rules
6. **API routes** — tasks CRUD, messages, logs, routing rules
7. **SSE streaming** — `/api/tasks/:id/events` with poll-based updates
8. **Callback endpoint** — `/api/tasks/:id/callback` for runner event ingestion

### Phase C: Services (2-3 days)

9. **SandboxService** — E2B implementation (primary), Docker for local dev
10. **WorkflowService** — Render Workflows implementation
11. **TaskDispatcher** — wire up task creation → workflow dispatch
12. **GitHub webhook** — parsing, signature verification, routing rule matching

### Phase D: Dashboard (2-3 days)

13. **Task list page** — table with status badges, filters, cost
14. **Task detail page** — live conversation via SSE, tool call display
15. **Steering input** — send messages to running tasks
16. **Routing rules page** — CRUD UI for webhook → task mapping
17. **Settings page** — API key management, config display

### Phase E: Integration (1-2 days)

18. **End-to-end test** — webhook → task → workflow → sandbox → agent → PR
19. **CLI integration** — `gents dispatch` / `gents attach` against the API
20. **render.yaml** — deploy config for one-command Render deploy

---

## Open Questions

| Question | Context | Default |
|---|---|---|
| Postgres LISTEN/NOTIFY for SSE? | More efficient than polling for real-time events | Start with polling (1s), upgrade later |
| Which E2B SDK version? | They have multiple packages | `@e2b/code-interpreter` (latest) |
| Render Workflows API shape? | Need to verify exact API format | Build against their docs, abstract behind interface |
| Migration tool? | Simple SQL files vs. Drizzle/Prisma | Raw SQL files with a simple runner script |
| Monorepo build? | Turborepo or just pnpm scripts | Turborepo for caching |
