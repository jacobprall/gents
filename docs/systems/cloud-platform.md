# gents — Cloud Platform (Phase 2)

The cloud platform turns gents from a local coding agent into a team tool: agents run as workflows on Render, triggered by webhooks or dispatched from CLI/dashboard, with live conversation tracking and steering.

---

## Why Cloud

The local agent is excellent for interactive work: you chat, it codes, you iterate. But some work doesn't fit that model:

- **Long-running tasks** — "Migrate all 200 API endpoints to the new auth middleware" takes hours. You don't want to keep your laptop open.
- **Event-driven work** — A GitHub issue is labeled `gents:fix`. The agent should start working without you.
- **Parallel tasks** — Five PRs need review. Five agents run simultaneously.
- **Team visibility** — Your teammate wants to see what the agent is doing on their PR.

---

## Architecture

One deploy. One database. Service abstractions for execution.

```
┌──────────────────────────────────────────────────────────────┐
│          gents (Next.js on Render)                             │
│                                                               │
│  ┌─────────────────┐  ┌───────────────────────────────────┐  │
│  │  Dashboard       │  │  API Routes                       │  │
│  │  (React/SSR)     │  │                                   │  │
│  │                  │  │  POST /api/webhooks/github         │  │
│  │  - Task list     │  │  POST /api/tasks                  │  │
│  │  - Live convo    │  │  GET  /api/tasks/:id/events (SSE) │  │
│  │  - Config        │  │  POST /api/tasks/:id/messages     │  │
│  │  - Routing rules │  │  POST /api/tasks/:id/cancel       │  │
│  └─────────────────┘  └───────────────────────────────────┘  │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Service Layer                                           │  │
│  │  WorkflowService · SandboxService · AuthService          │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Postgres (Render Managed)                               │  │
│  │  tasks · task_logs · task_messages · routing_rules        │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬────────────────────────────┘
                                   │
                        WorkflowService.dispatch()
                                   │
┌──────────────────────────────────┼────────────────────────────┐
│          Render Workflow (the brain)                            │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Agent Loop + agent-db + ctx + LLM calls                 │  │
│  │                                                          │  │
│  │  1. Provision sandbox (via SandboxService)               │  │
│  │  2. Clone repo + install deps (commands over HTTP)       │  │
│  │  3. Run agent loop:                                      │  │
│  │     LLM decides → tool calls execute in sandbox via HTTP │  │
│  │  4. Report events back to Next.js app                    │  │
│  │  5. Tear down sandbox on completion                      │  │
│  └────────────────────────────────┬────────────────────────┘  │
│                                   │                            │
│                          HTTP (exec, file ops)                 │
│                                   │                            │
│  ┌───────────┐  ┌───────────┐  ┌─┴─────────┐                 │
│  │ Sandbox A  │  │ Sandbox B  │  │ Sandbox C  │                 │
│  │ (E2B/etc)  │  │ (E2B/etc)  │  │ (E2B/etc)  │                 │
│  │ file ops   │  │ file ops   │  │ file ops   │                 │
│  │ exec cmds  │  │ exec cmds  │  │ exec cmds  │                 │
│  └───────────┘  └───────────┘  └───────────┘                 │
└───────────────────────────────────────────────────────────────┘
```

**Key insight:** The agent loop runs in the workflow (cheap compute, has LLM keys, holds the agent-db). The sandbox is a dumb execution environment — it only runs shell commands and file operations, accessed over HTTP. The sandbox doesn't need agent packages, LLM keys, or sqlite extensions.

---

## Service Abstractions

The platform uses interface-based abstractions for external services. This keeps the core decoupled from any single provider.

### WorkflowService

Orchestrates task lifecycle — durable execution that survives transient failures.

```typescript
interface WorkflowService {
  dispatch(spec: RunnerSpec): Promise<{ workflowId: string }>;
  getStatus(workflowId: string): Promise<WorkflowStatus>;
  cancel(workflowId: string): Promise<void>;
}

// Primary implementation
class RenderWorkflowService implements WorkflowService {
  // Uses Render Workflows API to dispatch durable workflow runs
}
```

### SandboxService

Provisions isolated execution environments accessed over HTTP. The sandbox is a dumb container — it exposes file operations and command execution. All reasoning happens in the workflow.

