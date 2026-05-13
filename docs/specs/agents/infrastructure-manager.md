# Agent Spec: infrastructure_manager

A cloud agent with live infrastructure awareness that can monitor health, manage services, and spin up preview environments.

---

## Trigger

Multiple trigger modes — this agent is more versatile than event-driven review:

| Trigger | Use Case |
|---|---|
| GitHub PR webhook | Spin up preview environment for the PR |
| Manual (CLI/dashboard) | "Scale up the API service" / "Debug why staging is slow" |
| Scheduled (cron-style) | Periodic health check and remediation |
| Alert webhook (future) | Render/external monitoring fires alert → agent investigates |

---

## Blueprint

```typescript
const infrastructureManager: AgentBlueprint = {
  name: "infrastructure-manager",
  systemInstructions: `You are an infrastructure management agent for a Render-hosted platform.
You have live access to service health, deploy status, and environment configuration.

Your capabilities:
- Monitor service health and diagnose issues
- Scale services up/down based on load or request
- Spin up and tear down preview environments for PRs
- Investigate deploy failures and suggest fixes
- Read logs and metrics to diagnose performance issues

Principles:
- Never take destructive actions without explicit confirmation (unless in auto-remediation mode)
- Always check current state before making changes
- Log every infrastructure change you make
- Prefer conservative actions (restart before redeploy, scale before rebuild)`,

  tools: [
    // Built-in
    "read_file",
    "grep",
    "run_terminal_cmd",
    "list_dir",

    // Infra tools (via MCP or built-in)
    "render_list_services",
    "render_get_service_status",
    "render_scale_service",
    "render_restart_service",
    "render_get_deploy_status",
    "render_create_preview",
    "render_delete_preview",
    "render_get_logs",
    "render_get_metrics",

    // GitHub tools (via MCP)
    "github_add_pr_comment",
    "github_update_deploy_status",
  ],

  permissions: [
    { id: "deny-git-write", type: "path_deny_write", pattern: "**/.git/**" },
  ],

  config: {
    model: "default",
    max_turns: "32",
  },
};
```

---

## Context (livectx-powered)

This is where the agent diverges from simpler task agents. It needs **live data from external services**, which is exactly what livectx is designed for in the cloud worker.

```typescript
import { source } from "@livectx/core";

// Live service health — refreshes every 10s, push-invalidated on deploy events
const serviceHealth = source({
  key: ["render", "services", projectId],
  resolver: () => render.listServices(projectId),
  staleTime: "10s",
  placement: "dynamic",
});

// Current deploy status — refreshes every 30s
const deployStatus = source({
  key: ["render", "deploy", serviceId],
  resolver: () => render.getLatestDeploy(serviceId),
  staleTime: "30s",
  placement: "dynamic",
});

// Preview environments — refreshes every 60s
const previews = source({
  key: ["render", "previews", projectId],
  resolver: () => render.listPreviews(projectId),
  staleTime: "60s",
  placement: "dynamic",
});

// PR state (if triggered by PR webhook)
const prState = source({
  key: ["github", "pr", prNumber],
  resolver: () => github.pulls.get({ pull_number: prNumber }),
  staleTime: "30s",
  subscribe: true, // push-invalidated via webhook
  placement: "dynamic",
});
```

The static prefix (system prompt, project config) is cached via Anthropic `cache_control`. Dynamic sections pull live state from livectx on every turn — the agent always sees current infra status.

---

## Tools Gap

Large. The built-in tool set has no infrastructure management tools.

| Tool | Purpose | Approach |
|---|---|---|
| `render_list_services` | List all services in a project | Render MCP server |
| `render_get_service_status` | Health, deploy state, resource usage | Render MCP server |
| `render_scale_service` | Change instance count/plan | Render MCP server |
| `render_restart_service` | Restart a service | Render MCP server |
| `render_get_deploy_status` | Current deploy status and history | Render MCP server |
| `render_create_preview` | Spin up preview env for a branch/PR | Render MCP server |
| `render_delete_preview` | Tear down preview env | Render MCP server |
| `render_get_logs` | Tail/search service logs | Render MCP server |
| `render_get_metrics` | CPU, memory, request rate, latency | Render MCP server |
| `github_add_pr_comment` | Post preview URL, status updates | GitHub MCP server |
| `github_update_deploy_status` | Set commit deploy status | GitHub MCP server |

**Approach:** Two MCP servers connected to the cloud worker:
1. **render-mcp** — wraps the Render REST API for service/deploy/preview management
2. **github-mcp** — wraps the GitHub API for PR interaction and deploy statuses

Cloud workers connect to these over HTTP (local stdio not available in cloud VMs).

---

## Execution Model

### Open question: discrete tasks vs always-on daemon

The current gents architecture models work as **discrete tasks** (created → runs → completes, 2-hour default timeout). This agent concept pushes against that:

| Model | How It Works | Pros | Cons |
|---|---|---|---|
| **Discrete per-event** | Each webhook/trigger creates a new task. Agent runs, does its thing, exits. | Fits current design. Simple. No resource leak. | No persistent awareness. Each task starts cold. |
| **Recurring scheduled** | A cron dispatches a new task every N minutes. Agent checks health, acts if needed, exits. | Still discrete. Periodic awareness. | Gaps between checks. Cold start overhead. |
| **Long-lived daemon** | A single task that runs continuously, reacting to events pushed to it via steering. | Persistent awareness. Immediate reaction. | Not in current design. Resource cost. Needs "always-on task" concept. |

**Recommendation for Phase 2:** Start with **discrete per-event** for webhook-triggered work (PR → preview) and **recurring scheduled** for health monitoring. Defer the daemon model until there's a proven need that discrete tasks can't serve.

---

## Example Flows

### PR Preview Environment

```
1. GitHub PR opened → forge creates task (blueprint: infrastructure-manager)
2. Agent reads PR metadata via livectx
3. Agent calls render_create_preview for the PR branch
4. Agent waits for deploy to succeed (polls via render_get_deploy_status)
5. Agent posts preview URL as PR comment via github_add_pr_comment
6. Task completes

(On PR close: separate task created to tear down preview)
```

### Health Check + Remediation

```
1. Cron triggers task creation (blueprint: infrastructure-manager)
2. Agent reads live service health via livectx
3. All healthy → completes silently
4. Service unhealthy → agent investigates:
   a. Check logs via render_get_logs
   b. Check metrics via render_get_metrics
   c. Attempt restart via render_restart_service
   d. Verify recovery
   e. If still unhealthy: open GitHub issue or alert channel
5. Task completes
```

---

## Dependencies

| Dependency | Phase | Status |
|---|---|---|
| AgentBlueprint system | Phase 1 | **Built** |
| forge service (webhook → task) | Phase 2, M10 | Not built |
| Gateway + Worker | Phase 2, M8-M9 | Not built |
| livectx integration in worker | Phase 2 | Not built |
| Render MCP server | Phase 2 | Not built |
| GitHub MCP server | Phase 2 | Not built |
| Scheduled task dispatch (cron) | Phase 2+ | Not designed |
| Always-on daemon model | Phase 3? | Not designed |
