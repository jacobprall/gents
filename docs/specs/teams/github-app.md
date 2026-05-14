# GitHub App Integration

**Priority: P1** — required for org-wide webhook routing and secure token management.

A GitHub App replaces personal tokens for org-wide access. It provides installation-scoped tokens (short-lived, auto-rotated), finer-grained permissions, higher rate limits, and centralized webhook delivery.

---

## Design Decisions

### GitHub App vs. GitHub OAuth App

We need **both**, for different purposes:

| | GitHub OAuth App | GitHub App |
|---|---|---|
| **Purpose** | User authentication (login) | Org-wide repo access |
| **Token scope** | User's permissions | Installation's permissions |
| **Token lifetime** | Long-lived (until revoked) | 1 hour (auto-rotated) |
| **Webhook delivery** | Per-repo manual setup | Centralized, per-installation |
| **Rate limit** | 5,000/hr per user | 5,000/hr per installation |
| **Setup** | Users click "Login with GitHub" | Org admin installs on the org |

The OAuth App is set up once for the gents platform (for user login). The GitHub App is installed per-org/team and gives gents access to repos.

### Installation Token Strategy

Instead of storing a long-lived `GITHUB_TOKEN` in the secrets vault, we generate short-lived installation tokens on demand:

- Tokens are valid for 1 hour
- They're scoped to the repos the App has access to
- They're generated fresh for each task dispatch
- No long-lived credentials to leak or rotate

Teams can still store a personal `GITHUB_TOKEN` in secrets as a fallback (e.g. for repos not covered by the App installation).

---

## GitHub App Configuration

### App Manifest

The gents GitHub App needs these permissions and events:

**Repository permissions:**

| Permission | Level | Reason |
|---|---|---|
| Contents | Read & Write | Clone repos, push branches |
| Pull requests | Read & Write | Create PRs, read PR diffs |
| Issues | Read & Write | Read issue context, post comments |
| Checks | Read & Write | Report task status as check runs |
| Metadata | Read | Required for all apps |
| Webhooks | Read | Receive push, PR, issue events |

**Organization permissions:**

| Permission | Level | Reason |
|---|---|---|
| Members | Read | Sync org membership to team |

**Events subscribed:**

| Event | Reason |
|---|---|
| `push` | Trigger tasks on code push |
| `pull_request` | Trigger tasks on PR open/update |
| `issues` | Trigger tasks on issue creation/labeling |
| `issue_comment` | Trigger tasks on PR/issue comments |
| `installation` | Track app install/uninstall |
| `installation_repositories` | Track repo add/remove |
| `organization` | Track member add/remove |

### App Registration

The GitHub App is registered once for the gents platform:

```
App name:         gents-agent
Homepage URL:     https://gents.example.com
Callback URL:     https://gents.example.com/api/github/callback
Setup URL:        https://gents.example.com/api/github/setup
Webhook URL:      https://gents.example.com/api/webhooks/github
Webhook secret:   (generated, stored as GITHUB_WEBHOOK_SECRET)
```

The App's private key and App ID are stored as platform-level env vars (not per-team secrets):

```bash
GITHUB_APP_ID=12345
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GITHUB_WEBHOOK_SECRET=whsec_xxx
```

---

## Data Model

### GitHub Installation

```typescript
// services/github/src/types.ts

export interface GitHubInstallation {
  id: string;                        // our internal ID
  teamId: string;
  installationId: number;            // GitHub's installation ID
  githubOrgLogin: string;
  accountType: "Organization" | "User";
  repos: "all" | string[];           // which repos the app can access
  permissions: Record<string, string>;
  suspendedAt?: Date;                // set if the installation is suspended
  createdAt: Date;
  updatedAt: Date;
}
```

### Database Schema

```sql
-- migrations/006_github_app.sql

CREATE TABLE github_installations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  installation_id INTEGER UNIQUE NOT NULL,
  github_org_login TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'Organization',
  repos JSONB DEFAULT '"all"'::jsonb,      -- "all" or ["repo1", "repo2"]
  permissions JSONB DEFAULT '{}'::jsonb,
  suspended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_github_installations_team ON github_installations(team_id);

-- Cache short-lived installation tokens
CREATE TABLE github_token_cache (
  installation_id INTEGER PRIMARY KEY REFERENCES github_installations(installation_id),
  token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Installation Flow

### Step 1: Team Admin Initiates Install

In the dashboard: **Settings → GitHub → Connect GitHub**

```typescript
// apps/web/src/app/api/github/install/route.ts

export async function GET(request: Request) {
  const { user, teamId } = await withTeamAuth(request);
  const member = await teamsService.getMember(teamId, user.id);
  requireRole(member!, "owner", "admin");

  // Redirect to GitHub App installation page
  // state param encodes our teamId for the callback
  const state = encodeState({ teamId, userId: user.id });
  const installUrl = `https://github.com/apps/gents-agent/installations/new?state=${state}`;

  return Response.redirect(installUrl);
}
```

### Step 2: User Installs on GitHub

GitHub shows the installation UI. The user selects:
- Which org to install on
- All repos or specific repos
- Confirms permissions

### Step 3: GitHub Sends Installation Webhook

```typescript
// apps/web/src/app/api/webhooks/github/route.ts — installation handler

