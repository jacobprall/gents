# Shared Task Visibility

**Priority: P0** — the core value prop of the team dashboard.

A team needs to see what agents are doing across all members, repos, and origins. This means extending the existing task model with attribution, team scoping, and a local-run sync mechanism.

---

## Design Decisions

### Attribution Over Surveillance

The goal is team awareness, not micromanagement. Every task records who started it and where it came from so the team can:

- Understand what's running and why
- Debug failures across repos
- Track cost by person and project
- Review agent work before merging

We don't record every keystroke or force screen-sharing. The dashboard shows task-level summaries and, optionally, conversation logs.

### Local Run Sync: Post-Hoc (Option A)

When a developer runs `gents chat` locally, the full conversation stays in their local `.gents/` SQLite database. On completion, the CLI uploads a summary to the cloud. The team sees the summary on the dashboard.

Why not live streaming (Option B) for v1:

- Adds latency to every agent turn (network round-trip to cloud)
- CLI must work offline or with spotty connectivity
- Privacy: developers may not want every tool call streamed in real-time
- Complexity: requires the CLI to maintain a persistent connection during the session

Live streaming is a natural follow-up (`gents chat --stream`) for teams that want real-time visibility into local runs.

---

## Task Attribution

### Extended Task Interface

```typescript
export interface Task {
  // Existing fields
  id: string;
  status: TaskStatus;
  blueprint?: string;
  repo?: string;
  ref?: string;
  instructions?: string;
  workflowId?: string;
  sandboxId?: string;
  costUsd: number;
  turnCount: number;
  lastError?: string;
  startedAt?: Date;
  completedAt?: Date;
  result?: Record<string, unknown>;
  createdAt: Date;

  // Team additions
  teamId: string;
  createdBy: string;                 // user ID
  origin: TaskOrigin;
  originDetail?: string;
  localSessionId?: string;           // for CLI-synced runs, link back to local DB

  // Enriched metadata from sync
  models?: string[];                 // LLM models used (e.g. ["claude-sonnet-4", "claude-haiku-4"])
  toolCallCount?: number;
  hostname?: string;                 // machine that ran the CLI session
}

export type TaskOrigin = "cli" | "webhook" | "dashboard" | "schedule" | "api";
```

### Origin Detail

The `originDetail` field captures provenance beyond the origin type:

| Origin | Example `originDetail` |
|---|---|
| `cli` | `cli@macbook-pro.local` (hostname) |
| `webhook` | `webhook#delivery-abc123` (GitHub delivery ID) |
| `dashboard` | `dashboard@user-session-xyz` |
| `api` | `api@key-prefix-gnt_abc` |
| `schedule` | `schedule#rule-456` (routing rule ID) |

This helps distinguish between "dispatched from someone's laptop" vs. "triggered by a GitHub push" vs. "manually created in the dashboard."

---

## Local Run Sync

### Summary Format

When a CLI session ends, the CLI builds a summary from the local SQLite metrics:

```typescript
// apps/cli/src/sync.ts

export interface LocalRunSummary {
  localSessionId: string;            // the SQLite session ID
  repo: string;                      // resolved to remote URL if available, else local path
  ref: string;                       // current branch
  blueprint: string;                 // blueprint name that was used
  instructions: string;              // first user message or session label
  status: "completed" | "failed" | "cancelled";
  turnCount: number;
  costUsd: number;
  startedAt: string;                 // ISO timestamp
  completedAt: string;
  models: string[];
  toolCallCount: number;
  hostname: string;
  conversationExcerpt?: string;      // optional: first + last few messages as markdown
}
```

### Building the Summary

