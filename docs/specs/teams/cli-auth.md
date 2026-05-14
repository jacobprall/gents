# CLI Auth Flow

**Priority: P0** — the CLI is the primary interface; it needs cloud connectivity.

Connects the local CLI to the cloud platform. Enables task sync, secret retrieval, cloud dispatch, and team context for all cloud-aware operations.

---

## Design Decisions

### Device Authorization Flow

We use a device authorization pattern (similar to `gh auth login`, `vercel login`, `fly auth login`). The CLI opens a browser, the user authenticates there, and the CLI polls for completion. This is the standard pattern for CLI tools because:

- No need to run a local HTTP server (which can conflict with firewalls)
- No need to copy/paste tokens manually
- Works in remote SSH sessions (user opens the URL in their local browser)
- The web app handles all OAuth complexity

### Credential Storage

Credentials are stored in the user's config directory following XDG conventions:

- macOS: `~/.config/gents/credentials.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/gents/credentials.json`
- Windows: `%APPDATA%\gents\credentials.json`

The file contains the API key and team context. It's readable only by the user (`0600` permissions).

### Graceful Degradation

The CLI must work without credentials. `gents chat` runs locally regardless of login state. The only things that require login are:

- `gents dispatch` (cloud execution)
- `gents secrets pull` (team secrets)
- Local run sync (summary upload to cloud)
- `gents teams`, `gents whoami`

If the user runs `gents chat` without credentials, the agent works normally. On completion, the CLI prints a hint: "Run `gents login` to sync this session to your team dashboard."

---

## Device Auth Protocol

### Sequence

```
CLI                          Web App                      GitHub
 │                              │                            │
 │  POST /api/auth/device/init  │                            │
 │ ─────────────────────────▶  │                            │
 │  { deviceCode, loginUrl,    │                            │
 │    pollToken, expiresAt }   │                            │
 │ ◀─────────────────────────  │                            │
 │                              │                            │
 │  open(loginUrl)              │                            │
 │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▶ │                            │
 │                              │  OAuth redirect            │
 │                              │ ──────────────────────────▶│
 │                              │  callback with code        │
 │                              │ ◀──────────────────────────│
 │                              │                            │
 │                              │  Show team picker          │
 │                              │  User selects team         │
 │                              │  Generate API key          │
 │                              │  Mark deviceCode complete  │
 │                              │                            │
 │  POST /api/auth/device/poll  │                            │
 │ ─────────────────────────▶  │                            │
 │  { apiKey, userId, teamId,  │                            │
 │    teamSlug, teamName,      │                            │
 │    login }                  │                            │
 │ ◀─────────────────────────  │                            │
```

### API Endpoints

**POST /api/auth/device/init** — start device auth flow

```typescript
// Request: empty body or { clientId: "gents-cli" }
// Response:
{
  deviceCode: "abc123def456",        // short code displayed to user
  loginUrl: "https://gents.example.com/auth/cli?code=abc123def456",
  pollToken: "poll_xxxxxxxx",        // CLI uses this to poll for completion
  expiresAt: "2026-05-14T01:00:00Z", // code expires in 15 minutes
  pollIntervalMs: 2000               // how often to poll
}
```

**POST /api/auth/device/poll** — check if auth is complete

```typescript
// Request:
{ pollToken: "poll_xxxxxxxx" }

// Response (pending):
{ status: "pending" }

// Response (complete):
{
  status: "complete",
  apiKey: "gnt_xxxxx...",
  userId: "user_abc",
  login: "octocat",
  teamId: "team_xyz",
  teamSlug: "acme-eng",
  teamName: "Acme Engineering"
}

// Response (expired):
{ status: "expired" }
```

**GET /auth/cli?code=xxx** — web page the user sees in the browser

This is a Next.js page, not an API route. It:

1. Shows the device code for user confirmation ("Confirm you're authorizing code `abc123`")
2. Initiates GitHub OAuth if not already logged in
3. After OAuth, shows team picker (if user belongs to multiple teams)
4. Generates an API key for the selected team
5. Marks the device code as complete
6. Shows "You can close this tab" confirmation

### Database: Device Auth Requests

```sql
CREATE TABLE device_auth_requests (
  id TEXT PRIMARY KEY,
  device_code TEXT UNIQUE NOT NULL,
  poll_token TEXT UNIQUE NOT NULL,
  user_id TEXT REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  api_key_id TEXT REFERENCES api_keys(id),
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | complete | expired
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_device_auth_poll ON device_auth_requests(poll_token) WHERE status = 'pending';
```

A background job (or TTL-based cleanup) deletes expired device auth requests.

---

## CLI Implementation

### `gents login`