async function handleInstallationEvent(event: GitHubWebhookEvent): Promise<Response> {
  const action = event.action;
  const installation = event.payload.installation;

  switch (action) {
    case "created": {
      // New installation — link to team
      const state = decodeState(event.payload.installation.app_slug);
      // Or: match by org login to the team's githubOrgLogin
      const team = await teamsService.getByGitHubOrg(installation.account.login);
      if (!team) {
        // No team linked to this org — store as pending
        return Response.json({ ok: true, pending: true });
      }

      await githubService.createInstallation({
        teamId: team.id,
        installationId: installation.id,
        githubOrgLogin: installation.account.login,
        accountType: installation.account.type,
        repos: installation.repository_selection === "all" ? "all" : [],
        permissions: installation.permissions,
      });

      return Response.json({ ok: true });
    }

    case "deleted": {
      await githubService.deleteInstallation(installation.id);
      return Response.json({ ok: true });
    }

    case "suspend": {
      await githubService.suspendInstallation(installation.id);
      return Response.json({ ok: true });
    }

    case "unsuspend": {
      await githubService.unsuspendInstallation(installation.id);
      return Response.json({ ok: true });
    }
  }

  return Response.json({ ok: true });
}
```

### Step 4: GitHub Redirects Back (Setup URL)

```typescript
// apps/web/src/app/api/github/setup/route.ts

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const installationId = searchParams.get("installation_id");
  const setupAction = searchParams.get("setup_action"); // "install" | "update"

  // Redirect to team settings with a success message
  const installation = await githubService.getByInstallationId(parseInt(installationId!));
  if (installation) {
    return Response.redirect(
      `/t/${installation.teamSlug}/settings/github?installed=true`
    );
  }

  return Response.redirect("/settings?github_install=pending");
}
```

---

## Token Generation

### JWT for App Authentication

To generate installation tokens, we first authenticate as the App using a JWT:

```typescript
// services/github/src/app.ts

import { createPrivateKey, sign } from "crypto";

export class GitHubAppService {
  private appId: string;
  private privateKey: string;

  constructor(config: { appId: string; privateKey: string }) {
    this.appId = config.appId;
    this.privateKey = config.privateKey;
  }

  private generateJWT(): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60,               // 60 seconds in the past (clock skew)
      exp: now + 600,              // 10 minutes
      iss: this.appId,
    };
    // Sign with RS256 using the App's private key
    return signJWT(payload, this.privateKey);
  }

  async getInstallationToken(
    installationId: number,
    opts?: { repositories?: string[]; permissions?: Record<string, string> }
  ): Promise<{ token: string; expiresAt: Date }> {
    const jwt = this.generateJWT();

    const body: Record<string, unknown> = {};
    if (opts?.repositories) body.repositories = opts.repositories;
    if (opts?.permissions) body.permissions = opts.permissions;

    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
        },
        body: Object.keys(body).length ? JSON.stringify(body) : undefined,
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to create installation token: ${res.status} ${err}`);
    }

    const data = await res.json();
    return {
      token: data.token,
      expiresAt: new Date(data.expires_at),
    };
  }
}
```

### Token Caching

Installation tokens are valid for 1 hour. We cache them to avoid generating a new token for every API call:

```typescript
// services/github/src/token-cache.ts

export class TokenCache {
  constructor(private pool: Pool, private appService: GitHubAppService) {}

  async getToken(installationId: number): Promise<string> {
    // Check cache
    const cached = await this.pool.query(
      `SELECT token, expires_at FROM github_token_cache
       WHERE installation_id = $1 AND expires_at > NOW() + INTERVAL '5 minutes'`,
      [installationId]
    );

    if (cached.rows.length) return cached.rows[0].token;

    // Generate new token
    const { token, expiresAt } = await this.appService.getInstallationToken(installationId);

    // Cache it
    await this.pool.query(
      `INSERT INTO github_token_cache (installation_id, token, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (installation_id)
       DO UPDATE SET token = $2, expires_at = $3`,
      [installationId, token, expiresAt]
    );

    return token;
  }
}
```

### Integration with Dispatch

When dispatching a task, the dispatcher uses the installation token instead of a static secret:

```typescript
// In TaskDispatcher.dispatch() — updated

// Try GitHub App token first, fall back to secrets vault
let githubToken: string;
const installation = await githubService.getInstallationForRepo(input.teamId, input.repo);
if (installation) {
  githubToken = await tokenCache.getToken(installation.installationId);
} else {
  githubToken = await secretsService.getValue(input.teamId, "GITHUB_TOKEN") || "";
  if (!githubToken) {
    throw new MissingSecretError(
      "No GitHub access configured. Install the GitHub App or add a GITHUB_TOKEN secret."
    );
  }
}
```

---

## Webhook Routing (Team-Scoped)

With the GitHub App, all webhooks arrive at a single endpoint. The handler resolves the team from the installation ID:

```typescript
// apps/web/src/app/api/webhooks/github/route.ts — updated

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256") || "";

  if (!verifyWebhookSignature(body, signature, process.env.GITHUB_WEBHOOK_SECRET!)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = parseWebhookEvent(request.headers, body);

  // Handle installation lifecycle events
  if (event.event === "installation") {
    return handleInstallationEvent(event);
  }
  if (event.event === "installation_repositories") {
    return handleRepoChange(event);
  }

  // For all other events: resolve team from installation
  const installationId = (event.payload as any).installation?.id;
  if (!installationId) {
    return Response.json({ ok: true, skipped: "no installation context" });
  }

  const installation = await githubService.getByInstallationId(installationId);
  if (!installation) {
    return Response.json({ ok: true, skipped: "unknown installation" });
  }

  if (installation.suspendedAt) {
    return Response.json({ ok: true, skipped: "installation suspended" });
  }

  // Ignore bot events to prevent loops
  if (event.sender.login.endsWith("[bot]")) {
    return Response.json({ ok: true, skipped: "bot event" });
  }

  // Match routing rules for this team
  const rules = await taskRepo.listRoutingRules({
    teamId: installation.teamId,
    enabled: true,
  });

  const matchedRules = findMatchingRules(event, rules);
  const dispatched: string[] = [];

  for (const rule of matchedRules) {
    try {
      const token = await tokenCache.getToken(installation.installationId);
      const task = await taskDispatcher.dispatch({
        teamId: installation.teamId,
        repo: event.repository.clone_url,
        ref: event.ref || extractRef(event),
        blueprint: rule.blueprint,
        instructions: resolveInstructions(rule.instructions, event),
        origin: "webhook",
        originDetail: `webhook#${event.delivery}`,
        githubToken: token,
      });
      dispatched.push(task.id);
    } catch (err) {
      console.error(`Failed to dispatch for rule ${rule.id}:`, err);
    }
  }

  return Response.json({
    ok: true,
    team: installation.teamId,
    event: `${event.event}.${event.action || ""}`,
    rulesMatched: matchedRules.length,
    tasksDispatched: dispatched,
  });
}
```

---

## Dashboard: GitHub Settings

### Settings → GitHub Page

```
/t/:teamSlug/settings/github
```

**Connected state:**

```
┌─────────────────────────────────────────────────────────────┐
│ GitHub Integration                                           │
│                                                              │
│ ✓ Connected to acme-corp                                     │
│   Installed by @octocat on May 10, 2026                      │
│   Access: All repositories                                   │
│                                                              │
│   [Manage on GitHub]  [Disconnect]                           │
│                                                              │
│ Webhook Activity (last 24h):                                 │
│   12 events received · 8 tasks dispatched · 0 errors         │
└─────────────────────────────────────────────────────────────┘
```

**Not connected state:**

```
┌─────────────────────────────────────────────────────────────┐
│ GitHub Integration                                           │
│                                                              │
│ Connect your GitHub organization to enable:                  │
│   • Automatic webhook routing                                │
│   • Short-lived, auto-rotated tokens                         │
│   • Org membership sync                                      │
│                                                              │
│   [Connect GitHub]                                           │
│                                                              │
│ Or add a personal GITHUB_TOKEN in Secrets for basic access.  │
└─────────────────────────────────────────────────────────────┘
```

---

## Outstanding Questions

### Setup

- **Multiple installations**: can a team have multiple GitHub App installations (e.g. across two orgs)? The schema supports it (multiple rows in `github_installations` per `team_id`). But the routing logic needs to handle overlapping repos.
- **Personal installations**: can an individual install the App on their personal GitHub account (not an org)? The App supports `User` account type, but it's less common. Allow it but document that org installation is preferred.
- **Installation discovery**: when a team is created from a GitHub org, should we auto-detect if the App is already installed? Yes — check via the App API on team creation.

### Security

- **Private key storage**: the App's RSA private key is the most sensitive credential in the system. It's stored as a platform env var, not in the secrets vault (which uses a different encryption key). For production, consider a KMS (AWS KMS, GCP KMS, Render's secret management).
- **Token scope narrowing**: when generating an installation token for a specific task, should we narrow the token's repo scope to just the repo being worked on? Yes — pass `repositories: ["acme/api"]` to reduce blast radius.
- **Webhook signature**: the webhook secret is shared across all installations. If it's compromised, an attacker can forge webhooks. Consider per-installation webhook secrets (GitHub supports this).

### Reliability

- **Token generation failures**: if GitHub's API is down when we try to generate a token, the task dispatch fails. Should we fall back to a `GITHUB_TOKEN` from the secrets vault? Yes — this is already the fallback path.
- **Installation sync**: when repos are added/removed from the installation, we receive `installation_repositories` events. But these events can be delayed or lost. Should we periodically sync the repo list?
- **Rate limits across tasks**: if the team dispatches 10 tasks simultaneously against the same installation, they share the 5,000 req/hr rate limit. Do we need a rate limiter in front of GitHub API calls? Not for v1 — agent tasks don't make that many GitHub API calls.