```typescript
// apps/cli/src/sync.ts

import { getSessionMetrics, listMessages } from "@gents/agent-db";

export function buildLocalRunSummary(
  db: AgentDB,
  sessionId: string,
  session: Session,
  status: "completed" | "failed" | "cancelled",
): LocalRunSummary {
  const metrics = getSessionMetrics(db, sessionId);
  const messages = listMessages(db, { sessionId, limit: 1000 });
  const config = getConfig(db);

  const firstUserMsg = messages.find(m => m.role === "user");
  const repoUrl = resolveRepoUrl(db.repoPath);
  const currentBranch = getCurrentBranch(db.repoPath);

  const models = [...new Set(
    messages.filter(m => m.model).map(m => m.model!)
  )];

  return {
    localSessionId: sessionId,
    repo: repoUrl || db.repoPath,
    ref: currentBranch || "unknown",
    blueprint: config.blueprint_name || "default",
    instructions: session.label || firstUserMsg?.content?.slice(0, 500) || "(no instructions)",
    status,
    turnCount: metrics.totalTurns,
    costUsd: metrics.totalCostUsd,
    startedAt: new Date(session.createdAt).toISOString(),
    completedAt: new Date().toISOString(),
    models,
    toolCallCount: metrics.totalToolCalls,
    hostname: hostname(),
  };
}

function resolveRepoUrl(repoPath: string): string | null {
  try {
    const url = execSync("git remote get-url origin", { cwd: repoPath }).toString().trim();
    return url;
  } catch {
    return null;
  }
}

function getCurrentBranch(repoPath: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath }).toString().trim();
  } catch {
    return null;
  }
}
```

### Sync Protocol

```typescript
// apps/cli/src/sync.ts

export async function syncToCloud(
  summary: LocalRunSummary,
  credentials: StoredCredentials,
): Promise<{ taskId: string } | null> {
  try {
    const res = await fetch(`${credentials.apiUrl}/api/tasks/sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(summary),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`Sync failed (${res.status}): ${body}`);
      queueForRetry(summary);
      return null;
    }

    const { taskId } = await res.json();
    return { taskId };
  } catch (err) {
    console.warn(`Sync failed: ${err}`);
    queueForRetry(summary);
    return null;
  }
}
```

### Retry Queue

If the cloud is unreachable, summaries are queued for later:

```typescript
// apps/cli/src/sync.ts

const PENDING_SYNC_PATH = join(getConfigDir(), "pending-sync.jsonl");

function queueForRetry(summary: LocalRunSummary): void {
  appendFileSync(PENDING_SYNC_PATH, JSON.stringify(summary) + "\n");
}

export async function flushPendingSync(credentials: StoredCredentials): Promise<number> {
  if (!existsSync(PENDING_SYNC_PATH)) return 0;

  const lines = readFileSync(PENDING_SYNC_PATH, "utf-8").split("\n").filter(Boolean);
  const remaining: string[] = [];
  let synced = 0;

  for (const line of lines) {
    const summary = JSON.parse(line) as LocalRunSummary;
    const result = await syncToCloud(summary, credentials);
    if (result) {
      synced++;
    } else {
      remaining.push(line);
    }
  }

  if (remaining.length) {
    writeFileSync(PENDING_SYNC_PATH, remaining.join("\n") + "\n");
  } else {
    unlinkSync(PENDING_SYNC_PATH);
  }

  return synced;
}
```

Called at the start of every `gents chat` session (if logged in):

```typescript
// In chat command startup
const pending = await flushPendingSync(credentials);
if (pending > 0) {
  console.log(`Synced ${pending} pending session(s) to cloud.`);
}
```

### Server-Side Sync Endpoint

```typescript
// apps/web/src/app/api/tasks/sync/route.ts

const SyncSchema = z.object({
  localSessionId: z.string(),
  repo: z.string(),
  ref: z.string(),
  blueprint: z.string(),
  instructions: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
  turnCount: z.number().int().min(0),
  costUsd: z.number().min(0),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  models: z.array(z.string()),
  toolCallCount: z.number().int().min(0),
  hostname: z.string(),
  conversationExcerpt: z.string().max(50000).optional(),
});