```typescript
interface SandboxService {
  create(config: SandboxConfig): Promise<Sandbox>;
  destroy(sandboxId: string): Promise<void>;
}

interface SandboxConfig {
  image?: string;           // base image (git, build tools, runtimes)
  timeout: number;          // max lifetime in minutes
  resources?: {
    cpu?: string;           // e.g. "2"
    memory?: string;        // e.g. "4Gi"
  };
  env?: Record<string, string>;
}

interface Sandbox {
  id: string;
  status: "creating" | "ready" | "running" | "stopped";
  url: string;              // HTTP endpoint for exec/file operations
  
  // Operations (called over HTTP from the workflow)
  exec(command: string, opts?: { cwd?: string; timeout?: number }): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  uploadFiles(files: FileUpload[]): Promise<void>;
  downloadFiles(paths: string[]): Promise<FileDownload[]>;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
```

The sandbox doesn't need:
- Agent packages (`@gents/*`)
- LLM API keys
- SQLite extensions
- Nomic Embed model

It only needs: git, language runtimes, build tools, and an HTTP API for remote execution.

**Implementations (pluggable):**

| Provider | Notes |
|---|---|
| E2B | Cloud sandboxes optimized for AI agents. Fast startup, good SDK. |
| Fly Machines | Low-latency ephemeral VMs. Self-managed but flexible. |
| Modal | Serverless containers with GPU support. |
| Docker (local) | For development and testing. |

### AuthService

Handles user authentication and authorization.

```typescript
interface AuthService {
  verifyToken(token: string): Promise<User | null>;
  createApiKey(userId: string, name: string): Promise<ApiKey>;
  revokeApiKey(keyId: string): Promise<void>;
  listApiKeys(userId: string): Promise<ApiKey[]>;
}

// Primary implementation: NextAuth + Postgres-backed API keys
class NextAuthService implements AuthService { }
```

---

## Next.js App

The single cloud service. Handles everything user-facing.

### API Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/webhooks/github` | POST | Receive GitHub webhooks, match routing rules, create tasks |
| `/api/tasks` | GET | List tasks (with filters: status, repo, blueprint) |
| `/api/tasks` | POST | Create a new task (from CLI dispatch or dashboard) |
| `/api/tasks/:id` | GET | Task detail (status, result, cost) |
| `/api/tasks/:id/events` | GET | SSE stream of task events (live conversation) |
| `/api/tasks/:id/messages` | POST | Send steering message to running task |
| `/api/tasks/:id/cancel` | POST | Cancel a running task |
| `/api/tasks/:id/logs` | GET | Paginated task logs |
| `/api/health` | GET | Health check |

### Auth

NextAuth with GitHub provider via the AuthService abstraction:
- Team members sign in via GitHub OAuth
- API keys for CLI access (`gents config set api_key <key>`)
- No complex RBAC — if you have access to the app, you can view and dispatch tasks

### Dashboard Pages

- **Task list** — all active/completed/failed tasks with status, cost, duration
- **Task detail** — live conversation view, tool call log, steering input
- **Routing rules** — configure which GitHub events trigger which blueprints
- **Settings** — API keys, default blueprints, cost limits, sandbox provider config

### Webhook Handler

```typescript
app.post("/api/webhooks/github", async (req) => {
  const event = parseGitHubWebhook(req);
  const rules = await db.query("SELECT * FROM routing_rules WHERE enabled = true");
  
  for (const rule of rules) {
    if (matchesRule(event, rule)) {
      const task = await createTask({
        repo: event.repository.clone_url,
        ref: event.ref || event.pull_request?.head.ref,
        blueprint: rule.blueprint,
        instructions: resolveInstructions(rule.instructions, event),
        origin: "webhook",
      });
      
      // Dispatch via WorkflowService
      await workflowService.dispatch(task.toRunnerSpec());
    }
  }
});
```

---

## Workflow Execution

The Render Workflow is the brain — it runs the agent loop, holds the agent-db, calls the LLM, and makes all decisions. The sandbox is just the hands — a remote environment where file operations and shell commands execute over HTTP.

### What Runs Where

| Component | Runs In | Why |
|---|---|---|
| Agent loop | Workflow | Cheap compute, orchestration logic |
| agent-db (SQLite) | Workflow | Local to the reasoning process |
| LLM calls (Anthropic) | Workflow | Keys stay in workflow, not sandbox |
| ctx assembly | Workflow | Reads from local agent-db |
| code_search | Workflow | Queries local SQLite vectors |
| bash, file_read, file_write, git_* | **Sandbox** (over HTTP) | Needs the repo filesystem |
| Dependency install, test runs | **Sandbox** (over HTTP) | Needs the full dev environment |

