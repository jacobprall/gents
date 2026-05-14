# Secrets Vault

**Priority: P1** — teams can't share LLM keys via env vars.

Team-owned secrets (LLM API keys, GitHub tokens, sandbox keys) stored encrypted at rest, injected into runners at dispatch time, and available to the CLI for local runs via `gents secrets pull`.

---

## Design Decisions

### Server-Side Encryption, Not Client-Side

Secrets are encrypted at rest in Postgres using a server-side encryption key. The key lives in the server's environment (`ENCRYPTION_KEY`), not in the database.

Why not client-side encryption (where the client encrypts before sending):
- The server needs to decrypt for dispatch (inject into RunnerSpec)
- Key management is simpler with one server-side key
- The threat model: protect against database dumps, not a compromised server. If the server is compromised, the attacker already has access to running tasks.

### Values Never Leave the Server (Except to Runners and CLI Pull)

The `list()` method returns secret metadata (name, description, created by, last updated) but **never** the value. The only code paths that decrypt values are:

1. `getForDispatch()` — called by `TaskDispatcher` to inject secrets into `RunnerSpec`
2. `get()` — called by the CLI pull endpoint (`/api/secrets/pull`)

Both paths are authenticated, audited, and rate-limited.

### Secret Naming Convention

Secrets are named like environment variables: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `E2B_API_KEY`. This makes them easy to map into runner environments and CLI processes.

---

## Data Model

### Secret (Metadata Only)

```typescript
// services/secrets/src/types.ts

export interface Secret {
  id: string;
  teamId: string;
  name: string;                      // e.g. "ANTHROPIC_API_KEY"
  description?: string;              // human-readable note
  category: SecretCategory;
  createdBy: string;                 // user ID
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  // value is NEVER included in this type
}

export type SecretCategory =
  | "llm"                             // LLM provider keys (Anthropic, OpenAI)
  | "github"                          // GitHub tokens
  | "sandbox"                         // Sandbox provider keys (E2B, Fly)
  | "custom";                         // user-defined

export interface SecretValue {
  name: string;
  value: string;                     // plaintext, only used in dispatch/pull contexts
}
```

### Known Secrets

Some secrets have special meaning in the dispatch pipeline:

| Name | Category | Used For |
|---|---|---|
| `ANTHROPIC_API_KEY` | llm | Passed to runner as `secrets.anthropicKey` |
| `OPENAI_API_KEY` | llm | Passed to runner as `secrets.openaiKey` |
| `GITHUB_TOKEN` | github | Passed to runner for repo clone + PR creation |
| `E2B_API_KEY` | sandbox | Used by `SandboxService.create()` |
| `FLY_API_TOKEN` | sandbox | Used by `FlySandboxService` |
| `CALLBACK_SECRET` | custom | Shared secret for runner → app callbacks |

Teams can also add arbitrary custom secrets that are injected into the runner environment.

---

## SecretsService Interface

```typescript
// services/secrets/src/types.ts

export interface SecretsService {
  // CRUD (value encrypted at rest)
  set(teamId: string, name: string, value: string, opts: {
    userId: string;
    description?: string;
    category?: SecretCategory;
  }): Promise<Secret>;

  delete(teamId: string, name: string): Promise<void>;

  // Metadata listing (values never returned)
  list(teamId: string): Promise<Secret[]>;
  get(teamId: string, name: string): Promise<Secret | null>;
  exists(teamId: string, name: string): Promise<boolean>;

  // Value retrieval (restricted to dispatch + CLI pull)
  getValue(teamId: string, name: string): Promise<string | null>;
  getForDispatch(teamId: string, names: string[]): Promise<Record<string, string>>;
  getAllForCLI(teamId: string): Promise<SecretValue[]>;
}
```

---

## Encryption Implementation

### Algorithm

AES-256-GCM with a random 12-byte IV per secret. The IV is stored alongside the ciphertext.

