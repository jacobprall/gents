# Agent Spec: code_security_reviewer

A cloud agent that runs on every push and opens GitHub issues when it finds security problems.

---

## Trigger

GitHub `push` webhook → forge routing rule → task creation.

One task per push event. The forge service matches the event, resolves the blueprint, and dispatches a cloud worker.

```
GitHub push webhook
  → forge parses event, matches routing rule
  → creates task with code_security_reviewer blueprint
  → worker spins up, clones repo at pushed ref
  → agent reviews changed files for security issues
  → opens GitHub issue (or comments on PR) if problems found
  → task completes
```

---

## Blueprint

```typescript
const codeSecurityReviewer: AgentBlueprint = {
  name: "code-security-reviewer",
  systemInstructions: `You are a security-focused code reviewer. On each invocation you receive
a git diff of the pushed changes. Your job:

1. Analyze the diff for security vulnerabilities (injection, auth bypass, secrets exposure,
   unsafe deserialization, path traversal, SSRF, etc.)
2. Check for dependency issues (known CVEs in added deps, unpinned versions)
3. Flag insecure patterns (hardcoded credentials, weak crypto, missing input validation)
4. If problems found: open a GitHub issue with severity, location, and remediation guidance
5. If no problems: complete silently (no noise)

Be precise. No false positives. Every issue you open should be actionable.`,

  tools: [
    // Built-in
    "read_file",
    "grep",
    "run_terminal_cmd",
    "list_dir",

    // Needs to be added (GitHub API tool or MCP)
    "github_create_issue",
    "github_add_pr_comment",
  ],

  permissions: [
    { id: "read-only", type: "path_deny_write", pattern: "**/*" },
  ],

  config: {
    model: "default",
    max_turns: "16",
  },

  seedMessages: [
    {
      turn: 0,
      role: "user",
      content: "Review the changes in the latest push for security issues. The diff is available via `git diff HEAD~1`. If you find problems, open a GitHub issue. If everything looks clean, say so and finish.",
    },
  ],
};
```

---

## Context

Minimal — this agent doesn't need much beyond the code:

| Section | Placement | Source |
|---|---|---|
| System instructions | static | Blueprint |
| Project conventions | static | SQLite (project rules) |
| Git diff | dynamic | `git diff` of pushed commits |
| File contents | dynamic | On-demand via `read_file` |

No livectx needed. This is a stateless, short-lived task that operates on a snapshot.

---

## Tools Gap

The built-in tool set covers file reading, grep, and shell commands. Missing:

| Tool | Purpose | Approach |
|---|---|---|
| `github_create_issue` | Open issue with findings | GitHub MCP server or built-in tool wrapping Octokit |
| `github_add_pr_comment` | Comment on PR if push is to a PR branch | Same |

**Workaround:** The agent could use `run_terminal_cmd` with the `gh` CLI if it's installed in the cloud sandbox. Fragile but functional for early iterations.

**Proper path:** An MCP server wrapping the GitHub API, connected to the cloud worker. The agent gets `github_create_issue`, `github_list_issues`, `github_add_pr_comment` as tools.

---

## Forge Routing Rule

```typescript
{
  event: "push",
  filter: {
    branches: ["main", "develop"],       // or all branches
    pathPatterns: ["**/*.ts", "**/*.js"], // optional: only trigger on code changes
  },
  blueprint: "code-security-reviewer",
  deduplication: {
    key: "security-review-{ref}-{after}", // one task per push
  },
}
```

---

## Lifecycle

- **Duration:** Short. Typically 2-5 minutes (read diff, scan files, maybe open an issue).
- **Timeout:** 15 minutes (generous ceiling).
- **Cost:** Low. Small context window, few turns.
- **Failure mode:** If the agent fails, task is marked failed. No retry by default — the next push triggers a fresh review.
- **Read-only:** The agent should not modify the repo. Write permissions denied via blueprint.

---

## Dependencies

| Dependency | Phase | Status |
|---|---|---|
| AgentBlueprint system | Phase 1 | **Built** |
| forge service (webhook → task) | Phase 2, M10 | Not built |
| Gateway + Worker | Phase 2, M8-M9 | Not built |
| GitHub tools / MCP | Phase 2 | Not built |
| Cloud sandbox (repo clone) | Phase 2, M8 | Not built |
