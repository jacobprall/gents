# AuthService (`services/auth`)

**Status:** Proposed
**Package:** `@gents/auth`
**Depends on:** NextAuth v5, PostgreSQL, `crypto` (Node built-in)

---

## Purpose

The AuthService handles authentication and API key management for the gents platform. It supports two authentication flows:

1. **Session-based (NextAuth)** — for the web dashboard. Users sign in with GitHub OAuth, and NextAuth manages the session cookie.
2. **API key-based** — for the CLI and programmatic access. Users generate long-lived API keys from the dashboard, then pass them as `Bearer` tokens.

The service is framework-agnostic: it accepts plain `Request` objects and returns plain data. NextAuth wiring and HTTP cookie handling live in `apps/web`; this package provides the business logic.

---

## File Layout

```
services/auth/
  src/
    index.ts                 # barrel exports
    types.ts                 # AuthService interface, User, ApiKey types
    nextauth-service.ts      # NextAuth-backed implementation
    api-key.ts               # API key generation, hashing, verification
    middleware.ts            # Auth middleware for API routes
    permissions.ts           # Role/scope checking (future)
  package.json
  tsconfig.json
```

---

## Interface

### Core Types

```typescript
export interface User {
  id: string;
  githubId: string;
  name: string;
  email: string;
  avatarUrl?: string;
  createdAt?: Date;
}

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  prefix: string;              // first 12 chars, for display ("gnt_a1b2c3d4")
  scopes?: string[];           // optional scope restrictions
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
}
```

### AuthService Interface

```typescript
export interface AuthService {
  // Session-based (NextAuth)
  getSessionUser(request: Request): Promise<User | null>;

  // API key-based (CLI, programmatic)
  verifyApiKey(key: string): Promise<User | null>;
  createApiKey(
    userId: string,
    name: string,
    opts?: { scopes?: string[]; expiresAt?: Date }
  ): Promise<{ key: string; apiKey: ApiKey }>;
  revokeApiKey(keyId: string): Promise<void>;
  listApiKeys(userId: string): Promise<ApiKey[]>;

  // User management
  getUser(userId: string): Promise<User | null>;
  getUserByGithubId(githubId: string): Promise<User | null>;
  upsertUser(user: Omit<User, "createdAt">): Promise<User>;
}
```

### Method Semantics

| Method | Description | Auth Required |
|---|---|---|
| `getSessionUser` | Extract the authenticated user from a session cookie. Returns `null` if no valid session. | No (this *is* the auth check) |
| `verifyApiKey` | Look up a user by their API key hash. Returns `null` if the key is invalid or expired. Updates `lastUsedAt` as a side effect. | No |
| `createApiKey` | Generate a new API key for a user. Returns the raw key (shown once) and the metadata record. | Yes (user must own the account) |
| `revokeApiKey` | Hard-delete an API key. Immediately invalidates it. | Yes |
| `listApiKeys` | List all API keys for a user. Raw keys are never returned — only prefix and metadata. | Yes |
| `getUser` / `getUserByGithubId` | Look up a user by internal ID or GitHub ID. | Internal use |
| `upsertUser` | Create or update a user record (called during OAuth callback). | Internal use |

---

## API Key Design

### Key Format

```
gnt_<32 bytes base64url>
```

- **Prefix:** `gnt_` — identifies the key as a gents API key
- **Entropy:** 32 random bytes, base64url encoded (~43 chars)
- **Total length:** ~47 characters
- **Display prefix:** first 12 characters shown in the UI (e.g. `gnt_a1b2c3d4`)

### Key Storage

Keys are **never stored in plaintext**. The flow:

1. `generateApiKey()` produces `{ key, hash, prefix }`
2. `key` is returned to the user exactly once
3. `hash` (SHA-256 of the full key) is stored in the `api_keys` table
4. `prefix` is stored for display purposes
5. On verification, the incoming key is hashed and compared against stored hashes

```typescript
// services/auth/src/api-key.ts

import { randomBytes, createHash } from "crypto";

const KEY_PREFIX = "gnt_";

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const raw = randomBytes(32).toString("base64url");
  const key = `${KEY_PREFIX}${raw}`;
  const hash = createHash("sha256").update(key).digest("hex");
  const prefix = key.slice(0, 12);
  return { key, hash, prefix };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function isApiKey(value: string): boolean {
  return value.startsWith(KEY_PREFIX) && value.length > 20;
}
```

### Security Properties

- **Timing-safe comparison**: Key lookup is by hash (indexed DB column), not by iterating and comparing raw keys. There is no timing oracle.
- **One-way storage**: Even if the database is compromised, raw keys cannot be recovered from hashes.
- **Prefix for UX**: The `gnt_` prefix lets users and tools (e.g. secret scanners) identify leaked keys.

---

## Auth Middleware

The middleware supports both auth flows transparently:

