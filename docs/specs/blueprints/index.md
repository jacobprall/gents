# livectx-Powered Blueprints

**Status:** Proposed (Phase 2)
**Depends on:** agent/session schema split (Phase 1, landed), `@livectx/core`, `@gents/agent-ctx`

---

## Motivation

Blueprints define agent personalities — the system prompt, tools, permissions, and skills that shape what an agent can do and how it behaves. Phase 1 introduced discoverable JSON blueprints with a flat `systemInstructions` string. This works for simple cases but breaks down quickly:

- **No composition.** Two blueprints can't share a common base (e.g. "all agents should have repo awareness") without copy-pasting instructions.
- **No live data.** System prompt sections that depend on runtime state (git status, linter output, file tree) must be hardcoded as tool calls rather than pre-resolved into context.
- **No caching story.** Static context (project description, coding standards) gets re-sent every turn at full cost; Anthropic's prompt caching requires explicit `cache_control` placement that a flat string can't express.
- **No staleness control.** Some context should refresh every turn (git diff), some every 5 minutes (file tree), some never (project description). A string can't encode this.

`@livectx/core` already solves all of this with a binding-based context assembly pipeline — dependency-ordered resolution, SWR caching, static/dynamic placement with cache breakpoints, and composable templates. OpenForge v2 uses it in production. This spec wires it into gents blueprints.

---

## Design

### Blueprint file format

Blueprints remain JSON files in `.gents/blueprints/`, but `systemInstructions` is replaced by a `context` block that declares livectx bindings by referencing named resolvers:

```json
{
  "name": "code-reviewer",
  "description": "Reviews PRs and suggests improvements",
  "context": {
    "bindings": [
      {
        "key": ["system", "base"],
        "resolver": "system-instructions",
        "placement": "static",
        "params": {
          "persona": "You are a meticulous code reviewer...",
          "style": "concise, constructive, cite line numbers"
        }
      },
      {
        "key": ["repo", "filetree"],
        "resolver": "file-tree",
        "placement": "static",
        "staleTime": "5m"
      },
      {
        "key": ["repo", "git-status"],
        "resolver": "git-status",
        "placement": "dynamic",
        "staleTime": "30s"
      },
      {
        "key": ["skills", "catalog"],
        "resolver": "skill-catalog",
        "placement": "dynamic"
      }
    ],
    "template": "default"
  },
  "tools": [],
  "permissions": [],
  "excludePatterns": [],
  "config": {}
}
```

Backward compat: blueprints with `systemInstructions` (no `context` block) continue to work — they're internally converted to a single `system-instructions` binding with the string as `params.text`.

### Named resolver registry

A new resolver registry in `@gents/agent-ctx` maps string names to livectx binding factories:

```typescript
interface ResolverDef<P = unknown> {
  name: string;
  description: string;
  defaultPlacement: "static" | "dynamic";
  defaultStaleTime?: string;
  paramsSchema?: Record<string, unknown>;
  createBinding(params: P): AnyBinding;
}

interface ResolverRegistry {
  register(def: ResolverDef): void;
  get(name: string): ResolverDef | undefined;
  list(): ResolverDef[];
  buildBindings(specs: BindingSpec[]): AnyBinding[];
}
```

Each resolver factory receives params from the blueprint JSON and returns a livectx `Binding` (via `source()`). The registry handles key assignment, placement defaults, and staleTime parsing.

### Built-in resolvers

| Resolver | Key prefix | Placement | staleTime | Description |
|----------|-----------|-----------|-----------|-------------|
| `system-instructions` | `["system", "base"]` | static | ∞ | Core persona and behavioral instructions. `params.persona` for identity, `params.style` for tone, or `params.text` for raw text. |
| `file-tree` | `["repo", "filetree"]` | static | 5m | Workspace file tree summary from the index. |
| `git-status` | `["repo", "git-status"]` | dynamic | 30s | `git status --short` output. |
| `git-diff` | `["repo", "git-diff"]` | dynamic | 0 | Staged + unstaged diff summary. |
| `skill-catalog` | `["skills", "catalog"]` | dynamic | 0 | Available skills from the DB. |
| `coding-standards` | `["repo", "standards"]` | static | 10m | `.gents/rules/*.md` or `.cursor/rules/*.md` content. |
| `recent-errors` | `["repo", "errors"]` | dynamic | 0 | Recent build/lint errors from workspace. |
| `conversation` | `["session", "history"]` | dynamic | 0 | Session conversation history (special — wired to `conversationResolver`). |

Users can register custom resolvers via `.gents/resolvers/` (TypeScript files, future extension point).

### Template system

Templates control ordering and cache breakpoints. The `"template"` field in a blueprint references a named template or defaults to `"default"`:

```typescript
// Default template: static bindings → cache breakpoint → dynamic bindings
function defaultTemplate(bindings: AnyBinding[]): Template {
  const statics = bindings.filter(b => b.__def.placement === "static");
  const dynamics = bindings.filter(b => b.__def.placement === "dynamic");

  return prompt`
    ${statics}
    ${cacheBreakpoint()}
    ${dynamics}
  `;
}
```

The cache breakpoint placement is critical — everything before it benefits from Anthropic's prompt caching ($0.30/MTok vs $3/MTok). Static bindings (system instructions, file tree, coding standards) naturally go before the breakpoint; dynamic bindings (git status, errors, skill catalog) go after.

### Integration with `@gents/agent-ctx`

The existing `Section`-based `definePrompt` system is preserved as the low-level API. A new `definePromptFromBindings` function bridges livectx bindings into the existing assembly pipeline:

