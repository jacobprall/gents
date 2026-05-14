# Server-Side Cost Controls & Billing

**Priority: P1** — teams need guardrails before giving agents real API keys.

Tracks LLM spend at the team, user, and task level. Enforces budgets server-side so no single developer or runaway agent can blow through resources. For v1 this is internal cost tracking, not Stripe/invoicing.

---

## Design Decisions

### Internal Budgeting, Not Invoicing

For v1, gents does not charge money. Teams bring their own LLM API keys (stored in the secrets vault) and pay their LLM provider directly. Gents tracks estimated cost based on token usage and published pricing so teams can set internal budgets and understand where money is going.

This means:
- No Stripe integration
- No payment methods or invoices
- No "credits" or prepaid balance
- Cost figures are estimates based on `@gents/agent-loop`'s `calculateCost()` function

Future: if gents offers a hosted LLM proxy or managed keys, we'd add real billing on top of this ledger.

### Three Enforcement Levels

1. **Per-task**: already exists via `CreateTaskInput.constraints.maxCostUsd` and the local `cost-guard` hook. The cloud adds server-side enforcement via the callback handler.
2. **Per-team/month**: new. A team budget with alert thresholds and optional hard stops.
3. **Per-user/month**: optional. An admin can cap individual spend to prevent one person from consuming the whole budget.

### Cost Recording Pipeline

```
Agent turn completes
  → local cost-guard hook checks per-task limit (client-side)
  → runner callback POST to /api/tasks/:id/callback with costDelta
    → callback handler records to cost_ledger
    → callback handler checks team budget
    → if budget exceeded and hardStop, respond with { stop: true }
  → session ends, CLI syncs summary to /api/tasks/sync
    → sync handler records to cost_ledger (if not already recorded via callback)
```

---

## Data Model

### Team Budget

```typescript
// services/billing/src/types.ts

export interface TeamBudget {
  teamId: string;
  monthlyLimitUsd: number;           // 0 = unlimited
  alertThresholdPct: number;         // e.g. 80 → alert at 80% of limit
  hardStop: boolean;                 // refuse new tasks when budget exhausted
  perUserLimitUsd?: number;          // optional per-user monthly cap
  updatedAt: Date;
}
```

### Cost Ledger Entry

Every cost event is a row in the ledger. This is the authoritative record.

```typescript
export interface CostLedgerEntry {
  id: string;
  teamId: string;
  taskId: string;
  userId: string;
  costUsd: number;
  model: string;
  provider: string;                  // "anthropic", "openai", etc.
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  turn?: number;                     // which turn in the conversation
  source: CostSource;
  recordedAt: Date;
}

export type CostSource =
  | "callback"                        // from runner callback during cloud execution
  | "cli_sync"                        // from CLI local run sync
  | "manual";                         // manual adjustment
```

### Spend Summary

Aggregated view for dashboards and budget checks.

```typescript
export interface SpendSummary {
  totalUsd: number;
  byModel: Record<string, number>;   // e.g. { "claude-sonnet-4": 12.50, "claude-haiku-4": 3.20 }
  byUser: Record<string, number>;    // e.g. { "user_abc": 8.10, "user_def": 7.60 }
  byRepo: Record<string, number>;    // e.g. { "acme/api": 10.20, "acme/web": 5.50 }
  byOrigin: Record<string, number>;  // e.g. { "cli": 8.00, "webhook": 7.70 }
  taskCount: number;
  period: BillingPeriod;
}

export interface BillingPeriod {
  start: Date;                       // first day of the month
  end: Date;                         // last day of the month
}
```

### Budget Status

Returned by `checkBudget()` — used at dispatch time and in the dashboard.

```typescript
export type BudgetStatus =
  | { ok: true; remainingUsd: number; usedPct: number; limit: number }
  | { ok: false; reason: "budget_exhausted" | "user_limit_exceeded"; usedPct: number; limit: number };
```

---

## BillingService Interface

