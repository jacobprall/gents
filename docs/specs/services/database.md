# Database Schema & Migrations

**Status:** Proposed
**Depends on:** PostgreSQL 15+

---

## Purpose

This document defines the database schema for the gents cloud platform. All services share a single Postgres database. Migrations are versioned SQL files run sequentially.

The schema supports:
- **Tasks** — lifecycle, logs, steering messages, metrics
- **Auth** — users, API keys, sessions
- **Routing** — webhook-to-task routing rules
- **Future** — cost breakdown, team/org model, scheduled tasks

---

## Migration Location

```
services/
  migrations/                    # or apps/web/migrations/ — location TBD
    001_initial.sql              # tasks, task_logs, task_messages, routing_rules
    002_auth.sql                 # users, api_keys, sessions
    003_indexes.sql              # additional indexes for production queries
```

> **Open question:** Should migrations live in a shared `services/migrations/` directory (since multiple services share the DB), or in `apps/web/migrations/` (since the web app is the primary entry point that runs migrations on deploy)?

---

## Migration 001: Tasks & Routing

```sql
-- 001_initial.sql

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
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created_by ON tasks(created_by);
CREATE INDEX idx_tasks_repo ON tasks(repo);

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

CREATE INDEX idx_task_messages_pending
  ON task_messages(task_id, picked_up) WHERE NOT picked_up;

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

### Table Notes

**`tasks`**
- `id` is a CUID or nanoid, not a UUID (shorter, URL-friendly)
- `status` is a text column, not an enum — easier to add new statuses without migrations
- `cost_usd` is `NUMERIC` for exact decimal arithmetic (no floating-point drift)
- `result` and `metadata` are `JSONB` for flexible structured data
- `ON DELETE CASCADE` on child tables means deleting a task removes all its logs and messages

**`task_logs`**
- `id` is `SERIAL` for efficient ordering (auto-incrementing)
- `content` is `JSONB` — each log type has different content shapes
- The composite index `(task_id, ts)` supports the primary query pattern: "get logs for task X since time Y"

**`task_messages`**
- The partial index `WHERE NOT picked_up` dramatically speeds up the "get pending messages" query since most messages are picked up quickly
- Messages are never deleted — they serve as an audit trail

**`routing_rules`**
- `filter` is `JSONB` — flexible filtering without schema changes
- No repo column — rules are matched against incoming events which carry the repo. Rules are global for now.

---

## Migration 002: Auth

```sql
-- 002_auth.sql

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
  hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_keys_hash ON api_keys(hash);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  session_token TEXT UNIQUE NOT NULL
);

CREATE INDEX idx_sessions_token ON sessions(session_token);
```

### Table Notes

**`users`**
- `github_id` is `UNIQUE` — each GitHub account maps to exactly one gents user
- `email` is not unique (GitHub users can share emails, or change them)
- No password column — auth is GitHub OAuth only

**`api_keys`**
- `hash` stores the SHA-256 hash of the full key (never store raw keys)
- `prefix` stores the first 12 characters for display in the UI
- `expires_at` is nullable — keys can be non-expiring
- `last_used_at` is updated on each successful verification (fire-and-forget UPDATE)
- The hash index supports O(1) key lookup during API key verification

**`sessions`**
- This table is used by NextAuth for database sessions
- `session_token` is the value stored in the cookie
- `expires_at` allows NextAuth to clean up expired sessions
- The token index supports O(1) session lookup on every authenticated request

---

## Migration 003: Production Indexes (Future)

```sql
-- 003_indexes.sql

-- Composite index for dashboard task listing (filter by status + sort by created_at)
CREATE INDEX idx_tasks_status_created
  ON tasks(status, created_at DESC);

-- Index for finding tasks by workflow (used in callback handler)
CREATE INDEX idx_tasks_workflow_id
  ON tasks(workflow_id) WHERE workflow_id IS NOT NULL;

-- Index for finding tasks by sandbox (used in sandbox reaper)
CREATE INDEX idx_tasks_sandbox_id
  ON tasks(sandbox_id) WHERE sandbox_id IS NOT NULL;

-- Index for routing rules by event (used in webhook handler)
CREATE INDEX idx_routing_rules_event
  ON routing_rules(event) WHERE enabled = true;