export async function POST(request: Request) {
  const { user, teamId } = await withTeamAuth(request);
  const body = SyncSchema.parse(await request.json());

  // Deduplication: check if this local session was already synced
  const existing = await taskRepo.getByLocalSessionId(teamId, body.localSessionId);
  if (existing) {
    return Response.json({ taskId: existing.id }, { status: 200 });
  }

  const task = await taskRepo.create({
    teamId,
    repo: body.repo,
    ref: body.ref,
    blueprint: body.blueprint,
    instructions: body.instructions,
    origin: "cli",
    originDetail: `cli@${body.hostname}`,
    createdBy: user.id,
    localSessionId: body.localSessionId,
    status: body.status,
    turnCount: body.turnCount,
    costUsd: body.costUsd,
    models: body.models,
    toolCallCount: body.toolCallCount,
    startedAt: new Date(body.startedAt),
    completedAt: new Date(body.completedAt),
  });

  // Record cost in the ledger
  await billingService.recordCost({
    teamId,
    taskId: task.id,
    userId: user.id,
    costUsd: body.costUsd,
    model: body.models.join(", "),
    inputTokens: 0,    // not available in summary
    outputTokens: 0,
  });

  return Response.json({ taskId: task.id }, { status: 201 });
}
```

---

## Dashboard Views

### Task List Page

The primary view. Team-scoped, with filters and sorting.

#### Filters

| Filter | Type | Options |
|---|---|---|
| Status | Multi-select | Pending, Running, Completed, Failed, Cancelled |
| Origin | Multi-select | CLI, Webhook, Dashboard, Schedule, API |
| Repo | Dropdown (from known repos) | All repos the team has used |
| Member | Dropdown | All team members |
| Date range | Date picker | Last 24h, Last 7d, Last 30d, Custom |
| Blueprint | Dropdown | All blueprints used |

#### Sort Options

- Created (newest first) — default
- Created (oldest first)
- Cost (highest first)
- Turns (most first)
- Duration (longest first)

#### Table Columns

| Column | Description |
|---|---|
| Status | Color-coded badge (green/yellow/red/gray) |
| Instructions | Truncated first line, links to detail page |
| Repo | Short repo name (e.g. `acme/api`) |
| Branch | Ref/branch name |
| Origin | Badge (CLI/Webhook/Dashboard) |
| Member | Avatar + name of creator |
| Cost | USD amount, color-coded (green < $1, yellow < $5, red > $5) |
| Turns | Turn count |
| Created | Relative time ("3m ago") |
| Duration | Wall-clock time |

#### URL Structure

```
/t/:teamSlug/tasks                       # all tasks
/t/:teamSlug/tasks?status=running        # active tasks
/t/:teamSlug/tasks?origin=webhook        # webhook-triggered tasks
/t/:teamSlug/tasks?member=user_abc       # one member's tasks
/t/:teamSlug/tasks?repo=acme/api         # one repo's tasks
```

### Task Detail Page

Shows the full context of a single task.

**For cloud-dispatched tasks**: full live conversation via SSE (already spec'd in `web/index.md`).

**For CLI-synced tasks**: summary view with metadata. If `conversationExcerpt` is available, show it. Otherwise, show "This task ran locally. Full conversation is available on the originating machine."

#### Detail Layout

```
┌─────────────────────────────────────────────────────────┐
│ Task: Fix auth middleware to handle expired tokens       │
│ acme/api · main · @octocat via CLI                       │
│ ● Completed · 12 turns · $0.47 · 3m 22s                │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ [Conversation / Summary]    [Logs]    [Metadata]         │
│                                                          │
│ Conversation tab:                                        │
│   └ Message bubbles, tool calls (for cloud tasks)        │
│   └ Summary excerpt (for CLI-synced tasks)               │
│                                                          │
│ Metadata tab:                                            │
│   └ Blueprint: security-reviewer                         │
│   └ Models: claude-sonnet-4, claude-haiku-4              │
│   └ Tool calls: 47                                       │
│   └ Origin: cli@macbook-pro.local                        │
│   └ Local session: abc123-def456                         │
│   └ Created: May 13, 2026 5:30 PM                        │
│   └ Completed: May 13, 2026 5:33 PM                      │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Aggregate Views