```typescript
// services/billing/src/types.ts

export interface BillingService {
  // Budget management
  getTeamBudget(teamId: string): Promise<TeamBudget>;
  setTeamBudget(teamId: string, budget: Partial<TeamBudget>): Promise<void>;

  // Cost recording
  recordCost(entry: Omit<CostLedgerEntry, "id" | "recordedAt">): Promise<void>;
  recordBatch(entries: Omit<CostLedgerEntry, "id" | "recordedAt">[]): Promise<void>;

  // Budget checks
  checkTeamBudget(teamId: string): Promise<BudgetStatus>;
  checkUserBudget(teamId: string, userId: string): Promise<BudgetStatus>;

  // Spend queries
  getTeamSpend(teamId: string, period: BillingPeriod): Promise<SpendSummary>;
  getUserSpend(teamId: string, userId: string, period: BillingPeriod): Promise<SpendSummary>;
  getTaskSpend(taskId: string): Promise<{ totalUsd: number; entries: CostLedgerEntry[] }>;
  getDailySpend(teamId: string, days: number): Promise<DailySpend[]>;
}

export interface DailySpend {
  date: string;                      // YYYY-MM-DD
  totalUsd: number;
  taskCount: number;
  byModel: Record<string, number>;
}
```

---

## Enforcement Points

### 1. Before Dispatch (Pre-Check)

When `TaskDispatcher.dispatch()` is called, it checks the team budget first:

```typescript
// services/tasks/src/dispatch.ts — updated

export class TaskDispatcher {
  constructor(
    private repo: TaskRepository,
    private workflowService: WorkflowService,
    private billingService: BillingService,
    private config: DispatchConfig,
  ) {}

  async dispatch(input: CreateTaskInput): Promise<Task> {
    // Check team budget
    const teamBudget = await this.billingService.checkTeamBudget(input.teamId);
    if (!teamBudget.ok && teamBudget.reason === "budget_exhausted") {
      const budget = await this.billingService.getTeamBudget(input.teamId);
      if (budget.hardStop) {
        throw new BudgetExhaustedError(
          `Team budget exhausted ($${teamBudget.limit}/month). ` +
          `Contact a team admin to increase the limit.`
        );
      }
      // Soft limit: log warning but allow dispatch
    }

    // Check per-user budget (if configured)
    if (input.createdBy) {
      const userBudget = await this.billingService.checkUserBudget(input.teamId, input.createdBy);
      if (!userBudget.ok) {
        throw new BudgetExhaustedError(
          `Your monthly budget is exhausted ($${userBudget.limit}/month). ` +
          `Contact a team admin.`
        );
      }
    }

    // Cap per-task cost to remaining team budget
    const maxCostUsd = Math.min(
      input.constraints?.maxCostUsd || this.config.defaultMaxCostUsd,
      teamBudget.ok ? teamBudget.remainingUsd : this.config.defaultMaxCostUsd,
    );

    // ... proceed with dispatch, passing capped maxCostUsd in RunnerSpec
  }
}

export class BudgetExhaustedError extends Error {
  public readonly statusCode = 402;
  constructor(message: string) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}
```

### 2. During Execution (Callback Check)

When the runner reports cost via the callback endpoint, we check the budget again. If exhausted, we signal the runner to stop:

```typescript
// In /api/tasks/:id/callback handler

case "events":
  await taskRepo.appendLogs(taskId, body.events);
  if (body.costDelta) {
    await billingService.recordCost({
      teamId: task.teamId,
      taskId,
      userId: task.createdBy,
      costUsd: body.costDelta,
      model: body.model || "unknown",
      provider: body.provider || "unknown",
      inputTokens: body.inputTokens || 0,
      outputTokens: body.outputTokens || 0,
      turn: body.turn,
      source: "callback",
    });

    // Check if team budget is now exhausted
    const budget = await billingService.checkTeamBudget(task.teamId);
    if (!budget.ok) {
      const teamBudget = await billingService.getTeamBudget(task.teamId);
      if (teamBudget.hardStop) {
        return Response.json({ ok: true, stop: true, reason: "budget_exhausted" });
      }
    }
  }
  break;
```

The runner must respect the `stop: true` signal and gracefully terminate.

### 3. After Execution (Local Sync)

When the CLI syncs a local run summary, the sync endpoint records the cost:

```typescript
// In /api/tasks/sync handler
await billingService.recordCost({
  teamId,
  taskId: task.id,
  userId: user.id,
  costUsd: body.costUsd,
  model: body.models.join(", "),
  provider: inferProvider(body.models),
  inputTokens: 0,    // not granular in summary
  outputTokens: 0,
  source: "cli_sync",
});
```

### 4. CLI-Side (Local Guard)

The existing `cost-guard` hook in `@gents/agent-hooks` enforces per-task limits locally. For cloud-aware mode, we can enhance it to check the team budget at session start:

```typescript
// In gents chat startup (if logged in)
const budget = await fetchTeamBudget(credentials);
if (budget && !budget.ok) {
  console.warn(`⚠ Team budget ${budget.usedPct}% used ($${budget.limit}/month)`);
  if (budget.reason === "budget_exhausted") {
    console.error("Team budget exhausted. Use --no-sync to run without cloud tracking.");
    if (!opts.noSync) process.exit(1);
  }
}
```

---

## Database Schema

```sql
-- migrations/004_billing.sql

CREATE TABLE team_budgets (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  monthly_limit_usd NUMERIC NOT NULL DEFAULT 0,
  alert_threshold_pct INTEGER NOT NULL DEFAULT 80,
  hard_stop BOOLEAN NOT NULL DEFAULT false,
  per_user_limit_usd NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE cost_ledger (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  task_id TEXT REFERENCES tasks(id),
  user_id TEXT REFERENCES users(id),
  cost_usd NUMERIC NOT NULL,
  model TEXT,
  provider TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cached_input_tokens INTEGER DEFAULT 0,
  turn INTEGER,
  source TEXT NOT NULL DEFAULT 'callback',
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cost_ledger_team_period ON cost_ledger(team_id, recorded_at);
CREATE INDEX idx_cost_ledger_user_period ON cost_ledger(user_id, recorded_at);
CREATE INDEX idx_cost_ledger_task ON cost_ledger(task_id);

-- Materialized daily aggregates for fast dashboard queries
CREATE TABLE cost_daily_agg (
  team_id TEXT NOT NULL REFERENCES teams(id),
  date DATE NOT NULL,
  total_usd NUMERIC NOT NULL DEFAULT 0,
  task_count INTEGER NOT NULL DEFAULT 0,
  by_model JSONB DEFAULT '{}'::jsonb,
  by_user JSONB DEFAULT '{}'::jsonb,
  PRIMARY KEY (team_id, date)
);
```

### Daily Aggregation

A background job (or Postgres function triggered by INSERT on `cost_ledger`) maintains `cost_daily_agg`:

```sql
-- Refresh daily aggregates for a team
INSERT INTO cost_daily_agg (team_id, date, total_usd, task_count, by_model, by_user)
SELECT
  team_id,
  DATE(recorded_at) AS date,
  SUM(cost_usd) AS total_usd,
  COUNT(DISTINCT task_id) AS task_count,
  jsonb_object_agg(COALESCE(model, 'unknown'), model_cost) AS by_model,
  jsonb_object_agg(COALESCE(user_id, 'unknown'), user_cost) AS by_user
FROM (
  SELECT team_id, recorded_at, task_id, model, user_id, cost_usd,
    SUM(cost_usd) OVER (PARTITION BY team_id, DATE(recorded_at), model) AS model_cost,
    SUM(cost_usd) OVER (PARTITION BY team_id, DATE(recorded_at), user_id) AS user_cost
  FROM cost_ledger
  WHERE team_id = $1 AND DATE(recorded_at) = $2
) sub
GROUP BY team_id, DATE(recorded_at)
ON CONFLICT (team_id, date)
DO UPDATE SET
  total_usd = EXCLUDED.total_usd,
  task_count = EXCLUDED.task_count,
  by_model = EXCLUDED.by_model,
  by_user = EXCLUDED.by_user;
```

---

## Dashboard: Usage & Billing

### Settings → Usage Page

```
/t/:teamSlug/settings/usage
```

#### Monthly Overview

