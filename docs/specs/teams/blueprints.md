# Shared Blueprint Registry

**Priority: P2** — teams can use repo-local blueprints initially.

A cloud-hosted blueprint registry where teams store, version, and share agent blueprints. The CLI resolves blueprints from the cloud registry when local ones aren't available. Repo-local blueprints can extend cloud blueprints.

---

## Design Decisions

### Cloud + Local, Not One Or The Other

Blueprints live in two places:

1. **Cloud registry**: team-owned, managed via dashboard or API. Available to all team members and all repos.
2. **Repo-local**: `.gents/blueprints/<name>.yaml` checked into the repo. Available only in that repo.

These coexist. The resolution order determines which wins (see below). This means a team can have shared defaults while individual repos customize for their needs.

### `AgentBlueprint` as the Spec Format

The existing `AgentBlueprint` type from `@gents/agent-db` is the canonical blueprint format. The cloud registry stores the same structure as JSON. The repo-local YAML files parse into the same type. No new format to learn.

```typescript
// From @gents/agent-db/src/types.ts
export interface AgentBlueprint {
  name: string;
  description?: string;
  tools: ToolDef[];
  permissions: Permission[];
  excludePatterns: string[];
  config: Record<string, string>;
  seedMessages?: NewMessage[];
  systemInstructions?: string;
  skills?: Skill[];
  subagents?: SubagentDef[];
}
```

### Extends/Merge Semantics

Repo-local blueprints can extend a cloud blueprint using the `extends` field. This inherits all fields from the parent and allows selective overrides. This is similar to TypeScript's `extends` or Docker's multi-stage builds.

---

## Data Model

### Cloud Blueprint

```typescript
// services/blueprints/src/types.ts

export interface CloudBlueprint {
  id: string;
  teamId: string;
  name: string;                      // unique within team, e.g. "security-reviewer"
  description?: string;
  version: number;                   // auto-incremented on update
  spec: AgentBlueprint;             // the full blueprint definition
  isDefault: boolean;               // team's default blueprint (at most one per team)
  isArchived: boolean;              // soft-deleted but still referenceable
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBlueprintInput {
  name: string;
  description?: string;
  spec: AgentBlueprint;
  isDefault?: boolean;
}

export interface UpdateBlueprintInput {
  description?: string;
  spec?: AgentBlueprint;
  isDefault?: boolean;
  isArchived?: boolean;
}
```

### Database Schema

```sql
-- Part of migrations/009_blueprints.sql

CREATE TABLE blueprints (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  spec JSONB NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (team_id, name)
);
CREATE INDEX idx_blueprints_team ON blueprints(team_id) WHERE NOT is_archived;

-- Version history (append-only)
CREATE TABLE blueprint_versions (
  id TEXT PRIMARY KEY,
  blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  spec JSONB NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (blueprint_id, version)
);
```

---

## BlueprintService Interface

```typescript
// services/blueprints/src/types.ts

export interface BlueprintService {
  // CRUD
  list(teamId: string, opts?: { includeArchived?: boolean }): Promise<CloudBlueprint[]>;
  get(teamId: string, name: string): Promise<CloudBlueprint | null>;
  getById(blueprintId: string): Promise<CloudBlueprint | null>;
  create(teamId: string, input: CreateBlueprintInput, userId: string): Promise<CloudBlueprint>;
  update(teamId: string, name: string, input: UpdateBlueprintInput, userId: string): Promise<CloudBlueprint>;
  archive(teamId: string, name: string): Promise<void>;
  delete(teamId: string, name: string): Promise<void>;

  // Default management
  setDefault(teamId: string, name: string): Promise<void>;
  getDefault(teamId: string): Promise<CloudBlueprint | null>;

  // Version history
  listVersions(teamId: string, name: string): Promise<BlueprintVersion[]>;
  getVersion(teamId: string, name: string, version: number): Promise<AgentBlueprint | null>;
}

export interface BlueprintVersion {
  version: number;
  updatedBy: string;
  createdAt: Date;
}
```

---

## Resolution Order

When the CLI starts a session, blueprint resolution follows this order:

```
1. Explicit flag:       gents chat --blueprint security-reviewer
2. Repo-local file:     .gents/blueprints/security-reviewer.yaml
3. Team default:        cloud blueprint marked isDefault=true
4. Built-in default:    DEFAULT_BLUEPRINT from @gents/agent-db
```

