# Team/Org Model + Membership

**Priority: P0** — nothing else works without this.

The team is the fundamental unit of multi-user collaboration in gents. It owns tasks, routing rules, blueprints, API keys, secrets, and billing. Every cloud query is scoped to a team.

---

## Design Decisions

### GitHub Org Alignment (Primary, Not Exclusive)

The happy path: a team maps 1:1 to a GitHub org. This is natural because gents is code-centric — the repos the agent works on live in a GitHub org, and the people who use gents are members of that org.

But it's not a hard lock:

- **Teams can exist without a GitHub org.** A freelancer or a small group without a GitHub org can create a standalone team with manual membership.
- **Auth providers are pluggable.** The `AuthProvider` interface abstracts org-membership checks. GitHub is the first implementation; GitLab, Bitbucket, or SAML can follow.
- **Membership can be hybrid.** A GitHub-linked team can also invite members by email who aren't in the GitHub org (e.g. a contractor or cross-team collaborator).

### Why Not Just Use GitHub Org Directly?

We need our own `teams` table because:

1. **Gents-specific data**: budgets, secrets, routing rules, notification config don't map to any GitHub entity.
2. **Provider independence**: if a team switches from GitHub to GitLab, their gents config survives.
3. **Multiple orgs**: an enterprise might want a single gents team spanning repos across two GitHub orgs.
4. **Personal teams**: individual developers get a team of one, even without a GitHub org.

---

## Data Model

### Team

```typescript
// services/teams/src/types.ts

export interface Team {
  id: string;                        // UUIDv7
  name: string;                      // display name, e.g. "Acme Engineering"
  slug: string;                      // URL-safe, unique, e.g. "acme-eng"
  plan: TeamPlan;                    // "free" | "pro" | "enterprise" (future)
  githubOrgId?: string;              // linked GitHub org numeric ID
  githubOrgLogin?: string;           // e.g. "acme-corp"
  avatarUrl?: string;                // from GitHub org, or uploaded
  settings: TeamSettings;
  createdAt: Date;
  updatedAt: Date;
}

export type TeamPlan = "free" | "pro" | "enterprise";

export interface TeamSettings {
  defaultBlueprint?: string;         // name of the default blueprint
  defaultMaxTurns?: number;
  defaultMaxCostUsd?: number;
  defaultTimeoutMinutes?: number;
  allowLocalRuns?: boolean;          // whether CLI local mode syncs are accepted
  requireApprovalForWebhookTasks?: boolean;
}
```

### Team Member

```typescript
export type MemberRole = "owner" | "admin" | "member";

export interface TeamMember {
  teamId: string;
  userId: string;
  role: MemberRole;
  joinedAt: Date;
  invitedBy?: string;                // user ID of who invited them

  // Denormalized for display (populated on read, not stored)
  user?: User;
}
```

### Team Invite

```typescript
export interface TeamInvite {
  id: string;                        // UUIDv7
  teamId: string;
  email?: string;                    // invite by email
  githubLogin?: string;              // invite by GitHub username
  role: MemberRole;
  invitedBy: string;                 // user ID
  expiresAt: Date;                   // default: 7 days from creation
  acceptedAt?: Date;
  declinedAt?: Date;
  createdAt: Date;
}
```

### User ↔ Team Relationship

A user can belong to multiple teams. They have a "current team" context that determines which team's data they see and interact with.

```typescript
// Stored in the user's session/preferences, not in the teams table
export interface UserTeamContext {
  userId: string;
  currentTeamId: string;             // their active team
  lastSwitchedAt: Date;
}
```

---

## Auth Provider Interface

```typescript
// services/auth/src/provider.ts

export interface AuthProvider {
  id: string;                        // "github", "gitlab", "google", etc.
  displayName: string;
  iconUrl?: string;

  // User identity
  getUser(accessToken: string): Promise<ProviderUser | null>;

  // Org/group membership (for team alignment)
  listOrgs(accessToken: string): Promise<ProviderOrg[]>;
  getOrgMembership(accessToken: string, orgId: string): Promise<OrgMembership | null>;
  listOrgMembers(accessToken: string, orgId: string): Promise<ProviderUser[]>;
}

export interface ProviderUser {
  providerId: string;                // provider-specific user ID
  providerType: string;              // "github", "gitlab", etc.
  login: string;                     // unique username at the provider
  name: string;
  email: string;
  avatarUrl?: string;
}

export interface ProviderOrg {
  id: string;                        // provider-specific org ID
  login: string;                     // org slug/name at the provider
  displayName: string;
  avatarUrl?: string;
  role: "owner" | "admin" | "member";
}

export interface OrgMembership {
  orgId: string;
  orgLogin: string;
  role: "owner" | "admin" | "member";
  isActive: boolean;
}
```

