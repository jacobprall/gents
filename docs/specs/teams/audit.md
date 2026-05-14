# Audit Log

**Priority: P2** — important for trust and compliance, not blocking for initial adoption.

An immutable, append-only record of who did what, when, across the team. Enables compliance, debugging, incident response, and accountability — especially important when giving AI agents write access to production codebases.

---

## Design Decisions

### Append-Only, Never Mutable

The audit log is a write-once store. No UPDATE, no DELETE (except retention-based purge). Even team owners cannot edit or delete individual entries. This guarantees the audit trail is trustworthy.

### Log at the HTTP Layer, Not in Services

Audit entries are created in API route handlers, not inside service methods. This keeps services focused on business logic and lets the HTTP layer capture request context (IP address, user agent, request ID) that services don't have access to.

Exception: some events originate from background jobs (e.g. membership sync, budget alert) — these use a system actor.

### Structured, Not Free-Text

Every audit entry has a typed `action`, `resourceType`, and `resourceId`. This enables precise querying ("show me all secret access events") without parsing free-text descriptions.

---

## Data Model

### Audit Entry

```typescript
// services/audit/src/types.ts

export interface AuditEntry {
  id: string;                        // UUIDv7 (sortable by time)
  teamId: string;
  actorId: string;                   // user ID or "system"
  actorType: ActorType;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string;               // ID of the affected resource
  resourceName?: string;             // human-readable name for display
  metadata?: Record<string, unknown>; // action-specific details
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;                // correlate with API request logs
  timestamp: Date;
}

export type ActorType = "user" | "system" | "webhook" | "api_key";

export type AuditAction =
  // Tasks
  | "task.created"
  | "task.cancelled"
  | "task.steered"
  | "task.synced"                    // CLI local run synced to cloud
  // Routing rules
  | "rule.created"
  | "rule.updated"
  | "rule.deleted"
  | "rule.enabled"
  | "rule.disabled"
  // API keys
  | "key.created"
  | "key.revoked"
  | "key.used"                       // first use or periodic usage log
  // Secrets
  | "secret.set"
  | "secret.updated"
  | "secret.deleted"
  | "secret.accessed"                // decrypted for dispatch or CLI pull
  // Members
  | "member.invited"
  | "member.joined"
  | "member.removed"
  | "member.role_changed"
  // Team
  | "team.created"
  | "team.updated"
  | "team.deleted"
  // Blueprints
  | "blueprint.created"
  | "blueprint.updated"
  | "blueprint.archived"
  | "blueprint.deleted"
  | "blueprint.set_default"
  // Billing
  | "budget.updated"
  | "budget.alert_triggered"
  // GitHub
  | "github.installed"
  | "github.uninstalled"
  | "github.suspended"
  // Notifications
  | "notification.channel_created"
  | "notification.channel_updated"
  | "notification.channel_deleted"
  // Auth
  | "auth.login"
  | "auth.logout"
  | "auth.login_failed";

export type ResourceType =
  | "task"
  | "routing_rule"
  | "api_key"
  | "secret"
  | "member"
  | "team"
  | "blueprint"
  | "budget"
  | "github_installation"
  | "notification_channel"
  | "auth_session";
```

### Query Options

```typescript
export interface AuditQueryOpts {
  actorId?: string;                  // filter by who did it
  actorType?: ActorType;
  action?: AuditAction;              // exact action match
  actionPrefix?: string;             // e.g. "secret." matches all secret actions
  resourceType?: ResourceType;
  resourceId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;                    // default 50, max 200
  cursor?: string;                   // cursor-based pagination (entry ID)
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  nextCursor?: string;               // pass to next query for pagination
  total?: number;                    // approximate total (for display)
}
```

---

## AuditService Interface

```typescript
// services/audit/src/types.ts

export interface AuditService {
  // Write (append-only)
  log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void>;
  logBatch(entries: Omit<AuditEntry, "id" | "timestamp">[]): Promise<void>;

  // Read
  query(teamId: string, opts: AuditQueryOpts): Promise<AuditQueryResult>;
  getEntry(teamId: string, entryId: string): Promise<AuditEntry | null>;

  // Export
  export(teamId: string, opts: AuditExportOpts): Promise<AuditExportResult>;
}

export interface AuditExportOpts {
  format: "json" | "csv";
  startDate: Date;
  endDate: Date;
  actions?: AuditAction[];           // filter to specific actions
}

export interface AuditExportResult {
  data: string;                      // JSON or CSV content
  entryCount: number;
  period: { start: Date; end: Date };
}
```

---

## Database Schema

