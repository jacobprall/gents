# Teams & Multi-User — Overview

What's required for a small engineering team (5–15 people) to adopt gents as a shared platform.

---

## The Core Problem: Local vs. Global State

Today, everything is local. A developer runs `gents chat` in their repo and the agent's SQLite database, workspace index, blueprints, and cost history all live in `.gents/`. There is no cloud, no shared state, no awareness of other users.

A team needs shared global state — who's running what, how much it costs, which routing rules are active, what blueprints are available — while preserving the local-first experience that makes the CLI fast and friction-free.

**Design principle: GitHub is the shared namespace, `.gents/` is local.**

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloud (Postgres)                          │
│  Teams · Members · Tasks · Logs · Rules · Keys · Blueprints │
│  Secrets · Audit Log · Cost Ledger · Notifications          │
└───────────┬──────────────────┬──────────────────┬───────────┘
            │                  │                  │
     ┌──────┴──────┐   ┌──────┴──────┐   ┌───────┴──────┐
     │  Developer A │   │ Developer B │   │  GitHub      │
     │  CLI + local │   │ CLI + local │   │  Webhooks    │
     │  .gents/     │   │  .gents/    │   │              │
     └─────────────┘   └─────────────┘   └──────────────┘
```

| State | Location | Reason |
|---|---|---|
| Agent SQLite DB (sessions, messages, metrics) | Local `.gents/` | Fast local reads, no network dependency |
| Workspace index (file tree, code chunks, FTS) | Local `.gents/workspace.sqlite` | Too large and machine-specific for cloud |
| Blueprints (definitions) | Cloud + local cache | Team shares blueprints; CLI pulls on startup |
| Blueprints (repo overrides) | Local `.gents/blueprints/` | Repo-specific, committed to git |
| Tasks (cloud-dispatched) | Cloud (Postgres) | Shared visibility, attribution, cost tracking |
| Tasks (local CLI runs) | Local `.gents/` + cloud sync | Summary synced to cloud on completion |
| Routing rules | Cloud | Team-wide configuration |
| API keys | Cloud | Issued per-user, verified server-side |
| Secrets (LLM keys, GitHub tokens) | Cloud (encrypted) | Team-owned, injected at runtime |
| Cost ledger | Cloud | Authoritative server-side record |
| Audit log | Cloud | Immutable, not deletable by individuals |

---

## Specs by Module

### P0 — Foundation (must have for team adoption)

| Module | Doc | Summary |
|---|---|---|
| Team/Org Model | [team-model.md](./team-model.md) | GitHub-org-aligned teams with pluggable auth providers. Membership, roles (owner/admin/member), scoping, invites, org sync. |
| CLI Auth | [cli-auth.md](./cli-auth.md) | `gents login` device auth flow, credential storage, `whoami`/`teams`/`switch` commands, env var overrides for CI. |
| Task Visibility | [task-visibility.md](./task-visibility.md) | Task attribution (origin, creator, hostname), team dashboard views, local run sync with retry queue, repo name normalization. |

### P1 — Guardrails (needed before giving agents real keys)

| Module | Doc | Summary |
|---|---|---|
| Billing & Cost Controls | [billing.md](./billing.md) | Cost ledger, team/user budgets, three-level enforcement (pre-dispatch, mid-execution, post-sync), usage dashboard. |
| Secrets Vault | [secrets.md](./secrets.md) | AES-256-GCM encrypted storage, dispatch-time injection, `gents secrets pull` for CLI, secret categories, auto-pull in `gents chat`. |
| GitHub App | [github-app.md](./github-app.md) | Installation flow, short-lived tokens, team-scoped webhook routing, token caching, fallback to personal tokens. |

### P2 — Polish (important but not blocking)

| Module | Doc | Summary |
|---|---|---|
| Notifications | [notifications.md](./notifications.md) | Slack webhooks, GitHub PR comments, event-based routing, message templates, deduplication. |
| Blueprint Registry | [blueprints.md](./blueprints.md) | Cloud blueprint store, resolution order (flag → local → team default → built-in), extends/merge semantics, CLI commands. |
| Audit Log | [audit.md](./audit.md) | Append-only structured log, 30+ action types, dashboard viewer, CSV/JSON export, retention policy, GDPR considerations. |

---

## New Services

| Directory | Package Name | Purpose |
|---|---|---|
| `services/teams` | `@gents/teams` | Team CRUD, membership, invites, org sync |
| `services/billing` | `@gents/billing` | Cost ledger, budgets, spend queries |
| `services/secrets` | `@gents/secrets` | Encrypted secret storage + injection |
| `services/notifications` | `@gents/notifications` | Slack, GitHub comment, email dispatch |
| `services/blueprints` | `@gents/blueprints` | Cloud blueprint registry |
| `services/audit` | `@gents/audit` | Immutable audit log |

Existing services extended: `services/auth` (provider interface), `services/tasks` (`teamId` scoping), `services/github` (App integration).

---

## Database Migrations

| Migration | Tables | Module |
|---|---|---|
| `003_teams.sql` | `teams`, `team_members`, `team_invites` + `teamId` on existing tables | Team model |
| `004_billing.sql` | `team_budgets`, `cost_ledger`, `cost_daily_agg` | Billing |
| `005_secrets.sql` | `secrets` | Secrets |
| `006_github_app.sql` | `github_installations`, `github_token_cache` | GitHub App |
| `007_audit.sql` | `audit_log` | Audit |
| `008_notifications.sql` | `notification_channels`, `notification_dedup` | Notifications |
| `009_blueprints.sql` | `blueprints`, `blueprint_versions` | Blueprints |

---

## Implementation Order

### Phase 1: Team Foundation (P0) — ~1 week

| # | Task | Depends On | Module |
|---|---|---|---|
| 1 | `teams` schema + `TeamsService` — CRUD, membership, invites | — | Team model |
| 2 | Auth provider interface + GitHub provider | — | Team model |
| 3 | Add `teamId` to tasks, routing rules, API keys | #1 | Team model |
| 4 | Scope all `TaskRepository` queries by `teamId` | #3 | Task visibility |
| 5 | `gents login` — device auth flow, credential storage | #2 | CLI auth |
| 6 | `gents whoami`, `gents teams`, `gents teams switch` | #5 | CLI auth |
| 7 | Team dashboard views — team picker, member list, settings | #1 | Team model |
| 8 | Task attribution — `origin`, `originDetail`, `createdBy` | #3 | Task visibility |

### Phase 2: Cost & Secrets (P1) — ~1 week

| # | Task | Depends On | Module |
|---|---|---|---|
| 9 | `billing` schema + `BillingService` — ledger, budgets | #1 | Billing |
| 10 | Budget enforcement in `TaskDispatcher` | #9 | Billing |
| 11 | Local run sync — CLI uploads summary on session end | #5 | Task visibility |
| 12 | Cost ledger integration — callbacks + local sync | #9, #11 | Billing |
| 13 | Usage dashboard — spend charts, breakdowns | #9 | Billing |
| 14 | `secrets` schema + `SecretsService` — encrypted storage | #1 | Secrets |
| 15 | Secrets injection in `TaskDispatcher` | #14 | Secrets |
| 16 | `gents secrets pull` — CLI fetches secrets for local runs | #14, #5 | Secrets |
| 17 | GitHub App service — installation, tokens | #1 | GitHub App |
| 18 | Webhook routing scoped by installation → team | #17 | GitHub App |

### Phase 3: Polish (P2) — ~1 week

| # | Task | Depends On | Module |
|---|---|---|---|
| 19 | `notifications` — Slack webhook + GitHub comment | #1 | Notifications |
| 20 | Notification triggers in callbacks + billing | #19 | Notifications |
| 21 | `blueprints` — cloud registry + CLI resolution | #1 | Blueprints |
| 22 | Blueprint extends/override from repo-local | #21 | Blueprints |
| 23 | `audit` — append-only log + query API | #1 | Audit |
| 24 | Audit integration in API route handlers | #23 | Audit |
| 25 | Audit log viewer + export in dashboard | #23 | Audit |

---

## Migration Path

For existing single-user setups:

1. First login creates a personal team (team of one)
2. Existing tasks (if any) are migrated to the personal team
3. User can create/join an org-linked team later
4. Local `.gents/` directories are unaffected — they don't need a team context