```typescript
// apps/cli/src/commands/login.ts

import open from "open";

interface LoginOptions {
  apiUrl?: string;                   // override default API URL
  team?: string;                     // pre-select team by slug
  noBrowser?: boolean;               // don't auto-open browser
}

async function login(opts: LoginOptions) {
  const apiUrl = opts.apiUrl || getApiUrl();

  // Check if already logged in
  const existing = loadCredentials();
  if (existing) {
    const confirmed = await confirm(
      `Already logged in as ${existing.login} (${existing.teamSlug}). Re-authenticate?`
    );
    if (!confirmed) return;
  }

  // Initiate device auth
  const res = await fetch(`${apiUrl}/api/auth/device/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "gents-cli" }),
  });
  const { deviceCode, loginUrl, pollToken, expiresAt, pollIntervalMs } = await res.json();

  // Open browser
  if (!opts.noBrowser) {
    await open(loginUrl);
  }

  console.log(`\nOpening browser for authentication...`);
  console.log(`  → ${loginUrl}`);
  if (opts.noBrowser) {
    console.log(`\n  Open this URL in your browser to authenticate.`);
  }
  console.log(`\n  Device code: ${deviceCode}`);
  console.log(`\nWaiting for authentication...`);

  // Poll for completion
  const deadline = new Date(expiresAt).getTime();
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const pollRes = await fetch(`${apiUrl}/api/auth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollToken }),
    });
    const data = await pollRes.json();

    if (data.status === "complete") {
      saveCredentials({
        apiUrl,
        apiKey: data.apiKey,
        userId: data.userId,
        login: data.login,
        teamId: data.teamId,
        teamSlug: data.teamSlug,
        teamName: data.teamName,
      });

      console.log(`✓ Logged in as @${data.login} (${data.teamName})`);
      console.log(`  API key stored in ${getCredentialsPath()}`);
      return;
    }

    if (data.status === "expired") {
      console.error("Authentication expired. Please try again.");
      process.exit(1);
    }

    // Still pending — show a spinner dot
    process.stdout.write(".");
  }

  console.error("\nAuthentication timed out. Please try again.");
  process.exit(1);
}
```

### `gents logout`

```typescript
// apps/cli/src/commands/logout.ts

async function logout() {
  const creds = loadCredentials();
  if (!creds) {
    console.log("Not logged in.");
    return;
  }

  // Revoke the API key server-side
  try {
    await fetch(`${creds.apiUrl}/api/auth/revoke`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
    });
  } catch {
    // Best-effort — continue even if revocation fails
  }

  // Delete local credentials
  deleteCredentials();
  console.log(`Logged out. Credentials removed from ${getCredentialsPath()}`);
}
```

### `gents whoami`

```typescript
// apps/cli/src/commands/whoami.ts

async function whoami() {
  const creds = loadCredentials();
  if (!creds) {
    console.log("Not logged in. Run `gents login` to authenticate.");
    return;
  }

  // Verify the key is still valid
  try {
    const res = await fetch(`${creds.apiUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    if (!res.ok) {
      console.log("Session expired. Run `gents login` to re-authenticate.");
      return;
    }
    const data = await res.json();
    console.log(`User:  @${data.login} (${data.name})`);
    console.log(`Team:  ${data.teamName} (${data.teamSlug})`);
    console.log(`API:   ${creds.apiUrl}`);
  } catch (err) {
    console.log(`Cannot reach ${creds.apiUrl}. Run \`gents login\` if your API URL has changed.`);
  }
}
```

### `gents teams` and `gents teams switch`

```typescript
// apps/cli/src/commands/teams.ts

async function listTeams() {
  const creds = requireCredentials();
  const res = await fetch(`${creds.apiUrl}/api/teams`, {
    headers: { Authorization: `Bearer ${creds.apiKey}` },
  });
  const teams = await res.json();

  for (const team of teams) {
    const marker = team.id === creds.teamId ? " ← active" : "";
    console.log(`  ${team.slug}  ${team.name}${marker}`);
  }
}

async function switchTeam(slug: string) {
  const creds = requireCredentials();

  // Verify membership
  const res = await fetch(`${creds.apiUrl}/api/teams/${slug}`, {
    headers: { Authorization: `Bearer ${creds.apiKey}` },
  });
  if (!res.ok) {
    console.error(`Team "${slug}" not found or you're not a member.`);
    process.exit(1);
  }

  const team = await res.json();

  // Generate a new API key scoped to this team
  const keyRes = await fetch(`${creds.apiUrl}/api/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      "Content-Type": "application/json",
      "x-team-id": team.id,
    },
    body: JSON.stringify({ name: `cli-${hostname()}` }),
  });
  const { key } = await keyRes.json();

  // Revoke old key
  try {
    await fetch(`${creds.apiUrl}/api/auth/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
  } catch {}

  saveCredentials({
    ...creds,
    apiKey: key,
    teamId: team.id,
    teamSlug: team.slug,
    teamName: team.name,
  });

  console.log(`Switched to team: ${team.name} (${team.slug})`);
}
```

---

## Credential Storage

### File Format

```typescript
// apps/cli/src/credentials.ts