```sql
-- migrations/007_audit.sql

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,                 -- UUIDv7 for time-ordered IDs
  team_id TEXT NOT NULL,               -- no FK to teams (survives team deletion)
  actor_id TEXT,
  actor_type TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  resource_name TEXT,
  metadata JSONB,
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Primary query pattern: team + time range
CREATE INDEX idx_audit_team_time ON audit_log(team_id, created_at DESC);

-- Filter by actor
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at DESC);

-- Filter by resource
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id, created_at DESC);

-- Filter by action prefix (e.g. all "secret.*" events)
CREATE INDEX idx_audit_action ON audit_log(team_id, action, created_at DESC);
```

Note: no foreign key on `team_id`. The audit log intentionally survives team deletion — it's the permanent record.

---

## Integration Pattern

### Helper Function

A helper captures request context and calls the audit service:

```typescript
// apps/web/src/lib/audit-helpers.ts

export function auditFromRequest(
  request: Request,
  auditService: AuditService,
  teamId: string,
  user: User,
) {
  return {
    async log(
      action: AuditAction,
      resourceType: ResourceType,
      resourceId: string | undefined,
      opts?: {
        resourceName?: string;
        metadata?: Record<string, unknown>;
      },
    ): Promise<void> {
      await auditService.log({
        teamId,
        actorId: user.id,
        actorType: detectActorType(request),
        action,
        resourceType,
        resourceId,
        resourceName: opts?.resourceName,
        metadata: opts?.metadata,
        ipAddress: request.headers.get("x-forwarded-for")
          || request.headers.get("x-real-ip")
          || undefined,
        userAgent: request.headers.get("user-agent") || undefined,
        requestId: request.headers.get("x-request-id") || undefined,
      });
    },
  };
}

function detectActorType(request: Request): ActorType {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer gnt_")) return "api_key";
  return "user";
}
```

### Usage in Route Handlers

```typescript
// Example: creating a routing rule

export async function POST(request: Request) {
  const { user, teamId } = await withTeamAuth(request);
  const member = await teamsService.getMember(teamId, user.id);
  requireRole(member!, "owner", "admin");

  const body = CreateRuleSchema.parse(await request.json());
  const rule = await taskRepo.createRoutingRule({ ...body, teamId });

  // Audit
  const audit = auditFromRequest(request, auditService, teamId, user);
  await audit.log("rule.created", "routing_rule", rule.id, {
    resourceName: `${rule.event} → ${rule.blueprint}`,
    metadata: { event: rule.event, blueprint: rule.blueprint },
  });

  return Response.json(rule, { status: 201 });
}
```

### System-Initiated Events

For events that don't originate from an HTTP request (background jobs, webhooks):

```typescript
// Example: GitHub membership sync
await auditService.log({
  teamId: team.id,
  actorId: "system",
  actorType: "system",
  action: "member.removed",
  resourceType: "member",
  resourceId: userId,
  resourceName: userLogin,
  metadata: { reason: "github_org_sync", githubOrg: team.githubOrgLogin },
});
```

---

## Sensitive Event Handling

### Secret Access Logging

Every time a secret value is decrypted, an audit entry is created. This is critical for security compliance.

```typescript
// In SecretsService.getForDispatch()
async getForDispatch(teamId: string, names: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = await this.getValue(teamId, name);
    if (value) result[name] = value;
  }

  // Audit the bulk access
  await this.auditService.log({
    teamId,
    actorId: "system",
    actorType: "system",
    action: "secret.accessed",
    resourceType: "secret",
    resourceId: undefined,
    metadata: {
      secretNames: names,
      method: "dispatch",
      secretCount: Object.keys(result).length,
    },
  });

  return result;
}
```

### Login Event Logging

Track successful and failed login attempts:

```typescript
// In device auth completion
await auditService.log({
  teamId,
  actorId: user.id,
  actorType: "user",
  action: "auth.login",
  resourceType: "auth_session",
  resourceId: apiKeyId,
  metadata: { method: "device_auth", deviceCode: code.slice(0, 4) + "..." },
  ipAddress: request.headers.get("x-forwarded-for"),
});
```

---

## Dashboard: Audit Log Viewer

### Settings → Audit Log

```
/t/:teamSlug/settings/audit
```

```
┌──────────────────────────────────────────────────────────────────┐
│ Audit Log                                           [Export CSV] │
│                                                                   │
│ Filter: [All Actions ▼] [All Members ▼] [Last 7 days ▼] [Search]│
├──────────────────────────────────────────────────────────────────┤
│ Time          Actor       Action              Resource            │
│ 3m ago        @octocat    task.created        Fix auth (abc123)   │
│ 15m ago       @janedoe    rule.updated        PR review rule      │
│ 1h ago        system      secret.accessed     ANTHROPIC_API_KEY   │
│ 2h ago        @octocat    key.created         cli-macbook         │
│ 3h ago        webhook     task.created        Run tests (def456)  │
│ 5h ago        @janedoe    member.invited      bob@example.com     │
│ 1d ago        @octocat    budget.updated      $500/month          │
│ 2d ago        system      member.removed      @former-employee    │
├──────────────────────────────────────────────────────────────────┤
│ ← Previous                                        Page 1 of 12 → │
└──────────────────────────────────────────────────────────────────┘
```

