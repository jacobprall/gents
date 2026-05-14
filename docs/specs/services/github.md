# GitHub Integration (`services/github`)

**Status:** Proposed
**Package:** `@gents/github`
**Depends on:** `@octokit/rest`, `@gents/tasks` (for `RoutingRule` type)

---

## Purpose

The GitHub service handles the inbound integration between GitHub and the gents platform. It is responsible for:

1. **Webhook ingestion** — receiving, verifying, and parsing GitHub webhook events
2. **Event routing** — matching incoming events against user-defined routing rules to decide which tasks to dispatch
3. **Instruction templates** — resolving template variables in task instructions (e.g. `{{repo}}`, `{{branch}}`, `{{pr_title}}`)
4. **GitHub API client** — a thin Octokit wrapper for operations the platform needs (get changed files, post comments, create PRs)

The service is stateless and framework-agnostic. It receives parsed webhook data and returns structured results. The HTTP handling (receiving the POST, reading headers) lives in `apps/web`.

---

## File Layout

```
services/github/
  src/
    index.ts                 # barrel exports
    types.ts                 # GitHubEvent, WebhookPayload types
    webhook-parser.ts        # Parse + verify webhook signatures
    routing.ts               # Match events against routing rules
    client.ts                # GitHub API client (Octokit wrapper)
    templates.ts             # Instruction template resolution
  package.json
  tsconfig.json
```

---

## Webhook Parsing & Verification

### Types

```typescript
export interface GitHubWebhookEvent {
  event: string;             // 'push', 'pull_request', 'issues', etc.
  action?: string;           // 'opened', 'closed', 'labeled', etc.
  delivery: string;          // unique delivery ID (for idempotency)
  payload: Record<string, unknown>;
  repository: {
    clone_url: string;
    full_name: string;       // "owner/repo"
    private: boolean;
  };
  ref?: string;              // "refs/heads/main" for push events
  sender: { login: string; id: number };
}
```

### Signature Verification

GitHub signs every webhook payload with HMAC-SHA256 using the webhook secret. We must verify this signature before processing.