### Resolution Logic

```typescript
// apps/cli/src/blueprint-resolver.ts

export async function resolveBlueprint(opts: {
  name?: string;                     // from --blueprint flag
  repoPath: string;
  credentials?: StoredCredentials;
}): Promise<AgentBlueprint> {
  const { name, repoPath, credentials } = opts;

  // 1. If name specified, look it up
  if (name) {
    // Try repo-local first
    const localPath = join(repoPath, ".gents", "blueprints", `${name}.yaml`);
    if (existsSync(localPath)) {
      const local = loadLocalBlueprint(localPath);
      if (local.extends && credentials) {
        const parent = await fetchCloudBlueprint(credentials, local.extends);
        return mergeBlueprints(parent, local);
      }
      return local;
    }

    // Try cloud registry
    if (credentials) {
      const cloud = await fetchCloudBlueprint(credentials, name);
      if (cloud) return cloud;
    }

    console.warn(`Blueprint "${name}" not found locally or in cloud. Using default.`);
  }

  // 2. Check for repo-local default
  const defaultLocalPath = join(repoPath, ".gents", "blueprints", "default.yaml");
  if (existsSync(defaultLocalPath)) {
    return loadLocalBlueprint(defaultLocalPath);
  }

  // 3. Try team default from cloud
  if (credentials) {
    try {
      const teamDefault = await fetchTeamDefaultBlueprint(credentials);
      if (teamDefault) return teamDefault;
    } catch {
      // Cloud unreachable — fall through to built-in
    }
  }

  // 4. Built-in default
  return DEFAULT_BLUEPRINT;
}
```

### Fetching from Cloud

```typescript
async function fetchCloudBlueprint(
  creds: StoredCredentials,
  name: string,
): Promise<AgentBlueprint | null> {
  try {
    const res = await fetch(`${creds.apiUrl}/api/blueprints/${name}`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.spec as AgentBlueprint;
  } catch {
    return null;
  }
}

async function fetchTeamDefaultBlueprint(
  creds: StoredCredentials,
): Promise<AgentBlueprint | null> {
  try {
    const res = await fetch(`${creds.apiUrl}/api/blueprints?default=true`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const defaultBp = data.find((bp: any) => bp.isDefault);
    return defaultBp?.spec || null;
  } catch {
    return null;
  }
}
```

---

## Extends/Merge Semantics

A repo-local blueprint can extend a cloud blueprint:

```yaml
# .gents/blueprints/custom.yaml
extends: security-reviewer          # inherit from cloud blueprint

description: "Security reviewer with Docker access for this repo"

config:
  max_turns: "32"                   # override parent's max_turns

permissions:
  - id: allow-docker
    type: tool_allow
    pattern: "run_terminal_cmd:docker*"

exclude_patterns:
  - "**/vendor/**"                  # additional exclusion
```

### Merge Rules

The merge is shallow with array concatenation:

| Field | Merge Behavior |
|---|---|
| `name` | Child wins |
| `description` | Child wins (if present) |
| `tools` | Parent tools + child tools (child overrides by name) |
| `permissions` | Parent permissions + child permissions (child overrides by id) |
| `excludePatterns` | Parent patterns + child patterns (union) |
| `config` | Parent config merged with child config (child wins per key) |
| `seedMessages` | Child replaces entirely (if present) |
| `systemInstructions` | Child replaces entirely (if present) |
| `skills` | Parent skills + child skills (child overrides by name) |
| `subagents` | Parent subagents + child subagents (child overrides by name) |

```typescript
// apps/cli/src/blueprint-resolver.ts

export function mergeBlueprints(
  parent: AgentBlueprint,
  child: LocalBlueprintWithExtends,
): AgentBlueprint {
  return {
    name: child.name || parent.name,
    description: child.description || parent.description,

    tools: mergeByKey(parent.tools, child.tools || [], "name"),
    permissions: mergeByKey(parent.permissions, child.permissions || [], "id"),
    excludePatterns: [...new Set([...parent.excludePatterns, ...(child.excludePatterns || [])])],
    config: { ...parent.config, ...(child.config || {}) },

    seedMessages: child.seedMessages ?? parent.seedMessages,
    systemInstructions: child.systemInstructions ?? parent.systemInstructions,
    skills: mergeByKey(parent.skills || [], child.skills || [], "name"),
    subagents: mergeByKey(parent.subagents || [], child.subagents || [], "name"),
  };
}

function mergeByKey<T extends Record<string, unknown>>(
  parent: T[],
  child: T[],
  key: string,
): T[] {
  const map = new Map(parent.map(item => [(item as any)[key], item]));
  for (const item of child) {
    map.set((item as any)[key], item);
  }
  return Array.from(map.values());
}
```