```
┌───────────────────────────────────────────────────┐
│ May 2026                    $47.23 / $500.00       │
│ ████████████░░░░░░░░░░░░░░░░░░ 9.4%              │
│                                                    │
│ ┌─ Daily Spend ──────────────────────────────────┐ │
│ │  ▁ ▂ ▅ ▃ ▇ ▄ ▂ ▃ ▅ ▆ ▃ ▂ _                  │ │
│ │  1  2  3  4  5  6  7  8  9 10 11 12 13         │ │
│ └────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────┘
```

#### Breakdown Tables

**By Member:**

| Member | Tasks | Spend | % of Budget |
|---|---|---|---|
| @octocat | 23 | $18.45 | 3.7% |
| @janedoe | 18 | $15.12 | 3.0% |
| @bobsmith | 12 | $8.66 | 1.7% |
| Webhooks | 8 | $5.00 | 1.0% |

**By Repo:**

| Repo | Tasks | Spend |
|---|---|---|
| acme/api | 31 | $22.10 |
| acme/web | 18 | $15.80 |
| acme/mobile | 12 | $9.33 |

**By Model:**

| Model | Tokens (In/Out) | Spend |
|---|---|---|
| claude-sonnet-4 | 1.2M / 340K | $38.40 |
| claude-haiku-4 | 820K / 210K | $8.83 |

#### Budget Configuration

```
Monthly Budget:   [$500.00    ]
Alert at:         [80] %
Hard stop:        [x] Refuse new tasks when budget exhausted
Per-user limit:   [$100.00   ] (optional)

[Save]
```

---

## Cost Accuracy

### Current Approach

`@gents/agent-loop/src/cost.ts` estimates cost from published per-token rates:

```typescript
const PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "claude-sonnet-4": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-haiku-4": { inputPer1M: 0.80, outputPer1M: 4.0 },
  // ...
};
```

### Accuracy Concerns

- **Pricing changes**: LLM providers update pricing. Our hardcoded rates drift. We need a mechanism to update them.
- **Cached input tokens**: Anthropic charges less for cached prompt tokens. Our `cachedInputTokens` field captures this, but the local `calculateCost` may not account for it correctly.
- **Batch API pricing**: if we ever use batch APIs, pricing differs.

### Mitigation

- Publish pricing as a JSON file fetched from the cloud on CLI startup (with local fallback). The cloud can update this without a CLI release.
- Track `cachedInputTokens` separately and apply the correct rate (currently 90% discount for Anthropic).
- Accept that estimates may be off by 5–15%. The dashboard should show "Estimated cost" with a tooltip explaining the methodology.

---

## Outstanding Questions

### Budget Model

- **Budget period**: monthly is natural, but some teams may want weekly or custom periods. Monthly-only for v1?
- **Rollover**: does unused budget roll over? No — each month resets to zero. This is simpler and matches how LLM billing works (pay-per-use, not prepaid).
- **Grace period**: if a task starts before the budget is exhausted and finishes after, does it count against the current month or next? Current month (based on `recorded_at`).

### Per-User Limits

- **Enforcement**: per-user limits are checked at dispatch time. But a user could start 5 cheap tasks that collectively exceed the limit. Do we track "committed" (running) cost? Complex — skip for v1 and rely on per-task limits.
- **Visibility**: should members see their own remaining budget? Yes — the CLI can show "Budget: $82.50 remaining this month" on `gents whoami`.

### Cost Sources

- **Double-counting**: if a cloud-dispatched task reports cost via callback AND the CLI also syncs the same session, we'd double-count. Solution: the sync endpoint skips cost recording if the task already has callback-sourced entries.
- **Sandbox costs**: E2B/Fly charge for compute time. Do we track this? Not for v1 — only LLM token costs. Sandbox costs can be added later as a separate ledger category.
- **GitHub API costs**: GitHub API calls are free (rate-limited, not billed). No tracking needed.

### Alerts

- **Alert delivery**: when the team hits 80% of budget, how do we notify? Via the `NotificationService` (Slack, email). What if notifications aren't configured? Show a banner on the dashboard.
- **Alert frequency**: alert once when threshold is crossed, or repeat daily while over? Once, with a dashboard banner that persists.
- **Per-user alerts**: should individual users get notified when they hit their limit? Yes — show in CLI output and optionally via notification channel.