### GitHub Provider Implementation

```typescript
// services/auth/src/providers/github.ts

import { Octokit } from "@octokit/rest";

export class GitHubAuthProvider implements AuthProvider {
  id = "github";
  displayName = "GitHub";

  async getUser(accessToken: string): Promise<ProviderUser | null> {
    const octokit = new Octokit({ auth: accessToken });
    const { data } = await octokit.users.getAuthenticated();
    return {
      providerId: String(data.id),
      providerType: "github",
      login: data.login,
      name: data.name || data.login,
      email: data.email || "",
      avatarUrl: data.avatar_url,
    };
  }

  async listOrgs(accessToken: string): Promise<ProviderOrg[]> {
    const octokit = new Octokit({ auth: accessToken });
    const orgs = await octokit.paginate(octokit.orgs.listForAuthenticatedUser);
    return orgs.map(org => ({
      id: String(org.id),
      login: org.login,
      displayName: org.description || org.login,
      avatarUrl: org.avatar_url,
      role: "member", // GitHub doesn't return role in this endpoint
    }));
  }

  async getOrgMembership(accessToken: string, orgId: string): Promise<OrgMembership | null> {
    const octokit = new Octokit({ auth: accessToken });
    try {
      const { data } = await octokit.orgs.getMembershipForAuthenticatedUser({
        org: orgId,
      });
      return {
        orgId,
        orgLogin: data.organization.login,
        role: data.role === "admin" ? "owner" : "member",
        isActive: data.state === "active",
      };
    } catch {
      return null;
    }
  }

  async listOrgMembers(accessToken: string, orgId: string): Promise<ProviderUser[]> {
    const octokit = new Octokit({ auth: accessToken });
    const members = await octokit.paginate(octokit.orgs.listMembers, { org: orgId });
    return members.map(m => ({
      providerId: String(m.id),
      providerType: "github",
      login: m.login,
      name: m.login,
      email: "",
      avatarUrl: m.avatar_url,
    }));
  }
}
```

### Provider Registry

The `AuthService` maintains a map of registered providers:

```typescript
export class AuthServiceImpl implements AuthService {
  private providers = new Map<string, AuthProvider>();

  registerProvider(provider: AuthProvider): void {
    this.providers.set(provider.id, provider);
  }

  getProvider(id: string): AuthProvider | null {
    return this.providers.get(id) || null;
  }

  listProviders(): AuthProvider[] {
    return Array.from(this.providers.values());
  }
}
```

At startup, the web app registers available providers:

```typescript
// apps/web/src/lib/services.ts
authService.registerProvider(new GitHubAuthProvider());
// Future: authService.registerProvider(new GitLabAuthProvider());
```

---

## Team Lifecycle

### Creation

**From GitHub org (happy path):**

1. User clicks "Create Team" on dashboard
2. OAuth check: do they have a valid GitHub token? If not, re-auth.
3. Fetch their GitHub orgs via `listOrgs()`
4. User picks an org
5. We create the team with `githubOrgId` and `githubOrgLogin`
6. Creator becomes owner
7. Optionally: bulk-import existing org members (confirm dialog)

**Standalone (no GitHub org):**

1. User clicks "Create Team" → "Create without GitHub"
2. Provide name and slug
3. Creator becomes owner
4. Invite members manually

**Personal team (auto-created):**

On first login, if the user has no teams, we auto-create a personal team:
- `name`: user's display name
- `slug`: user's GitHub login (e.g. `octocat`)
- `githubOrgId`: null
- Single owner, no invites needed

This ensures every user has a team context immediately, with zero setup.

### Slug Generation