### RunnerSpec

What the Next.js app provides when dispatching a workflow:

```typescript
interface RunnerSpec {
  taskId: string;
  repo: string;
  ref: string;
  blueprint: string;
  instructions: string;
  callbackUrl: string;        // POST events back here
  constraints: {
    maxTurns: number;
    maxCostUsd: number;
    timeoutMinutes: number;
  };
  secrets: {
    anthropicKey: string;
    githubToken: string;
  };
  sandbox?: {
    provider?: string;        // override default sandbox provider
    image?: string;           // custom base image
    resources?: { cpu?: string; memory?: string };
  };
  preserveDb?: boolean;       // upload agent.db on completion
  livectx?: LivectxConfig;    // opt-in live context for custom agents
}
```

### Workflow Lifecycle

```typescript
async function executeWorkflow(spec: RunnerSpec) {
  // 1. Provision sandbox (remote execution environment)
  const sandbox = await sandboxService.create({
    timeout: spec.constraints.timeoutMinutes,
    resources: spec.sandbox?.resources,
    env: { GITHUB_TOKEN: spec.secrets.githubToken },
  });
  
  try {
    // 2. Set up environment in sandbox (commands over HTTP)
    await sandbox.exec(`git clone --depth=1 --branch=${spec.ref} ${authUrl(spec)} /workspace`);
    await sandbox.exec(detectAndInstallDeps("/workspace"));
    
    // 3. Run agent loop IN THE WORKFLOW (not in sandbox)
    await runAgentLoop(sandbox, spec);
    
  } finally {
    // 4. Tear down sandbox
    await sandboxService.destroy(sandbox.id);
  }
}

async function runAgentLoop(sandbox: Sandbox, spec: RunnerSpec) {
  // Agent-db lives in the workflow process
  const db = createAgentDB("/tmp/agent.db");
  
  // Index codebase by reading files from sandbox
  const files = await sandbox.listDir("/workspace", { recursive: true });
  await indexFromRemoteFiles(db, sandbox, files);
  
  appendMessage(db, { role: "user", content: spec.instructions });
  
  // Tools execute against the sandbox over HTTP
  const tools = createRemoteToolRegistry(sandbox);
  
  const loop = createAgentLoop({
    model: spec.blueprint.model,
    apiKey: spec.secrets.anthropicKey,
    tools,
    ctx: spec.livectx ? composeWithLivectx(baseCtx, spec.livectx) : baseCtx,
  });
  
  let done = false;
  while (!done) {
    const events = [];
    for await (const event of loop.step(db)) {
      events.push(event);
      if (event.type === "turn.complete") done = shouldStop(event, spec.constraints);
    }
    
    // Report events back to Next.js app
    await postEvents(spec.callbackUrl, spec.taskId, events);
    
    // Check for steering messages
    const messages = await fetchMessages(spec.callbackUrl, spec.taskId);
    if (messages.length > 0) {
      for (const msg of messages) {
        appendMessage(db, { role: "user", content: msg.content });
      }
      done = false;
    }
  }
  
  await reportCompletion(spec.callbackUrl, spec.taskId, db);
  if (spec.preserveDb) await uploadDb(db, spec.taskId);
}
```

### Remote Tool Registry

The key difference from local: tools that need the filesystem execute over HTTP against the sandbox.

```typescript
function createRemoteToolRegistry(sandbox: Sandbox): ToolRegistry {
  const registry = createToolRegistry();
  
  // These execute REMOTELY in the sandbox
  registry.register({
    name: "bash",
    execute: async (input) => {
      const result = await sandbox.exec(input.command, { cwd: input.cwd });
      return `exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`;
    },
  });
  
  registry.register({
    name: "file_read",
    execute: async (input) => await sandbox.readFile(input.path),
  });
  
  registry.register({
    name: "file_write",
    execute: async (input) => {
      await sandbox.writeFile(input.path, input.content);
      return "File written.";
    },
  });
  
  registry.register({
    name: "file_edit",
    execute: async (input) => {
      const content = await sandbox.readFile(input.path);
      const updated = content.replace(input.oldString, input.newString);
      await sandbox.writeFile(input.path, updated);
      return "File edited.";
    },
  });
  
  // These execute LOCALLY in the workflow (against agent-db)
  registry.register({
    name: "code_search",
    execute: async (input, ctx) => hybridSearch(ctx.db, input.query),
  });
  
  registry.register({
    name: "compact_conversation",
    execute: async (input, ctx) => compactConversation(ctx.db, input.upToTurn, input.summary),
  });
  
  return registry;
}
```