-- Partial index for active tasks (pending or running)
CREATE INDEX idx_tasks_active
  ON tasks(created_at DESC) WHERE status IN ('pending', 'running');
```

---

## Future Migrations

### 004: Team/Org Model

When multi-user support is needed:

```sql
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE team_members (
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',  -- 'owner', 'admin', 'member'
  PRIMARY KEY (team_id, user_id)
);

ALTER TABLE tasks ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE routing_rules ADD COLUMN team_id TEXT REFERENCES teams(id);
```

### 005: Cost Breakdown

For detailed billing analysis:

```sql
CREATE TABLE task_costs (
  id SERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  ts TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_task_costs_task ON task_costs(task_id);
```

### 006: Webhook Deliveries (Idempotency)

For deduplicating GitHub webhook re-deliveries:

```sql
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  repo TEXT NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-purge old entries (run periodically or use pg_cron)
-- DELETE FROM webhook_deliveries WHERE processed_at < NOW() - INTERVAL '7 days';
```

### 007: Scheduled Tasks

For cron-based task scheduling:

```sql
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  cron TEXT NOT NULL,                  -- cron expression
  blueprint TEXT NOT NULL,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT 'main',
  instructions TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_schedules_next_run
  ON schedules(next_run_at) WHERE enabled = true;
```

---

## Migration Runner

For v1, a simple migration runner script:

```typescript
import { Pool } from "pg";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

export async function runMigrations(pool: Pool, migrationsDir: string) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const applied = await pool.query(`SELECT name FROM _migrations`);
  const appliedSet = new Set(applied.rows.map(r => r.name));

  const files = (await readdir(migrationsDir))
    .filter(f => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), "utf-8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query(`INSERT INTO _migrations (name) VALUES ($1)`, [file]);
      await pool.query("COMMIT");
      console.log(`Applied migration: ${file}`);
    } catch (error) {
      await pool.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${error}`);
    }
  }
}
```

### Migration Guidelines

- Migrations are **forward-only** — no down migrations. If you need to undo, write a new migration.
- Each migration runs in a transaction. If any statement fails, the entire migration is rolled back.
- Migration names are sorted lexicographically. Use zero-padded numbers: `001_`, `002_`, etc.
- Never modify a migration that has already been applied in production. Always create a new one.
- Test migrations against a fresh database and against an existing database with data.

---

## Connection Pooling

Recommended `pg.Pool` configuration:

```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,           // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
```

**Notes:**
- Render Postgres has a default connection limit of 97. With 20 connections per service instance and potential auto-scaling, this limit can be hit.
- Consider using PgBouncer or Render's built-in connection pooler for production.
- The `last_used_at` update on API key verification is fire-and-forget — it should not block the request if the pool is exhausted.

---

## Open Questions

### Must-resolve before implementation

1. **Migration location**: Should migrations live in `services/migrations/` or `apps/web/migrations/`? The web app runs migrations on deploy, but the schema is shared across services. A shared location is more honest about the architecture.

2. **ID generation**: CUIDs vs. nanoids vs. UUIDs? CUIDs are sortable and URL-friendly. Nanoids are shorter. UUIDs are standard but verbose. Pick one and use it everywhere.

3. **Schema validation**: Should we add `CHECK` constraints for enum-like columns (e.g. `status IN ('pending', 'running', ...)`)? This catches bugs at the DB level but makes adding new values require a migration.

### Should-resolve before production

4. **Connection pooling**: Do we need PgBouncer or Render's connection pooler? Depends on how many service instances are running concurrently.

5. **Partitioning**: The `task_logs` table will grow fastest. Should we partition it by `task_id` or by `ts`? Range partitioning by month would make purging old logs efficient.

6. **Backup & recovery**: What's the backup strategy? Render provides automatic daily backups. Do we need point-in-time recovery? Do we need cross-region replication?

### Can-defer to v2

7. **Read replicas**: If the dashboard queries become a bottleneck, route read queries to a read replica. This requires connection routing logic in the repository layer.

8. **Full-text search**: Should task instructions and log content be searchable? Postgres full-text search is capable but requires `tsvector` columns and triggers.

9. **Row-level security**: When multi-tenancy is added, Postgres RLS can enforce team-level isolation at the database level rather than in application code.