```typescript
import { createContextClient, rawSink, assembleTemplate } from "@livectx/core";

function definePromptFromBindings(config: {
  bindings: AnyBinding[];
  template?: Template;
  conversationResolver?: ConversationResolver;
  tools?: AnthropicToolDef[];
}): Prompt {
  const client = createContextClient();

  // Register all bindings with the client
  for (const binding of config.bindings) {
    client.register(binding);
  }

  return {
    async assemble(db, context) {
      const template = config.template ?? defaultTemplate(config.bindings);
      const result = await client.assemble({
        template,
        sink: rawSink(),
        onBindingError: "fallback-or-omit",
      });

      // Map rawSink output to the existing AssembleResult shape
      const system = result.segments.map(seg => ({
        type: "text" as const,
        text: seg.text,
        ...(seg.placement === "static" ? { cache_control: { type: "ephemeral" as const } } : {}),
      }));

      let messages = [];
      if (config.conversationResolver) {
        const raw = await config.conversationResolver(db, context);
        messages = formatConversation(raw);
      }

      return { system, messages, tools: config.tools ?? [] };
    },
  };
}
```

This preserves backward compatibility — `definePrompt` with `Section[]` still works, and `definePromptFromBindings` produces the same `Prompt` interface. The agent loop doesn't know or care which one built the prompt.

---

## Data flow

```
Blueprint JSON
  ↓ parse context.bindings[]
  ↓ resolve each { resolver, params } via ResolverRegistry
  ↓ returns AnyBinding[]
  ↓
  ├─→ createContextClient().register(binding) for each
  ├─→ template = buildTemplate(bindings) or named template
  │
  ↓ on each turn: prompt.assemble(db, ctx)
  ↓ client.assemble({ template, sink: rawSink() })
  ↓
  ├─→ topologicalSort → parallel wave resolution
  │     ├─→ cache check (staleTime) → serve from cache or fetch
  │     └─→ fetch(deps, { signal, client }) → render → text
  ├─→ segment by placement (static / dynamic / cache breakpoint)
  ├─→ format to ContentBlock[] with cache_control
  │
  ↓ conversationResolver → formatConversation → messages
  ↓
  AssembleResult { system, messages, tools }
  ↓
  Provider (Anthropic / OpenAI / Google)
```

---

## Dependency changes

| Package | Change |
|---------|--------|
| `@gents/agent-ctx` | Add `@livectx/core` as dependency (`workspace:*`). Add `definePromptFromBindings`, `ResolverRegistry`, built-in resolvers. |
| `@gents/agent-db` | Add `context` field parsing to blueprint types. `AgentBlueprint.context?: BlueprintContext`. |
| `apps/cli` | Update `createDefaultPrompt` to check for livectx context in blueprint config; fall back to current Section-based prompt. |

No changes to `@gents/agent-loop`, `@gents/agent-hooks`, or `@gents/agent-tools` — the `Prompt` interface is the boundary.

---

## Migration from Phase 1

Phase 1 blueprints with `systemInstructions`:

```json
{ "name": "my-agent", "systemInstructions": "You are a helpful assistant..." }
```

Automatically convert at load time:

```typescript
if (blueprint.systemInstructions && !blueprint.context) {
  blueprint.context = {
    bindings: [
      {
        key: ["system", "base"],
        resolver: "system-instructions",
        placement: "static",
        params: { text: blueprint.systemInstructions },
      },
      {
        key: ["skills", "catalog"],
        resolver: "skill-catalog",
        placement: "dynamic",
      },
    ],
    template: "default",
  };
}
```

---

## What this enables

- **Blueprint composition.** A `code-reviewer` blueprint can share `file-tree` and `coding-standards` bindings with a `general` blueprint by referencing the same resolvers.
- **Efficient caching.** Static bindings (persona, file tree, standards) land before the cache breakpoint — on subsequent turns they hit Anthropic's prompt cache at 90% discount.
- **Freshness control.** `git-status` refreshes every 30s; `file-tree` every 5m; `system-instructions` never. Each binding controls its own staleness.
- **SWR for free.** If `file-tree` is stale but not expired, livectx serves the cached version immediately and refreshes in the background — zero latency hit.
- **Custom resolvers.** Users add `.gents/resolvers/my-resolver.ts` to inject custom context (Jira tickets, Slack threads, monitoring data) into any agent's prompt.
- **Cloud parity.** The same binding + template model works for cloud-hosted agents via `@gents/runner`, with the `livectx` field already specced in `RunnerSpec`.

---

## Open questions

1. **Resolver TypeScript loading.** Custom `.gents/resolvers/*.ts` files need evaluation at runtime. Options: Bun's native `import()`, a bundler step, or restrict to JSON-only params with built-in resolvers for v1.
2. **Tool bindings.** livectx supports `tool()` bindings that expose context-fetching as LLM-callable tools (e.g. "search Jira"). Should blueprint `tools[]` merge with livectx tool bindings, or stay separate?
3. **Budget enforcement.** livectx supports `Budget.maxTokensPerAssembly`. Should this replace or supplement `maxSystemTokens` in the ctx package?
4. **Sink adapter.** Currently using `rawSink()` and reshaping to `ContentBlock[]`. If gents adds OpenAI/Google native providers, should we use provider-specific sinks instead?

---

## Non-goals

- **Replacing `definePrompt`.** The Section-based API remains the escape hatch for programmatic prompt construction (child loops, custom tools).
- **Multi-provider sink abstraction.** Phase 2 uses `rawSink()` only. Provider-specific sinks are a future optimization.
- **Visual blueprint editor.** Blueprints are JSON files edited by hand or by agents. A UI is out of scope.