Team slugs are URL-safe identifiers used in API paths and the dashboard URL:

```
https://gents.example.com/t/acme-eng/tasks
                            ^^^^^^^^
```

Rules:
- Lowercase alphanumeric + hyphens
- 3–40 characters
- Unique across all teams
- For GitHub-linked teams, default to the org login
- User can override at creation time

```typescript
function generateSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
```

### Membership Sync (GitHub-linked teams)

For teams linked to a GitHub org, membership should stay roughly in sync. Three strategies, used together:

**On login**: when a member logs in, check their GitHub org membership. If they've been removed from the org, remove them from the team (or flag for review).

**On GitHub App webhook**: if the team has a GitHub App installed, we receive `organization.member_added` and `organization.member_removed` events. Apply immediately.

**Manual sync button**: team admins can click "Sync with GitHub" in settings to force a full membership reconciliation.

```typescript
// services/teams/src/sync.ts

export async function syncGitHubMembership(
  teamsService: TeamsService,
  authProvider: AuthProvider,
  team: Team,
  adminToken: string,
): Promise<SyncResult> {
  if (!team.githubOrgId) return { added: 0, removed: 0, errors: [] };

  const githubMembers = await authProvider.listOrgMembers(adminToken, team.githubOrgLogin!);
  const currentMembers = await teamsService.listMembers(team.id);

  const githubLogins = new Set(githubMembers.map(m => m.login));
  const currentLogins = new Map(
    currentMembers.map(m => [m.user?.githubLogin, m])
  );

  const toAdd = githubMembers.filter(m => !currentLogins.has(m.login));
  const toRemove = currentMembers.filter(
    m => m.user?.githubLogin && !githubLogins.has(m.user.githubLogin) && m.role !== "owner"
  );

  // Don't remove owners — that requires explicit action
  // Don't auto-add — create invites instead (or add directly based on team settings)

  return { added: toAdd.length, removed: toRemove.length, errors: [] };
}
```

### Deletion

Soft delete for safety. Deleted teams are marked with a `deletedAt` timestamp and hidden from queries. After a grace period (30 days), a background job hard-deletes the team and cascades to all owned resources.

```sql
ALTER TABLE teams ADD COLUMN deleted_at TIMESTAMPTZ;
```

What happens when a team is deleted:
- Tasks are preserved for the grace period (visible to owner only)
- API keys are immediately revoked
- Secrets are immediately wiped
- Routing rules are disabled
- Active tasks are cancelled
- Audit log is preserved (never deleted with the team)

---

## Scoping

### The Pattern

Every service method that touches team-owned data takes `teamId` as the first parameter:

```typescript
// Before (single-user)
async getById(taskId: string): Promise<Task | null>;

// After (multi-team)
async getById(teamId: string, taskId: string): Promise<Task | null>;
```

This is verbose but safe — it's impossible to accidentally query across teams. The web app resolves `teamId` from the session once (in middleware) and passes it through.

### Middleware

```typescript
// apps/web/src/lib/api-helpers.ts

export async function withTeamAuth(request: Request): Promise<{ user: User; teamId: string }> {
  const user = await withAuth(request);

  // API keys carry the team scope
  const teamId = request.headers.get("x-team-id")
    || user.currentTeamId
    || (await getDefaultTeamId(user.id));

  if (!teamId) throw new ApiError("No team context", 400);

  // Verify membership
  const member = await teamsService.getMember(teamId, user.id);
  if (!member) throw new ApiError("Not a member of this team", 403);

  return { user, teamId };
}
```

### API Key Scoping

When a CLI user authenticates with an API key, the key carries the team context. No need for an `x-team-id` header.

```typescript
export interface ApiKey {
  // ... existing fields ...
  teamId: string;                    // the team this key belongs to
}
```

When verifying a key:

```typescript
async verifyApiKey(key: string): Promise<{ user: User; teamId: string } | null> {
  const hash = hashApiKey(key);
  const result = await this.pool.query(
    `SELECT u.*, k.team_id FROM api_keys k
     JOIN users u ON u.id = k.user_id
     WHERE k.hash = $1`,
    [hash]
  );
  if (!result.rows.length) return null;
  return {
    user: mapUserRow(result.rows[0]),
    teamId: result.rows[0].team_id,
  };
}
```