### Entry Detail View

Clicking an entry expands it to show metadata:

```
┌─────────────────────────────────────────────────┐
│ secret.accessed                                  │
│                                                  │
│ Actor:     system                                │
│ Time:      May 13, 2026 3:15 PM                  │
│ Resource:  secret / ANTHROPIC_API_KEY             │
│ Method:    dispatch                              │
│ Task:      abc123                                │
│ IP:        —                                     │
│ Request:   req_xyz789                            │
│                                                  │
│ Metadata:                                        │
│ {                                                │
│   "secretNames": ["ANTHROPIC_API_KEY",           │
│                    "GITHUB_TOKEN"],               │
│   "method": "dispatch",                          │
│   "secretCount": 2                               │
│ }                                                │
└─────────────────────────────────────────────────┘
```

---

## Export

### CSV Export

Team owners can export the audit log as CSV for compliance or external analysis:

```typescript
// apps/web/src/app/api/audit/export/route.ts

export async function GET(request: Request) {
  const { user, teamId } = await withTeamAuth(request);
  const member = await teamsService.getMember(teamId, user.id);
  requireRole(member!, "owner");

  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") || "csv";
  const startDate = new Date(searchParams.get("start") || thirtyDaysAgo());
  const endDate = new Date(searchParams.get("end") || new Date().toISOString());

  const result = await auditService.export(teamId, {
    format: format as "csv" | "json",
    startDate,
    endDate,
  });

  const contentType = format === "csv" ? "text/csv" : "application/json";
  const filename = `audit-${teamSlug}-${formatDate(startDate)}-${formatDate(endDate)}.${format}`;

  return new Response(result.data, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
```

### CSV Format

```csv
timestamp,actor_id,actor_type,action,resource_type,resource_id,resource_name,ip_address,metadata
2026-05-13T22:15:00Z,user_abc,user,task.created,task,task_123,"Fix auth",203.0.113.1,"{""origin"":""cli""}"
2026-05-13T22:00:00Z,system,system,secret.accessed,secret,,"ANTHROPIC_API_KEY",,"{""method"":""dispatch""}"
```

---

## Retention Policy

### Default: 90 Days

Audit entries older than 90 days are purged by a background job. This is configurable per team (future: plan-based retention).

```sql
-- Run daily as a cron job
DELETE FROM audit_log
WHERE created_at < NOW() - INTERVAL '90 days'
  AND team_id NOT IN (
    SELECT id FROM teams WHERE plan = 'enterprise'
  );
```

Enterprise teams get extended retention (1 year or unlimited).

### Before Purging

- Export is available at any time — teams should set up periodic exports if they need long-term retention
- Dashboard shows a banner: "Audit entries older than 90 days will be purged. Export your data."

---

## Outstanding Questions

### Storage

- **Volume**: a busy team might generate 100+ audit entries per day (tasks, webhook events, secret accesses). At 90 days retention, that's ~9,000 rows per team. With 100 teams, ~900K rows. Postgres handles this fine.
- **Partitioning**: should we partition `audit_log` by month for faster purge? Not for v1 — DELETE with an indexed `created_at` is fast enough. Partition if we hit 10M+ rows.
- **Separate database**: should the audit log live in a separate database to avoid I/O contention? No for v1 — same Postgres instance. Separate if we need strict isolation or different backup policies.

### Access Control

- **Who can view**: currently owner + admin. Should members see a read-only view of their own actions? Maybe — but it adds query complexity. Defer to v2.
- **Audit the audit**: should viewing/exporting the audit log itself be logged? Yes — it's a sensitive action. But avoid infinite recursion (don't audit the audit-view audit entry).

### Completeness

- **Failed actions**: should we log actions that were denied (e.g. member tries to delete a routing rule but lacks permission)? Yes — failed auth and authorization attempts are important for security. Use a `result: "denied"` metadata field.
- **Read actions**: should we log every GET request? No — that's too noisy. Only log reads of sensitive resources (secrets, audit log exports).
- **Bulk actions**: if an admin removes 5 members at once, is that 5 entries or 1? 5 entries — one per resource affected. The `requestId` ties them together.

### Compliance

- **GDPR**: if a user requests data deletion, can we remove their audit entries? No — audit entries are anonymized (replace `actorId` with "deleted-user") but not deleted. The audit trail must survive user deletion.
- **SOC 2**: does the audit log meet SOC 2 requirements? Broadly yes for v1 (it records who, what, when, and the system is append-only). Full compliance requires tamper-proof storage, which we don't have.
- **Regulatory**: some industries (finance, healthcare) require specific retention periods. The per-team retention config handles this, but we should document the limitations.
