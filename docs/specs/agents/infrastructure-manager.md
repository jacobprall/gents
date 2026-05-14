# Agent Spec: infrastructure_manager

A cloud agent with live infrastructure awareness that can monitor health, manage services, and spin up preview environments.

---

## Trigger

Multiple trigger modes:

| Trigger | Use Case |
|---|---|
| GitHub PR webhook | Spin up preview environment for the PR |
| Manual (CLI dispatch / dashboard) | "Scale up the API service" / "Debug why staging is slow" |
| Scheduled (cron-style, future) | Periodic health check and remediation |

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

## Context

This is a **Tier 3 custom agent** — it opts into livectx bindings for ambient infrastructure awareness. Unlike standard agents that fetch remote data on-demand via tools, this agent gets live service health and deploy status injected into its context every turn.

```typescript
const infraManagerLivectx: LivectxConfig = {
  bindings: [
    {
      key: "service-health",
      source: "render",
      resolver: "render.listServices",
      staleTime: "10s",
      placement: "dynamic",
    },
    {
      key: "deploy-status",
      source: "render",
      resolver: "render.getLatestDeploy",
      staleTime: "30s",
      placement: "dynamic",
    },
    {
      key: "pr-state",
      source: "github",
      resolver: "github.pulls.get",
      staleTime: "30s",
      placement: "dynamic",
    },
  ],
};
```

Static sections (system prompt, project config) are cached via Anthropic `cache_control`. Dynamic livectx sections refresh on their staleTime schedule — the agent always sees current infra status without explicit tool calls.

The agent also has Render tools available for mutating operations (scale, restart, create preview) — livectx provides read awareness, tools provide write actions.

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

Discrete tasks via runners. Each trigger creates a new task, a runner spins up a sandbox, executes, and exits.

- **Webhook-triggered** (PR opened → preview): runner receives the spec, creates preview, posts URL, exits
- **Manually dispatched** ("debug why staging is slow"): runner investigates via tools, reports findings, exits
- **Scheduled** (future, daily health check): recurring dispatch creates fresh tasks on a cron

---

## Example Flows

### PR Preview Environment

```
1. GitHub PR opened → routing rule matches → runner dispatched (blueprint: infrastructure-manager)
2. Agent reads PR metadata via github tools
3. Agent calls render_create_preview for the PR branch
4. Agent waits for deploy to succeed (polls via render_get_deploy_status)
5. Agent posts preview URL as PR comment via github_add_pr_comment
6. Task completes

(On PR close: separate task created to tear down preview)
```

### Health Check + Remediation

```
1. Cron triggers task creation (blueprint: infrastructure-manager)
2. Agent checks live service health via render tools
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
| Next.js app (webhook handler + task dispatch) | Phase 2, M8 | Not built |
| Runner package (`@gents/runner`) | Phase 2, M7 | Not built |
| Render API tools | Phase 2 | Not built |
| GitHub API tools | Phase 2 | Not built |
| Scheduled task dispatch (cron) | Phase 3 | Not designed |