---

## Roles & Permissions

### Role Matrix

Three roles. No custom policies for v1.

| Action | Owner | Admin | Member |
|---|---|---|---|
| **Tasks** | | | |
| View tasks, logs, conversations | Yes | Yes | Yes |
| Create tasks (CLI, dashboard) | Yes | Yes | Yes |
| Cancel running tasks | Yes | Yes | Own tasks only |
| Send steering messages | Yes | Yes | Yes |
| **Configuration** | | | |
| Manage routing rules | Yes | Yes | No |
| Manage blueprints | Yes | Yes | No |
| Manage secrets | Yes | Yes | No |
| View secrets (names only) | Yes | Yes | Yes |
| **API Keys** | | | |
| Create own API keys | Yes | Yes | Yes |
| Revoke own API keys | Yes | Yes | Yes |
| Revoke others' API keys | Yes | Yes | No |
| **Team Management** | | | |
| Invite members | Yes | Yes | No |
| Remove members | Yes | Yes (not owners) | No |
| Change member roles | Yes | No | No |
| Update team settings | Yes | Yes | No |
| Delete team | Yes | No | No |
| Transfer ownership | Yes | No | No |
| **Billing** | | | |
| View spend reports | Yes | Yes | Own spend only |
| Set budgets | Yes | Yes | No |
| **Audit** | | | |
| View audit log | Yes | Yes | No |
| Export audit log | Yes | No | No |

### Enforcement

Role checks happen in API route handlers, not in services. Services are role-agnostic — they do what they're told. The API layer checks permissions before calling the service.

```typescript
// apps/web/src/lib/api-helpers.ts

export function requireRole(member: TeamMember, ...roles: MemberRole[]): void {
  if (!roles.includes(member.role)) {
    throw new ApiError("Insufficient permissions", 403);
  }
}

// Usage in a route handler:
export async function DELETE(request: Request, { params }: { params: { slug: string; id: string } }) {
  const { user, teamId } = await withTeamAuth(request);
  const member = await teamsService.getMember(teamId, user.id);
  requireRole(member!, "owner", "admin");
  // ... proceed with deletion
}
```

### Future: Custom Roles

If teams need more granularity later, we can add a `permissions` JSONB column to `team_members` that overrides the role defaults. But this is overkill for v1.

---

## Database Schema

```sql
-- migrations/003_teams.sql

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  github_org_id TEXT UNIQUE,
  github_org_login TEXT,
  avatar_url TEXT,
  settings JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_teams_slug ON teams(slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_teams_github_org ON teams(github_org_id) WHERE deleted_at IS NULL;

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT REFERENCES users(id),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX idx_team_members_user ON team_members(user_id);

CREATE TABLE team_invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT,
  github_login TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_team_invites_pending_email ON team_invites(email) WHERE accepted_at IS NULL AND declined_at IS NULL;
CREATE INDEX idx_team_invites_pending_github ON team_invites(github_login) WHERE accepted_at IS NULL AND declined_at IS NULL;
CREATE INDEX idx_team_invites_team ON team_invites(team_id);

-- Add team_id to existing tables
ALTER TABLE tasks ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE routing_rules ADD COLUMN team_id TEXT REFERENCES teams(id);
ALTER TABLE api_keys ADD COLUMN team_id TEXT REFERENCES teams(id);

CREATE INDEX idx_tasks_team ON tasks(team_id);
CREATE INDEX idx_routing_rules_team ON routing_rules(team_id);
CREATE INDEX idx_api_keys_team ON api_keys(team_id);

-- User's current team preference
ALTER TABLE users ADD COLUMN current_team_id TEXT REFERENCES teams(id);
```

---

## API Routes

