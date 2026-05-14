# Render API Tools for CLI

**Status:** Proposed
**Depends on:** Phase 1 CLI, tool registry, config system

---

## Architecture Decision

- **Everywhere (CLI + cloud runners):** Render/GitHub data via on-demand **tools** — fits the "agent = function over DB" model

Tools are the right abstraction because: the agent decides when to fetch, results flow through the normal tool-call/response cycle, and no second data plane is needed. This applies equally to the local CLI and cloud runners — one pattern everywhere.

---

## Scope

### 1. Extend CLI config for Render API key

`apps/cli/src/config.ts` — add optional `renderApiKey` to `ResolvedConfig`:

```typescript
export interface ResolvedConfig {
  apiKey: string;
  model: string;
  maxCostPerSession?: number;
  confirmDestructive: boolean;
  autoIndex: boolean;
  renderApiKey?: string;
}
```

Resolution chain: `flags.renderApiKey` → `RENDER_API_KEY` env var → `~/.gents/config.json` `render_api_key`. No error if missing — tools simply won't register.

### 2. Create a Render API client utility

New file: `packages/agent/tools/src/render-api.ts`

Thin fetch wrapper for the Render REST API (`https://api.render.com/v1`). No external dependencies — just native `fetch` with Bearer token auth. Functions:

- `listServices(apiKey, filters?)` — `GET /services`
- `getService(apiKey, serviceId)` — `GET /services/{serviceId}`
- `listDeploys(apiKey, serviceId, limit?)` — `GET /services/{serviceId}/deploys`
- `getDeploy(apiKey, serviceId, deployId)` — `GET /services/{serviceId}/deploys/{deployId}`

Returns typed responses. Handles pagination cursor for `listServices`.

### 3. Create Render tools

New file: `packages/agent/tools/src/tools/render.ts`

Three tools following the existing `ToolDefinition` pattern (zod schema, execute function, string output):

| Tool | Purpose |
|---|---|
| `render_list_services` | List all services with name, type, status, region, last deploy time. Quick infrastructure overview. |
| `render_get_service` | Get detailed info for a specific service by ID or name. |
| `render_get_deploys` | Get recent deploys for a service, including status, commit, and timing. |

Each tool reads `context.renderApiKey` to authenticate. Tools return formatted text (not raw JSON) for efficient token usage.

### 4. Extend ToolContext with optional credentials

`packages/agent/tools/src/types.ts` — add optional API keys to `ToolContext`:

```typescript
export interface ToolContext {
  db: AgentDB;
  repoPath: string;
  workingDir: string;
  signal?: AbortSignal;
  childLoopFactory?: ChildLoopFactory;
  renderApiKey?: string;
}
```

### 5. Conditional tool registration

`apps/cli/src/commands/chat.ts` — register Render tools only when `config.renderApiKey` is present:

```typescript
import { renderTools } from "@gents/agent-tools";

if (config.renderApiKey) {
  for (const tool of renderTools) {
    registry.register(tool);
  }
}
```

Pass `renderApiKey` through to the tool context when creating the agent loop.

### 6. Update tech-decisions.md

Add a brief note documenting the decision: tools for remote data access everywhere (CLI and cloud runners).

---

## Files Changed

| File | Change |
|---|---|
| `apps/cli/src/config.ts` | Add `renderApiKey` to `ResolvedConfig` and resolution |
| `packages/agent/tools/src/types.ts` | Add `renderApiKey?` to `ToolContext` |
| `packages/agent/tools/src/render-api.ts` | **New** — Render REST API client |
| `packages/agent/tools/src/tools/render.ts` | **New** — 3 Render tool definitions |
| `packages/agent/tools/src/register-builtins.ts` | Export `renderTools` array (not auto-registered) |
| `apps/cli/src/commands/chat.ts` | Conditional Render tool registration + context wiring |
| `docs/tech-decisions.md` | Document tools-everywhere decision |

---

## Not in scope

- GitHub API tools (follow-up)
- `render_scale_service`, `render_create_preview`, or any write/mutating operations (start read-only)

---

## Future: Additional Render Tools

When cloud runners are built, they'll use the same Render API tools. Additional mutating tools can be added:

| Tool | Purpose |
|---|---|
| `render_scale_service` | Change instance count/plan |
| `render_restart_service` | Restart a service |
| `render_create_preview` | Spin up preview env for a branch/PR |
| `render_delete_preview` | Tear down preview env |

The Render API client (`render-api.ts`) is shared between local CLI tools and cloud runner tools — same code, same patterns.