```typescript
// services/auth/src/middleware.ts

import type { AuthService, User } from "./types";

export async function authenticateRequest(
  request: Request,
  authService: AuthService
): Promise<User | null> {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer gnt_")) {
    return authService.verifyApiKey(authHeader.slice(7));
  }
  return authService.getSessionUser(request);
}

export function requireAuth(user: User | null): asserts user is User {
  if (!user) {
    throw new AuthenticationError("Authentication required");
  }
}

export class AuthenticationError extends Error {
  public readonly statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}
```

### Request Flow

```
Request arrives
  ├─ Has `Authorization: Bearer gnt_...` header?
  │   └─ Yes → hash the key, look up in api_keys table → User | null
  └─ No → check for NextAuth session cookie → User | null
```

---

## NextAuth Implementation

```typescript
// services/auth/src/nextauth-service.ts

import type { Pool } from "pg";
import type { AuthService, User, ApiKey } from "./types";
import { generateApiKey, hashApiKey } from "./api-key";

export class NextAuthService implements AuthService {
  constructor(private pool: Pool) {}

  async getSessionUser(request: Request): Promise<User | null> {
    // Delegates to NextAuth's getServerSession()
    // Actual wiring happens in apps/web where NextAuth is configured
    return null;
  }

  async verifyApiKey(key: string): Promise<User | null> {
    const hash = hashApiKey(key);
    const result = await this.pool.query(
      `SELECT u.* FROM api_keys k
       JOIN users u ON u.id = k.user_id
       WHERE k.hash = $1
         AND (k.expires_at IS NULL OR k.expires_at > NOW())`,
      [hash]
    );
    if (result.rows.length === 0) return null;

    // Update last_used_at asynchronously (fire-and-forget)
    this.pool.query(
      `UPDATE api_keys SET last_used_at = NOW() WHERE hash = $1`,
      [hash]
    ).catch(() => {});

    return mapUserRow(result.rows[0]);
  }

  async createApiKey(
    userId: string,
    name: string,
    opts?: { scopes?: string[]; expiresAt?: Date }
  ): Promise<{ key: string; apiKey: ApiKey }> {
    const { key, hash, prefix } = generateApiKey();
    const id = generateId();
    await this.pool.query(
      `INSERT INTO api_keys (id, user_id, name, hash, prefix, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, name, hash, prefix, opts?.expiresAt || null]
    );
    return {
      key,
      apiKey: { id, userId, name, prefix, createdAt: new Date(), expiresAt: opts?.expiresAt },
    };
  }

  async revokeApiKey(keyId: string): Promise<void> {
    await this.pool.query(`DELETE FROM api_keys WHERE id = $1`, [keyId]);
  }

  async listApiKeys(userId: string): Promise<ApiKey[]> {
    const result = await this.pool.query(
      `SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows.map(mapApiKeyRow);
  }

  async getUser(userId: string): Promise<User | null> {
    const result = await this.pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async getUserByGithubId(githubId: string): Promise<User | null> {
    const result = await this.pool.query(`SELECT * FROM users WHERE github_id = $1`, [githubId]);
    return result.rows[0] ? mapUserRow(result.rows[0]) : null;
  }

  async upsertUser(user: Omit<User, "createdAt">): Promise<User> {
    const result = await this.pool.query(
      `INSERT INTO users (id, github_id, name, email, avatar_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (github_id)
       DO UPDATE SET name = $3, email = $4, avatar_url = $5
       RETURNING *`,
      [user.id, user.githubId, user.name, user.email, user.avatarUrl]
    );
    return mapUserRow(result.rows[0]);
  }
}
```

---

## Database Schema

See [database.md](./database.md) for full migration SQL. Auth-specific tables:

### `users`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Internal user ID (CUID or nanoid) |
| `github_id` | TEXT UNIQUE | GitHub user ID (numeric string) |
| `name` | TEXT | Display name |
| `email` | TEXT | Email address |
| `avatar_url` | TEXT | GitHub avatar URL |
| `created_at` | TIMESTAMPTZ | Auto-set |

### `api_keys`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Key record ID |
| `user_id` | TEXT FK → users | Owner |
| `name` | TEXT | User-provided label (e.g. "CLI key") |
| `hash` | TEXT | SHA-256 hash of the full key |
| `prefix` | TEXT | First 12 chars for display |
| `scopes` | TEXT[] | Future: scope restrictions |
| `expires_at` | TIMESTAMPTZ | Nullable. Expired keys are rejected on verify. |
| `last_used_at` | TIMESTAMPTZ | Updated on each successful verify |
| `created_at` | TIMESTAMPTZ | Auto-set |

### `sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Session ID |
| `user_id` | TEXT FK → users | Owner |
| `session_token` | TEXT UNIQUE | NextAuth session token |
| `expires_at` | TIMESTAMPTZ | Session expiry |

---

## Implementation Plan

### Phase 1: API Key Infrastructure (Day 1)

1. Scaffold `services/auth` package
2. Implement `api-key.ts` — `generateApiKey`, `hashApiKey`, `isApiKey`
3. Write unit tests for key generation (entropy, format, hash consistency)
4. Implement `middleware.ts` — `authenticateRequest`, `requireAuth`, `AuthenticationError`
5. Write unit tests for middleware with mock AuthService

### Phase 2: NextAuth Integration (Day 2)

1. Implement `NextAuthService` — all methods except `getSessionUser`
2. Wire `getSessionUser` to NextAuth v5's `getServerSession` in `apps/web`
3. Configure NextAuth GitHub provider with OAuth app credentials
4. Set up NextAuth adapter to use our `users` table (custom Postgres adapter or Drizzle adapter)
5. Test the full OAuth flow: GitHub login → session cookie → `getSessionUser` returns `User`

### Phase 3: API Key CRUD (Day 3)

1. Implement `createApiKey`, `revokeApiKey`, `listApiKeys` with Postgres
2. Build API routes in `apps/web`: `POST /api/keys`, `DELETE /api/keys/:id`, `GET /api/keys`
3. Build CLI command: `gents auth create-key --name "my key"` → stores key in `~/.config/gents/`
4. Test: create key via API → use key in CLI → verify key → see task created

### Phase 4: Permissions & Hardening (Future)

1. Implement `permissions.ts` — scope checking, role-based access
2. Add rate limiting per user/key (in-memory for v1, Redis for production)
3. Add key rotation support (create new key, grace period, revoke old)
4. Audit logging for auth events (login, key creation, key revocation)

---

## Error Handling

| Error | Type | HTTP Status | Recovery |
|---|---|---|---|
| No auth header and no session | `AuthenticationError` | 401 | User must authenticate. |
| Invalid API key | `AuthenticationError` | 401 | Key may be revoked or mistyped. |
| Expired API key | `AuthenticationError` | 401 | User must create a new key. |
| Insufficient scope | `AuthorizationError` (future) | 403 | User must use a key with the required scope. |
| User not found | `null` return | — | Internal error — should not happen in normal flows. |

---

## Security Considerations

### CSRF Protection

API routes that accept both session and API key auth need careful CSRF handling:

- **Session-based requests** (from the browser): Must include a CSRF token. NextAuth handles this for its own routes. Custom API routes need the Next.js CSRF middleware.
- **API key requests** (from the CLI or scripts): CSRF protection is not needed because the request includes a secret (the API key) that the attacker cannot forge.
- **Detection**: The middleware distinguishes the two by checking for the `Authorization: Bearer gnt_...` header. If present, it's an API key request (no CSRF check). Otherwise, it's a session request (CSRF required).

### Key Leakage

- The `gnt_` prefix enables GitHub secret scanning to detect leaked keys in public repos.
- Consider registering the prefix with GitHub's secret scanning partner program.
- The dashboard should show a warning when a key hasn't been used in 90 days (stale keys are a risk).

### Session Strategy

NextAuth v5 supports JWT and database sessions:

| Strategy | Pros | Cons |
|---|---|---|
| JWT | Stateless, no DB query per request, easy to scale | Cannot be revoked (must wait for expiry), larger cookies |
| Database | Revocable, smaller cookies, audit trail | One DB query per request, session table maintenance |

**Recommendation:** Start with database sessions for revocability and auditability. If the session query becomes a bottleneck, add a short-lived JWT cache in front.

---

## Open Questions

### Must-resolve before implementation

1. **GitHub OAuth scopes**: What minimum GitHub OAuth scopes do we need? `repo` for private repos? `read:org` for org membership? Requesting too many scopes reduces sign-up conversion; requesting too few blocks features later.

2. **Session storage strategy**: JWT vs. database sessions — see the tradeoff table above. This affects NextAuth configuration and the session middleware.

3. **NextAuth v5 adapter**: Which adapter? NextAuth v5 has official adapters for Drizzle, Prisma, and raw SQL. Since we're using raw `pg` queries elsewhere, a custom Postgres adapter may be most consistent. But the Drizzle adapter is well-tested.

### Should-resolve before production

4. **API key scopes**: Do we need scoped keys (e.g. `tasks:read`, `tasks:write`, `rules:admin`) or is a single all-access key sufficient for v1? Scopes add complexity but are expected by enterprise users.

5. **API key expiration**: Should keys expire by default? What's the default TTL? Non-expiring keys are a security risk but more convenient for CI/CD.

6. **Rate limiting**: Should auth middleware enforce rate limits per user / per key? Where does that state live (in-memory, Redis, Postgres)? Rate limiting protects against credential stuffing and runaway automation.

7. **CSRF handling**: The detection logic (check for `Bearer gnt_` header) is simple but needs to be bulletproof. Edge cases: what if a browser extension sends an `Authorization` header? What about WebSocket connections?

### Can-defer to v2

8. **Team/org model**: The current schema is single-user. When do we need multi-user orgs with shared repos, tasks, and routing rules? Does auth need to account for this now (e.g. `org_id` on users)?

9. **GitHub App vs. OAuth App**: A GitHub App provides finer-grained permissions, installation-level tokens, and higher rate limits. Should we migrate from OAuth App to GitHub App? This affects the auth flow significantly.

10. **SSO / SAML**: Enterprise customers may need SAML or OIDC federation. This is a v2+ concern but may influence the auth architecture if we need to support multiple identity providers.