```
POST   /api/teams                        # create team
GET    /api/teams                        # list user's teams
GET    /api/teams/:slug                  # team detail
PATCH  /api/teams/:slug                  # update team name, settings, avatar
DELETE /api/teams/:slug                  # soft-delete team (owner only)

GET    /api/teams/:slug/members          # list members (with user details)
POST   /api/teams/:slug/members          # add member directly (admin) or accept invite
PATCH  /api/teams/:slug/members/:userId  # change role
DELETE /api/teams/:slug/members/:userId  # remove member

POST   /api/teams/:slug/invites          # invite by email or GitHub login
GET    /api/teams/:slug/invites          # list pending invites
DELETE /api/teams/:slug/invites/:id      # revoke invite
POST   /api/teams/:slug/invites/:id/accept   # accept invite (invitee)
POST   /api/teams/:slug/invites/:id/decline  # decline invite (invitee)

POST   /api/teams/:slug/sync            # force GitHub membership sync (admin)
```

### Team Creation Endpoint

```typescript
// apps/web/src/app/api/teams/route.ts

const CreateTeamSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("github"),
    githubOrgLogin: z.string(),
    name: z.string().min(1).max(100).optional(),
    slug: z.string().regex(/^[a-z0-9-]{3,40}$/).optional(),
  }),
  z.object({
    type: z.literal("standalone"),
    name: z.string().min(1).max(100),
    slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
  }),
]);

export async function POST(request: Request) {
  const user = await withAuth(request);
  const body = CreateTeamSchema.parse(await request.json());

  if (body.type === "github") {
    const provider = authService.getProvider("github");
    const membership = await provider.getOrgMembership(user.githubToken, body.githubOrgLogin);
    if (!membership || membership.role !== "owner") {
      return errorResponse(new ApiError("Must be an org owner to create a team", 403));
    }
  }

  const team = await teamsService.create({
    name: body.name || body.githubOrgLogin,
    slug: body.slug || generateSlug(body.name || body.githubOrgLogin),
    githubOrgId: body.type === "github" ? membership.orgId : undefined,
    githubOrgLogin: body.type === "github" ? body.githubOrgLogin : undefined,
    ownerId: user.id,
  });

  return Response.json(team, { status: 201 });
}
```

---

## Dashboard: Team UI

### Team Picker

The top of the sidebar shows the current team. Clicking opens a dropdown:

```
┌─────────────────────────┐
│ 🏢 Acme Engineering  ▼  │  ← current team
├─────────────────────────┤
│ 👤 Personal (octocat)   │
│ 🏢 Acme Engineering  ✓  │
│ 🏢 Side Project Inc     │
├─────────────────────────┤
│ + Create new team       │
└─────────────────────────┘
```

Switching teams changes the URL prefix and reloads all data:

```
/t/acme-eng/tasks     → /t/side-project/tasks
```

### Team Settings Page

```
/t/:slug/settings
  General         — name, slug, avatar, delete
  Members         — list, invite, roles
  GitHub          — connected org, sync status
  Defaults        — default blueprint, cost limits, timeout
```

### Invite Flow

Admin clicks "Invite" → enters email or GitHub username → selects role → sends invite.

If invited by GitHub username and that user already has a gents account, the invite appears in their dashboard. If they don't have an account, they see the invite on first login.

If invited by email, we send an email with a link. On click, they OAuth with GitHub, and we match by email.

---

## Outstanding Questions

### Critical

- **Personal team auto-creation**: should every user get a personal team on first login, or only when they try to do something that requires a team context? Auto-create is simpler but creates clutter if everyone joins an org team anyway.
- **GitHub OAuth scopes**: what scopes do we need? `read:org` for org membership, `read:user` for profile. Do we need `repo` for anything at the team level, or only via the GitHub App?
- **Team transfer**: can an owner transfer ownership to another member? What's the flow? (Required for when the original creator leaves the company.)

### Important

- **Team limits**: max members per team on the free plan? Max teams per user?
- **Slug conflicts**: what if a GitHub org login conflicts with an existing standalone team's slug? First-come-first-served, or does the org get priority?
- **Deactivated users**: if a user is removed from the team, what happens to their running tasks? Cancel immediately, or let them complete?
- **Re-invites**: can you re-invite someone who declined? What about someone who was removed?

### Future Considerations

- **Enterprise SSO**: SAML/OIDC provider as an `AuthProvider` implementation. The interface supports it; we just don't build it for v1.
- **Cross-team visibility**: can an owner see tasks across all their teams in a single view? Not for v1.
- **API team context**: the current design puts team ID in the API key. If a user needs to operate across teams programmatically, they need multiple keys. Is that acceptable?