interface StoredCredentials {
  version: 1;                        // format version for future migration
  apiUrl: string;                    // e.g. "https://gents.example.com"
  apiKey: string;                    // gnt_...
  userId: string;
  login: string;                     // GitHub username
  teamId: string;
  teamSlug: string;
  teamName: string;
  createdAt: string;                 // ISO timestamp of when login happened
}
```

### File Location

```typescript
import { homedir } from "os";
import { join } from "path";

function getCredentialsPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || join(homedir(), ".config");
  return join(base, "gents", "credentials.json");
}
```

### Security

- File permissions set to `0600` (owner read/write only) on creation
- Never logged, printed in full, or included in error reports
- The `apiKey` value is the only sensitive field; everything else is metadata
- `gents doctor` checks file permissions and warns if too permissive

```typescript
import { chmodSync, writeFileSync, mkdirSync } from "fs";

function saveCredentials(creds: StoredCredentials): void {
  const path = getCredentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
}
```

---

## Environment Variable Override

For CI/CD and non-interactive environments, credentials can be set via environment variables:

```bash
export GENTS_API_KEY="gnt_xxxxx..."
export GENTS_API_URL="https://gents.example.com"   # optional, defaults to production
export GENTS_TEAM_ID="team_xyz"                     # optional if key is team-scoped
```

The CLI checks env vars first, then falls back to the credentials file:

```typescript
function loadCredentials(): StoredCredentials | null {
  // Env vars take precedence
  if (process.env.GENTS_API_KEY) {
    return {
      version: 1,
      apiUrl: process.env.GENTS_API_URL || DEFAULT_API_URL,
      apiKey: process.env.GENTS_API_KEY,
      userId: "",
      login: "",
      teamId: process.env.GENTS_TEAM_ID || "",
      teamSlug: "",
      teamName: "",
      createdAt: "",
    };
  }

  // Fall back to file
  const path = getCredentialsPath();
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
```

---

## API URL Resolution

The CLI needs to know where the cloud API lives. Resolution order:

1. `--api-url` flag on any command
2. `GENTS_API_URL` environment variable
3. `apiUrl` from stored credentials
4. Default: `https://app.gents.dev` (production)

```typescript
function getApiUrl(flagValue?: string): string {
  return flagValue
    || process.env.GENTS_API_URL
    || loadCredentials()?.apiUrl
    || "https://app.gents.dev";
}
```

For local development: `GENTS_API_URL=http://localhost:3000 gents login`.

---

## Integration with `gents chat`

After login, `gents chat` gains cloud awareness:

### Before chat starts

1. If logged in and `allowLocalRuns` is true in team settings:
   - Pull team secrets (`ANTHROPIC_API_KEY`, etc.) if not set locally
   - Fetch the team's default blueprint if no local blueprint is specified
2. If not logged in:
   - Use local env vars and local blueprints as today

### After chat ends

1. If logged in:
   - Build a `LocalRunSummary` from the session's metrics
   - POST to `/api/tasks` with `origin: "cli"`
   - On failure: queue summary in `~/.config/gents/pending-sync.jsonl` for retry on next run
2. If not logged in:
   - Print hint: "Run `gents login` to sync sessions to your team."

### The `--no-sync` Flag

For users who want local mode without cloud sync:

```
gents chat --no-sync
```

Suppresses both pre-chat secret pull and post-chat summary sync.

---

## Outstanding Questions

### Protocol

- **Polling interval**: 2 seconds is standard. But should we support long-polling or WebSocket for a snappier experience?
- **Code format**: short numeric code (e.g. `1234-5678`) for easy verbal communication, or alphanumeric? Numeric is easier to read aloud in pair programming.
- **Rate limiting**: how do we prevent poll abuse? Limit by IP + pollToken. Max 30 attempts per pollToken.

### Security

- **Token lifetime**: should CLI API keys expire? If so, auto-refresh? GitHub CLI tokens don't expire. Render CLI tokens expire after 90 days. We could match the Render pattern since we're deploying there.
- **Key revocation propagation**: when a key is revoked (via dashboard or `gents logout`), the CLI should detect this on next use and prompt re-login. How? A 401 response triggers a "session expired" message.
- **Credential encryption**: should the credentials file be encrypted at rest? Most CLI tools (gh, aws, gcloud) store plaintext with file permissions. Encryption adds complexity with minimal benefit since the attacker already has filesystem access.

### UX

- **First-run experience**: if a user runs `gents chat` for the first time without logging in, should we prompt for login? Or silently run in local-only mode?
- **Team selection UX**: if the user belongs to 5 teams, the browser team picker needs to be clean. Show org avatar + name, highlight the most recently active team.
- **Stale credentials**: how do we detect and surface stale credentials gracefully? If the API URL is unreachable, don't block the local experience.

### CI/CD Patterns

- **GitHub Actions**: provide a `setup-gents` action that installs the CLI and configures `GENTS_API_KEY` from a secret.
- **Multiple environments**: CI might dispatch to a staging team vs. production team. Support `GENTS_TEAM_ID` override without re-login.
- **Service accounts**: should there be a "bot" user type for CI, separate from human users? Or just use a regular user + API key? Regular user + key is simpler for v1.