```typescript
// services/secrets/src/crypto.ts

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Format: base64(iv + authTag + ciphertext)
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

export function decrypt(encoded: string, key: Buffer): string {
  const combined = Buffer.from(encoded, "base64");

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf-8");
}

export function deriveKey(encryptionKey: string): Buffer {
  // The ENCRYPTION_KEY env var is a 64-char hex string (32 bytes)
  if (encryptionKey.length === 64 && /^[0-9a-f]+$/i.test(encryptionKey)) {
    return Buffer.from(encryptionKey, "hex");
  }
  // Fallback: hash the key to get 32 bytes
  return createHash("sha256").update(encryptionKey).digest();
}
```

### Key Management

The encryption key is a single env var on the server:

```bash
# Generate: openssl rand -hex 32
ENCRYPTION_KEY=a1b2c3d4e5f6...  # 64 hex chars = 32 bytes
```

For v1, a single key is sufficient. If the key needs to rotate, we'd:

1. Add a `key_version` column to the secrets table
2. Decrypt with the old key, re-encrypt with the new key (batch migration)
3. Support reading secrets encrypted with either key during the transition

---

## Database Schema

```sql
-- migrations/005_secrets.sql

CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,      -- AES-256-GCM ciphertext (base64)
  description TEXT,
  category TEXT NOT NULL DEFAULT 'custom',
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (team_id, name)
);
CREATE INDEX idx_secrets_team ON secrets(team_id);
```

---

## Integration: Task Dispatch

When `TaskDispatcher.dispatch()` runs, it reads secrets from the vault:

```typescript
// services/tasks/src/dispatch.ts — updated

async dispatch(input: CreateTaskInput): Promise<Task> {
  // ... budget checks ...

  // Retrieve secrets for the RunnerSpec
  const requiredSecrets = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"];
  const optionalSecrets = ["OPENAI_API_KEY", "E2B_API_KEY"];

  const secrets = await this.secretsService.getForDispatch(
    input.teamId,
    [...requiredSecrets, ...optionalSecrets]
  );

  // Validate required secrets exist
  for (const name of requiredSecrets) {
    if (!secrets[name]) {
      throw new MissingSecretError(
        `Required secret "${name}" is not configured. ` +
        `Go to Settings → Secrets to add it.`
      );
    }
  }

  const spec: RunnerSpec = {
    taskId: task.id,
    // ...
    secrets: {
      anthropicKey: secrets.ANTHROPIC_API_KEY,
      githubToken: secrets.GITHUB_TOKEN,
      openaiKey: secrets.OPENAI_API_KEY,
    },
    env: Object.fromEntries(
      Object.entries(secrets)
        .filter(([name]) => !requiredSecrets.includes(name) && !optionalSecrets.includes(name))
        .map(([name, value]) => [name, value])
    ),
  };

  // ... dispatch workflow ...
}
```

---

## Integration: CLI Pull

### `gents secrets pull`

Fetches team secrets into the CLI process's environment for local runs.

```
$ gents secrets pull
Pulled 4 secrets for team "acme-eng"
  ANTHROPIC_API_KEY ✓
  GITHUB_TOKEN ✓
  E2B_API_KEY ✓
  CUSTOM_WEBHOOK_URL ✓

Secrets are available for this session only (not written to disk).
```

### Server Endpoint

```typescript
// apps/web/src/app/api/secrets/pull/route.ts

export async function GET(request: Request) {
  const { user, teamId } = await withTeamAuth(request);

  // Audit: log that this user is pulling secrets
  await auditService.log({
    teamId,
    actorId: user.id,
    actorType: "user",
    action: "secret.accessed",
    resourceType: "secrets",
    resourceId: "bulk_pull",
    metadata: { method: "cli_pull" },
  });

  const secrets = await secretsService.getAllForCLI(teamId);

  return Response.json({
    secrets: secrets.map(s => ({ name: s.name, value: s.value })),
  });
}
```

### CLI Implementation

```typescript
// apps/cli/src/commands/secrets.ts

async function pullSecrets(): Promise<Record<string, string>> {
  const creds = requireCredentials();

  const res = await fetch(`${creds.apiUrl}/api/secrets/pull`, {
    headers: { Authorization: `Bearer ${creds.apiKey}` },
  });

  if (!res.ok) {
    if (res.status === 403) {
      console.error("You don't have permission to pull secrets.");
      process.exit(1);
    }
    throw new Error(`Failed to pull secrets: ${res.status}`);
  }

  const { secrets } = await res.json();
  const env: Record<string, string> = {};

  for (const { name, value } of secrets) {
    env[name] = value;
  }

  console.log(`Pulled ${secrets.length} secrets for team "${creds.teamSlug}"`);
  for (const { name } of secrets) {
    console.log(`  ${name} ✓`);
  }
  console.log("\nSecrets are available for this session only (not written to disk).");

  return env;
}
```