```typescript
import { createHmac, timingSafeEqual } from "crypto";

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = `sha256=${createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

**Security notes:**
- Always use `timingSafeEqual` to prevent timing attacks
- The `payload` must be the raw request body (not re-serialized JSON) to match the signature
- The `signature` comes from the `X-Hub-Signature-256` header

### Parsing

```typescript
export function parseWebhookEvent(
  headers: Headers,
  body: string
): GitHubWebhookEvent {
  const event = headers.get("x-github-event");
  const delivery = headers.get("x-github-delivery");
  if (!event || !delivery) {
    throw new Error("Missing required GitHub webhook headers");
  }

  const payload = JSON.parse(body);
  return {
    event,
    action: payload.action,
    delivery,
    payload,
    repository: payload.repository,
    ref: payload.ref,
    sender: payload.sender,
  };
}
```

---

## Event Routing

Routing rules define which GitHub events trigger which tasks. Each rule specifies an event type, optional filters (branches, labels, paths), a blueprint, and instruction template.

### Matching Logic

```typescript
export function matchesRule(
  event: GitHubWebhookEvent,
  rule: RoutingRule
): boolean {
  if (!rule.enabled) return false;

  // Match event type (e.g. "push", "pull_request.opened")
  const eventKey = event.action
    ? `${event.event}.${event.action}`
    : event.event;
  if (rule.event !== eventKey && rule.event !== event.event) return false;

  // Branch filter
  if (rule.filter.branches?.length) {
    const branch = extractBranch(event);
    if (!branch || !rule.filter.branches.some(b => matchGlob(branch, b)))
      return false;
  }

  // Label filter
  if (rule.filter.labels?.length) {
    const labels = extractLabels(event);
    if (!rule.filter.labels.some(l => labels.includes(l))) return false;
  }

  // Path filter
  if (rule.filter.paths?.length) {
    const changedFiles = extractChangedFiles(event);
    if (!changedFiles.length) return false;
    if (!rule.filter.paths.some(p => changedFiles.some(f => matchGlob(f, p))))
      return false;
  }

  return true;
}

export function findMatchingRules(
  event: GitHubWebhookEvent,
  rules: RoutingRule[]
): RoutingRule[] {
  return rules.filter(r => matchesRule(event, r));
}
```

### Event Key Format

Rules use a dotted event key to match specific actions:

| Event Key | Matches |
|---|---|
| `push` | All push events |
| `pull_request` | All PR events (opened, closed, merged, etc.) |
| `pull_request.opened` | Only when a PR is opened |
| `pull_request.labeled` | Only when a label is added to a PR |
| `issues.opened` | Only when an issue is opened |
| `issues.labeled` | Only when a label is added to an issue |

### Filter Extraction Helpers

```typescript
function extractBranch(event: GitHubWebhookEvent): string | null {
  if (event.ref?.startsWith("refs/heads/")) {
    return event.ref.replace("refs/heads/", "");
  }
  const pr = event.payload as {
    pull_request?: { head?: { ref?: string } };
  };
  return pr.pull_request?.head?.ref || null;
}

function extractLabels(event: GitHubWebhookEvent): string[] {
  const pr = event.payload as {
    pull_request?: { labels?: { name: string }[] };
  };
  const issue = event.payload as {
    issue?: { labels?: { name: string }[] };
  };
  return (pr.pull_request?.labels || issue.issue?.labels || []).map(
    l => l.name
  );
}

function extractChangedFiles(event: GitHubWebhookEvent): string[] {
  const push = event.payload as {
    commits?: {
      added?: string[];
      modified?: string[];
      removed?: string[];
    }[];
  };
  if (push.commits) {
    return push.commits.flatMap(c => [
      ...(c.added || []),
      ...(c.modified || []),
      ...(c.removed || []),
    ]);
  }
  // For PR events, changed files aren't in the webhook payload.
  // A follow-up API call is needed (see open questions).
  return [];
}
```

### Glob Matching

Simple glob matching for branch and path filters:

```typescript
function matchGlob(value: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return regex.test(value);
}
```

**Limitations of the current glob implementation:**
- `**` is treated the same as `*` (doesn't distinguish directory depth)
- No brace expansion (`{a,b}`)
- No character classes (`[abc]`)
- Consider using `picomatch` or `minimatch` for production

---

## Instruction Templates

Routing rules include an instruction template that gets resolved with event data before being passed to the agent:

```typescript
export function resolveInstructions(
  template: string,
  event: GitHubWebhookEvent
): string {
  const vars: Record<string, string> = {
    repo: event.repository.full_name,
    ref: event.ref || "",
    sender: event.sender.login,
    event: event.event,
    action: event.action || "",
    branch: extractBranch(event) || "",
    pr_number: String(
      (event.payload as any).pull_request?.number || ""
    ),
    pr_title: (event.payload as any).pull_request?.title || "",
    pr_body: (event.payload as any).pull_request?.body || "",
    issue_number: String(
      (event.payload as any).issue?.number || ""
    ),
    issue_title: (event.payload as any).issue?.title || "",
    issue_body: (event.payload as any).issue?.body || "",
  };

  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || "");
}
```

### Available Template Variables

| Variable | Source | Example |
|---|---|---|
| `{{repo}}` | `event.repository.full_name` | `"acme/web-app"` |
| `{{ref}}` | `event.ref` | `"refs/heads/feat/login"` |
| `{{branch}}` | Extracted from ref or PR head | `"feat/login"` |
| `{{sender}}` | `event.sender.login` | `"alice"` |
| `{{event}}` | Event type | `"pull_request"` |
| `{{action}}` | Event action | `"opened"` |
| `{{pr_number}}` | PR number | `"42"` |
| `{{pr_title}}` | PR title | `"Add login page"` |
| `{{pr_body}}` | PR description body | `"This PR adds..."` |
| `{{issue_number}}` | Issue number | `"17"` |
| `{{issue_title}}` | Issue title | `"Bug: login fails"` |
| `{{issue_body}}` | Issue description body | `"When I try to..."` |

### Example Template

```
Review the pull request #{{pr_number}} ("{{pr_title}}") in {{repo}} on branch {{branch}}.
Focus on code quality, test coverage, and security concerns.
Post your review as a PR comment.
```

---

## GitHub API Client

A thin wrapper around Octokit for operations the platform needs:

```typescript
import { Octokit } from "@octokit/rest";

export class GitHubClient {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async getChangedFiles(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<string[]> {
    const files = await this.octokit.paginate(
      this.octokit.pulls.listFiles,
      { owner, repo, pull_number: prNumber }
    );
    return files.map(f => f.filename);
  }

  async createComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<void> {
    await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }

  async createPR(params: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ number: number; html_url: string }> {
    const { data } = await this.octokit.pulls.create(params);
    return { number: data.number, html_url: data.html_url };
  }

  async getRepoDefaultBranch(
    owner: string,
    repo: string
  ): Promise<string> {
    const { data } = await this.octokit.repos.get({ owner, repo });
    return data.default_branch;
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });
      if ("content" in data && data.encoding === "base64") {
        return Buffer.from(data.content, "base64").toString("utf-8");
      }
      return null;
    } catch {
      return null;
    }
  }

  async createCheckRun(params: {
    owner: string;
    repo: string;
    name: string;
    headSha: string;
    status: "queued" | "in_progress" | "completed";
    conclusion?: "success" | "failure" | "neutral" | "cancelled";
    output?: { title: string; summary: string };
  }): Promise<{ id: number }> {
    const { data } = await this.octokit.checks.create({
      owner: params.owner,
      repo: params.repo,
      name: params.name,
      head_sha: params.headSha,
      status: params.status,
      conclusion: params.conclusion,
      output: params.output,
    });
    return { id: data.id };
  }
}
```

### Client Methods

| Method | Purpose | Used By |
|---|---|---|
| `getChangedFiles` | Get list of changed files in a PR (for path-based routing) | Routing engine, agent tools |
| `createComment` | Post a comment on an issue or PR | Agent output, status notifications |
| `createPR` | Create a pull request from agent's branch | Agent tool |
| `getRepoDefaultBranch` | Determine the base branch for PR creation | Agent tool, task dispatch |
| `getFileContent` | Read a file from a repo at a specific ref | Blueprint resolution, config loading |
| `createCheckRun` | Create a GitHub Check to show task status | Task lifecycle hooks |

---

## End-to-End Webhook Flow

```
1. GitHub sends POST /api/webhooks/github
   ├─ Headers: X-GitHub-Event, X-GitHub-Delivery, X-Hub-Signature-256
   └─ Body: JSON payload

2. apps/web webhook handler:
   ├─ Read raw body (for signature verification)
   ├─ verifyWebhookSignature(body, signature, WEBHOOK_SECRET)
   ├─ parseWebhookEvent(headers, body)
   └─ Pass event to routing

3. Routing:
   ├─ Load routing rules from TaskRepository
   ├─ findMatchingRules(event, rules)
   ├─ For each matching rule:
   │   ├─ resolveInstructions(rule.instructions, event)
   │   └─ TaskDispatcher.dispatch({ repo, ref, blueprint, instructions, ... })
   └─ Return 200 OK (or 204 if no rules matched)

4. If PR event and path-based routing:
   ├─ GitHubClient.getChangedFiles(owner, repo, prNumber)
   └─ Re-run path matching with the file list
```

---

## Implementation Plan

### Phase 1: Webhook Core (Day 1)

1. Scaffold `services/github` package
2. Implement `webhook-parser.ts` — `verifyWebhookSignature` and `parseWebhookEvent`
3. Write unit tests with real GitHub webhook payloads (captured or from GitHub docs)
4. Implement idempotency check — track `delivery` IDs to reject re-deliveries
5. Build the webhook handler route in `apps/web`

### Phase 2: Event Routing (Day 2)

1. Implement `routing.ts` — `matchesRule`, `findMatchingRules`
2. Implement filter extraction helpers (`extractBranch`, `extractLabels`, `extractChangedFiles`)
3. Replace the simple glob matcher with `picomatch` for production-grade glob support
4. Write comprehensive tests for routing edge cases:
   - Event with action vs. without action
   - Branch filter with glob patterns
   - Label filter with multiple labels
   - Path filter for push events (files in payload)
   - Path filter for PR events (requires API call)

### Phase 3: Templates & Client (Day 3)

1. Implement `templates.ts` — `resolveInstructions`
2. Implement `client.ts` — `GitHubClient` with all methods
3. Add `getChangedFiles` call for PR events that need path-based routing
4. Test template resolution with various event types
5. Test client methods against GitHub API (use a test repo)

### Phase 4: Advanced Features (Future)

1. **Check runs** — create a GitHub Check when a task starts, update it on completion
2. **Status comments** — post a comment on the PR/issue when the task starts and when it completes
3. **Re-run support** — detect `/gents re-run` comments and re-dispatch the task
4. **GitHub App migration** — move from OAuth App to GitHub App for better permissions model

---

## Error Handling

| Error | Cause | Response | Recovery |
|---|---|---|---|
| Invalid signature | Webhook secret mismatch or payload tampering | 401 | Log the attempt. Do not process. |
| Missing headers | Not a valid GitHub webhook | 400 | Reject immediately. |
| Invalid JSON | Malformed payload | 400 | Reject immediately. |
| Duplicate delivery | GitHub re-delivered a webhook | 200 (idempotent) | Skip processing, return success. |
| No matching rules | Event doesn't match any routing rules | 204 | Log for debugging. No action needed. |
| GitHub API rate limit | Too many API calls | — | Back off using `X-RateLimit-Reset` header. |
| GitHub API 404 | Repo deleted, PR closed, etc. | — | Log and skip. Don't retry. |

---

## Observability

- **Metrics:** webhooks received/sec, webhook verification failures, routing matches per event, template resolution errors, GitHub API call latency, GitHub API rate limit remaining
- **Logging:** log every webhook received (event type, delivery ID, repo), log routing matches (which rules matched), log GitHub API calls with response status
- **Alerting:** alert on signature verification failure rate > 0 (potential attack), alert on GitHub API rate limit remaining < 100

---

## Open Questions

### Must-resolve before implementation

1. **Webhook idempotency**: GitHub can redeliver webhooks. How do we deduplicate? Options: (a) track `delivery` IDs in a Postgres table with a TTL, (b) use a Redis set with TTL, (c) use a Postgres advisory lock. The table approach is simplest and most durable.

2. **PR changed files**: The webhook payload for `pull_request` events does not include the list of changed files. For path-based routing on PR events, we need a follow-up API call to `GET /repos/:owner/:repo/pulls/:number/files`. This adds latency to the webhook handler. Should we always make this call, or only when a matching rule has path filters?

3. **GitHub App vs. OAuth App**: A GitHub App provides finer-grained permissions (per-repo installation), installation-level tokens (higher rate limits), and webhook management via the API. Should we build as a GitHub App from the start? This is a significant architectural decision that affects auth, token management, and webhook registration.

### Should-resolve before production

4. **Multi-rule dispatch**: If an event matches multiple routing rules, we currently dispatch one task per matching rule. Is this correct? Consider: a push to `main` that matches both a "deploy" rule and a "test" rule — do we want two separate tasks, or one task with merged instructions?

5. **Webhook registration**: Do users configure webhooks manually in their GitHub repo settings, or do we provide a UI/API that uses the GitHub API to register webhooks automatically? Manual setup is simpler but error-prone. Auto-registration requires the GitHub App model.

6. **Payload size**: Large pushes with many commits can produce enormous webhook payloads (GitHub's max is 25 MB). Do we need to truncate or sample `extractChangedFiles` for very large pushes?

7. **Template variables**: What additional template variables do users need? Candidates: `{{diff}}` (PR diff — can be huge), `{{commit_messages}}` (list of commit messages), `{{files}}` (list of changed files), `{{labels}}` (comma-separated label list).

### Can-defer to v2

8. **Comment commands**: Support `/gents run`, `/gents re-run`, `/gents cancel` as PR/issue comment commands. This requires a new event handler for `issue_comment` events and a command parser.

9. **Webhook management UI**: A dashboard page where users can see received webhooks, their routing matches, and dispatched tasks. Useful for debugging why a webhook didn't trigger the expected task.

10. **Multi-repo support**: A single routing rule currently applies to one webhook source. Can rules be shared across repos? This matters for orgs with many repos that want consistent automation.