### Workflow Tiers

| Tier | Description | LLM? | Use Cases |
|---|---|---|---|
| **Tier 1: Script** | Run predefined commands in sandbox, report results | No | Run tests, lint, type-check, deploy preview |
| **Tier 2: Agent** | Full agent loop in workflow, sandbox for execution | Yes | Code review, PR fixes, migrations, security scan |
| **Tier 3: Custom Agent** | Agent loop + livectx bindings for live awareness | Yes | Infra management, monitoring, deployment automation |

Tier 1 workflows are effectively GitHub Actions on Render — zero LLM cost, just sandbox commands. Tier 2 workflows run the full agent loop. Tier 3 workflows opt into livectx for ambient awareness of live systems.

---

## livectx for Custom Agents

Standard agents (Tier 2) use the same `ctx` layer as local — tools for on-demand remote data. But specialized agents that need **ambient awareness** of live systems can opt into livectx bindings.

### When to Use livectx

| Scenario | Use livectx? | Why |
|---|---|---|
| Security review (read diff, report) | No | One-shot, no ongoing awareness needed |
| Fix failing tests | No | Reads error, fixes, done |
| Infrastructure monitor | **Yes** | Needs current service health every turn |
| Deployment automation | **Yes** | Needs deploy status, health checks, rollback readiness |
| Long-running migration with CI awareness | **Yes** | Needs to see CI results as they arrive |

### How It Works

When a blueprint specifies livectx bindings, the runner composes them into the ctx layer:

```typescript
interface LivectxConfig {
  bindings: LivectxBinding[];
}

interface LivectxBinding {
  key: string;
  source: "render" | "github" | "custom";
  resolver: string;           // function name or endpoint
  staleTime: string;          // e.g. "10s", "30s", "1m"
  placement: "static" | "dynamic";
}

// Example: infrastructure manager blueprint
const infraManagerLivectx: LivectxConfig = {
  bindings: [
    {
      key: "service-health",
      source: "render",
      resolver: "render.listServices",
      staleTime: "10s",
      placement: "dynamic",
    },
    {
      key: "deploy-status",
      source: "render",
      resolver: "render.getLatestDeploy",
      staleTime: "30s",
      placement: "dynamic",
    },
  ],
};
```

The runner detects `spec.livectx` and composes the standard ctx sections with livectx sources:

```typescript
import { source, compose } from "@livectx/core";

function composeWithLivectx(baseCtx: Prompt, config: LivectxConfig): Prompt {
  const liveSections = config.bindings.map(binding => source({
    key: [binding.source, binding.key],
    resolver: resolveBinding(binding),
    staleTime: binding.staleTime,
    placement: binding.placement,
  }));
  
  return compose(baseCtx, liveSections);
}
```

This means:
- Standard blueprints (security-reviewer, pr-fixer) work without livectx — no complexity tax
- Custom blueprints (infra-manager, deploy-automation) opt in and get live data injected every turn
- livectx is a dependency of `@gents/runner`, not of the core agent packages

---

## Conversation Tracking and Steering

The core differentiator: running agents have live conversations that anyone on the team can watch and participate in.

### How It Works

1. Runner completes a turn → POSTs events (assistant message, tool calls, results) to Next.js app
2. Next.js app inserts into `task_logs` and broadcasts via SSE
3. Connected clients (CLI via `gents attach`, web dashboard) receive events in real-time
4. User types a message → POST to `/api/tasks/:id/messages` → stored in `task_messages`
5. Runner polls `/api/tasks/:id/messages?since=<last>` between turns
6. If pending messages exist, runner injects them as user turns and continues

### Multiple Users

Multiple team members can watch and steer the same task simultaneously:

```
Developer A (CLI):   gents attach a3f2 → "also fix the tests"
Developer B (Web):   watching live → "make sure it's backwards compatible"
Runner:              picks up both messages next turn, addresses both
```

### Latency

Steering messages are picked up between turns. A turn might take 10-60 seconds. For faster control:

- **Cancel** — a flag checked between tool calls within a turn (sub-second response)
- **Pause** — same, finishes current tool call then stops

---

## Routing Rules

Simplified webhook-to-task mapping. Configured in the dashboard or via API:

```typescript
interface RoutingRule {
  id: string;
  event: string;            // 'pull_request.opened', 'push', 'issues.labeled'
  filter: {
    branches?: string[];    // branch patterns
    labels?: string[];      // label matches (for issues/PRs)
    paths?: string[];       // file path patterns
  };
  blueprint: string;        // which agent blueprint to use
  instructions: string;     // template with {{variables}} from the event
  enabled: boolean;
}
```

**Examples:**
- PR opened → run security review agent
- Push to main → run test suite
- Issue labeled `gents:fix` → run fix agent on the issue

Deduplication: one task per `(event_id, blueprint)` pair. Won't create duplicate tasks for the same webhook.

---

## Task Lifecycle

```
pending → running → completed
                 ↘ failed
                 ↘ cancelled
```

Simple. No paused/resumed states. If you want to "pause", cancel and re-dispatch.

### Task Creation

Tasks can be created from:
- **CLI** (`gents dispatch "..."`) — calls POST /api/tasks
- **Dashboard** — web UI form
- **GitHub webhook** — matched routing rule
- **API** — programmatic access via API key

---

## Postgres Schema

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  blueprint TEXT,
  repo TEXT,
  ref TEXT,
  instructions TEXT,
  origin TEXT,              -- 'webhook', 'cli', 'schedule', 'dashboard'
  workflow_id TEXT,          -- reference to WorkflowService run
  sandbox_id TEXT,          -- reference to SandboxService instance
  cost_usd NUMERIC DEFAULT 0,
  turn_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_by TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,             -- PR URL, comments posted, test results, etc.
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE task_logs (
  id SERIAL PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  type TEXT NOT NULL,       -- 'message', 'tool_call', 'tool_result', 'error', 'status'
  role TEXT,                -- 'assistant', 'system'
  content JSONB NOT NULL,
  ts TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_task_logs_task_ts ON task_logs(task_id, ts);

CREATE TABLE task_messages (
  id SERIAL PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  content TEXT NOT NULL,
  sent_by TEXT,             -- user ID or 'cli'
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

---

## Infrastructure

### render.yaml

```yaml
services:
  - type: web
    name: gents
    runtime: node
    buildCommand: pnpm install && pnpm build
    startCommand: pnpm start
    healthCheckPath: /api/health
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: gents-db
          property: connectionString
      - key: GITHUB_APP_PRIVATE_KEY
        sync: false
      - key: GITHUB_APP_ID
        sync: false
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: NEXTAUTH_SECRET
        generateValue: true
      - key: SANDBOX_PROVIDER
        value: e2b
      - key: SANDBOX_API_KEY
        sync: false

databases:
  - name: gents-db
    plan: starter
    postgresMajorVersion: 16
```

One web service. One database. Workflows orchestrate execution. Sandboxes are provisioned externally via the SandboxService.

### Environment Configuration

| Variable | Purpose |
|---|---|
| `SANDBOX_PROVIDER` | Which sandbox provider to use (`e2b`, `fly`, `modal`, `docker`) |
| `SANDBOX_API_KEY` | API key for the sandbox provider |
| `RENDER_API_KEY` | For dispatching Render Workflows |
| `ANTHROPIC_API_KEY` | Passed to runners for LLM calls |
| `GITHUB_APP_PRIVATE_KEY` | For GitHub API access and webhook verification |

---

## Cost Model

### Per-Task Costs

- **LLM tokens** — primary cost, tracked per-turn by the runner
- **Embedding generation** — local Nomic Embed in the sandbox, no API cost
- **Sandbox compute** — per-minute while running (provider-specific pricing)
- **Workflow compute** — Render Workflow billing

### Controls

- Per-task cost limits (set in RunnerSpec constraints)
- Per-blueprint default limits
- Global daily/monthly budget (enforced by Next.js app before dispatching)
- Cost guard hook in the agent loop pauses before exceeding limit

---

## Deployment Guide (Small Team)

1. Fork the gents repo
2. `render deploy` (or connect repo to Render)
3. Set environment variables (GitHub App, Anthropic key, sandbox provider key)
4. Configure routing rules in the dashboard
5. Agents start running on GitHub events

Total setup time: ~15 minutes.