### Automatic Pull in `gents chat`

When logged in, `gents chat` auto-pulls secrets on startup if the required env vars aren't already set:

```typescript
// In chat command startup
if (credentials && !process.env.ANTHROPIC_API_KEY) {
  try {
    const secrets = await pullSecrets();
    Object.assign(process.env, secrets);
  } catch (err) {
    console.warn("Could not pull team secrets. Using local env vars.");
  }
}
```

This means: if you have `ANTHROPIC_API_KEY` set locally, it takes precedence. If not, the team's secret is used. No disk writes.

---

## Dashboard: Secrets Management

### Settings → Secrets Page

```
/t/:teamSlug/settings/secrets
```

```
┌─────────────────────────────────────────────────────────────┐
│ Secrets                                        [+ Add Secret]│
├─────────────────────────────────────────────────────────────┤
│ Name                  Category    Last Updated    Updated By │
│ ANTHROPIC_API_KEY     LLM         2d ago          @octocat   │
│ GITHUB_TOKEN          GitHub      5d ago          @octocat   │
│ E2B_API_KEY           Sandbox     5d ago          @janedoe   │
│ CUSTOM_WEBHOOK_URL    Custom      1w ago          @octocat   │
└─────────────────────────────────────────────────────────────┘
```

**Add/Update dialog:**

```
┌──────────────────────────────────┐
│ Add Secret                        │
│                                   │
│ Name:        [ANTHROPIC_API_KEY]  │
│ Value:       [••••••••••••••••]   │
│ Category:    [LLM           ▼]   │
│ Description: [Production key ]    │
│                                   │
│          [Cancel]  [Save]         │
└──────────────────────────────────┘
```

Values are masked in the UI. There is no "reveal" button — if you need to see the value, generate a new key at the provider and update it here.

---

## Outstanding Questions

### Security

- **Encryption key rotation**: how do we rotate `ENCRYPTION_KEY` without downtime? The re-encryption migration needs to be atomic. For v1, accept that key rotation is a manual process. Future: `key_version` column + rolling re-encryption.
- **Access control**: should `member` role be able to pull secrets, or only `admin`+`owner`? Currently members can pull (needed for `gents chat`). Should we restrict which secrets are pullable? e.g. a `pullable` flag per secret.
- **Secret leakage in logs**: agent conversations might echo secret values in tool outputs (e.g. a command that prints env vars). We can't prevent this entirely, but we should redact known secret values from task logs before storing them.
- **Transport security**: secrets are sent over HTTPS. Is TLS sufficient, or do we need an additional encryption layer (e.g. double-encryption with a per-request key)?

### Operational

- **Required secrets validation**: when a team hasn't configured `ANTHROPIC_API_KEY`, what happens? The dispatch fails with a clear error. Should the dashboard show a setup wizard on first team creation?
- **Secret templates**: for new teams, should we pre-populate the secrets list with expected names (but empty values) and descriptions? e.g. "ANTHROPIC_API_KEY — Required. Get your key at console.anthropic.com."
- **Multiple keys per provider**: can a team have multiple Anthropic keys? (e.g. one for high-priority tasks, one for background). Not for v1 — one key per name, and the name is unique per team.

### CLI

- **Pull frequency**: should secrets be pulled once per session, once per day, or every time? Once per session is the right default. But if a secret is rotated mid-session, the CLI won't pick it up.
- **Selective pull**: should `gents secrets pull --only ANTHROPIC_API_KEY` be supported? Yes, useful in CI. But auto-pull always grabs everything.
- **Offline fallback**: if the cloud is unreachable during auto-pull, should the CLI use previously pulled values? No — secrets are never cached to disk. The CLI falls back to local env vars.