---

## CLI Commands

```
gents blueprints                     # list cloud blueprints for current team
gents blueprints show <name>         # show blueprint details
gents blueprints push <file>         # upload a local YAML to cloud registry
gents blueprints pull <name>         # download a cloud blueprint to .gents/blueprints/
gents blueprints set-default <name>  # set team default
```

### `gents blueprints` (list)

```
$ gents blueprints
Team: acme-eng

  default              General-purpose coding assistant          ★ default
  security-reviewer    Security-focused code review              v3
  test-writer          Generate and update test suites           v1
  infra-manager        Infrastructure and deployment tasks       v2
```

### `gents blueprints push`

```
$ gents blueprints push .gents/blueprints/security-reviewer.yaml
Uploading "security-reviewer" to team "acme-eng"...
  ✓ Created blueprint "security-reviewer" (v1)
```

---

## Dashboard: Blueprints Page

### Settings → Blueprints

```
/t/:teamSlug/settings/blueprints
```

```
┌─────────────────────────────────────────────────────────────────┐
│ Blueprints                                    [+ New Blueprint] │
├─────────────────────────────────────────────────────────────────┤
│ Name                Description                 Ver  Default    │
│ gents-default       General-purpose assistant    v1   ★         │
│ security-reviewer   Security-focused review      v3             │
│ test-writer         Test suite generation        v1             │
│ infra-manager       Infrastructure tasks         v2             │
└─────────────────────────────────────────────────────────────────┘
```

### Blueprint Editor

A form for creating/editing blueprints. For v1, this is a structured form (not a raw YAML editor):

- Name and description
- System instructions (textarea)
- Config key-value pairs
- Tool selection (checkboxes from available tools)
- Permission rules (add/remove)
- Exclude patterns (tag input)

Future: a side-by-side YAML editor with syntax highlighting and validation.

---

## Outstanding Questions

### Resolution

- **Caching**: should the CLI cache cloud blueprints locally to avoid fetching on every `gents chat`? Yes — cache in `~/.config/gents/blueprint-cache/` with a TTL (e.g. 1 hour). Invalidate on `gents blueprints pull`.
- **Offline**: if the cloud is unreachable, should the CLI use a stale cached blueprint or fall back to the built-in default? Use stale cache if available, built-in default otherwise. Print a warning.
- **Precedence confusion**: if a repo has `.gents/blueprints/foo.yaml` and the cloud has `foo`, which wins? Repo-local. This is intentional — repos should be able to override team defaults. But it could confuse users. Document clearly.

### Versioning

- **Full history vs. last N**: do we keep every version forever? For v1, keep the last 10 versions per blueprint. Older versions are pruned by a background job.
- **Rollback**: can an admin roll back to a previous version? Yes — `gents blueprints rollback <name> <version>` or a "Restore" button in the dashboard.
- **Diff view**: can users see what changed between versions? Nice-to-have for v1. Show JSON diff in the dashboard.

### Git Sync

- **Auto-push on git push**: when someone pushes changes to `.gents/blueprints/` in a repo, should a webhook auto-update the cloud registry? This is powerful but risky (a bad commit could break all tasks). Skip for v1 — blueprints are pushed to the cloud explicitly.
- **GitOps mode**: some teams want blueprints managed purely via git, with the cloud registry as a read-only mirror. This is a natural extension of auto-push. Defer to v2.

### Sharing

- **Cross-team blueprints**: can a blueprint be shared across teams? Not for v1 — blueprints are team-private. Future: a public blueprint marketplace.
- **Blueprint templates**: should we ship starter blueprints (security reviewer, test writer, infra manager) that teams can fork? Yes — as "template" blueprints in the docs or a `gents blueprints init <template>` command.
