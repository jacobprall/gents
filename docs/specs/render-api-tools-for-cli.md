# Render API Tools for CLI

**Status:** Proposed
**Depends on:** Phase 1 CLI, tool registry, config system

---

## Architecture Decision

- **CLI (local):** Render/GitHub data via on-demand **tools** — fits the "agent = function over DB" model
- **Cloud worker (Phase 2):** Render/GitHub data via **livectx prompt context** — ambient awareness for long-running tasks

Tools are the right abstraction locally because: the agent decides when to fetch, results flow through the normal tool-call/response cycle, and no second data plane is needed.

livectx introduces a second source of truth with its own lifecycle (SWR cache, push invalidation, subscriptions). That complexity is justified in the cloud worker where agents are long-running and need ambient infrastructure awareness. For the CLI — short sessions, user-driven queries — on-demand tools are simpler and fit the existing "agent = stateless function over DB" model.

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

Add a brief note under the "Dual Context Layer" section documenting the decision: tools for CLI, livectx for cloud worker.

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
| `docs/tech-decisions.md` | Document tools-local / livectx-cloud split |

---

## Not in scope

- GitHub API tools (follow-up)
- livectx integration in CLI prompt (deferred to cloud worker)
- Render MCP server (Phase 2)
- `render_scale_service`, `render_create_preview`, or any write/mutating operations (start read-only)

---

## Future: Cloud Worker with livectx

When the cloud worker is built, the same Render API calls will be wrapped as livectx `source()` bindings instead of tools:

```typescript
const renderServices = source({
  key: ["render", "services"],
  fetch: async () => renderApi.listServices(apiKey),
  staleTime: "30s",
  gcTime: "5m",
});
```

These will be injected as dynamic prompt sections via `definePrompt`, giving cloud agents ambient infrastructure awareness on every turn without explicit tool calls. The Render API client (`render-api.ts`) will be shared between the tool layer and the livectx layer.