#### Team Activity Feed

A chronological feed of task events across the team:

```
@octocat started "Fix auth middleware" on acme/api          3m ago
@janedoe's task "Add search endpoint" completed ($1.23)     15m ago
Webhook: push to main on acme/web triggered "Run tests"     1h ago
@octocat's task "Fix auth middleware" completed ($0.47)      just now
```

#### Repo Summary

Group tasks by repo, show aggregate stats:

```
acme/api         23 tasks   $12.47   Last run: 3m ago
acme/web         15 tasks    $8.92   Last run: 1h ago
acme/mobile       4 tasks    $2.10   Last run: 2d ago
```

#### Member Summary

Show per-member stats for the current billing period:

```
@octocat         45 tasks   $18.23   Active now
@janedoe         32 tasks   $14.11   Last active: 15m ago
@bobsmith        12 tasks    $5.80   Last active: 2d ago
```

---

## Repo Name Normalization

Tasks come from different sources with different repo identifiers:

- CLI sync: `https://github.com/acme/api.git` or `/Users/dev/code/api`
- Webhook: `https://github.com/acme/api`
- Dashboard: user types `acme/api`

We normalize to `owner/repo` format for consistent querying and display:

```typescript
export function normalizeRepoName(input: string): string {
  // HTTPS URL: https://github.com/acme/api.git → acme/api
  const httpsMatch = input.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (httpsMatch) return httpsMatch[1];

  // SSH URL: git@github.com:acme/api.git → acme/api
  const sshMatch = input.match(/git@github\.com:([^/]+\/[^/.]+)/);
  if (sshMatch) return sshMatch[1];

  // Already normalized: acme/api
  if (/^[^/]+\/[^/]+$/.test(input)) return input;

  // Local path: keep as-is (can't normalize)
  return input;
}
```

---

## Outstanding Questions

### Sync

- **Sync consent**: should local run sync be opt-in or opt-out? Default to opt-in if logged in, with `--no-sync` to suppress. Team admins can enforce sync via `allowLocalRuns` setting.
- **Partial sync**: can a user sync some sessions but not others? (e.g. "sync my work sessions but not my experiments") Not for v1 — sync is all-or-nothing per session.
- **Conversation upload**: when should we send the full conversation vs. just the summary? Sensitivity concerns — the conversation contains code, file contents, and tool outputs. Options:
  - Summary only (default)
  - Full conversation opt-in per session (`gents chat --sync-full`)
  - Team setting to require full conversation sync
- **Bandwidth**: a heavy session might have 100+ turns with large tool outputs. Summary is ~1KB; full conversation could be 100KB+. Is this a concern?

### Dashboard

- **Real-time updates**: should the task list auto-refresh? Yes, via SWR polling (5s interval for the task list). Active tasks show a pulsing indicator.
- **Search**: should users be able to search task instructions? Yes, basic Postgres `ILIKE` for v1. Full-text search later.
- **Deep linking**: task URLs (`/t/acme/tasks/abc123`) should be shareable across the team. Already supported by the URL structure.
- **Mobile**: is the dashboard mobile-friendly? Not a priority for v1, but the table should at least be horizontally scrollable.

### Privacy

- **Task visibility within team**: can a member hide their tasks from the team? No — team visibility is the point. If you don't want something visible, use `--no-sync`.
- **Cross-team**: can anyone outside the team see tasks? No. All queries are strictly scoped by `teamId`.
- **Deleted members**: when a member leaves, are their tasks still visible? Yes — the tasks belong to the team, not the individual. The `createdBy` reference shows "(former member)" if the user is no longer on the team.
