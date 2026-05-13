# gents — Context Layer (ctx)

A minimal prompt assembly layer. No SWR cache, no dependency graphs, no subscriptions. Just declarative prompt composition with LLM prefix caching.

---

## Why This Exists

Two problems this solves:

1. **Prompt composition** — A coding agent's prompt has many sections (system identity, project context, search results, conversation history, tool definitions). These sections need to be assembled differently depending on the model, the turn number, and what's happening. A declarative system is cleaner than string concatenation.

2. **LLM prefix caching** — Anthropic caches prompt prefixes that are identical across requests. If you structure your prompt so stable content (system prompt, project overview) comes before volatile content (current search results, recent messages), Anthropic caches the prefix and charges 90% less for those tokens on subsequent turns. Over a 20-turn session with 50k context, this saves significant money.

---

## Design

### Sections

A prompt is a sequence of named sections. Each section has:

- **name** — identifier for debugging/inspection
- **placement** — `static` (before cache break) or `dynamic` (after cache break)
- **resolve** — function that returns the section content, given the agent database

```typescript
interface Section {
  name: string;
  placement: "static" | "dynamic";
  resolve: (db: AgentDB, context: AssemblyContext) => string | ContentBlock[];
}
```

### Cache Breakpoint

A marker between static and dynamic sections. Everything before the breakpoint is expected to be identical across turns — the sink adapter adds Anthropic's `cache_control` marker on the last static block.

### Assembly

```typescript
interface AssembleResult {
  system: SystemMessage[];       // system blocks with cache_control on last static
  messages: ConversationMessage[]; // user/assistant/tool messages
  tools: ToolDefinition[];       // tool schemas for the model
}
```

---

## API

### definePrompt

```typescript
function definePrompt(config: {
  sections: Section[];
  tools?: ToolDefinition[];
}): Prompt;
```

### prompt.assemble

```typescript
function assemble(db: AgentDB, context: AssemblyContext): AssembleResult;
```

The assembly process:
1. Resolve all static sections in order
2. Concatenate static content into system message blocks
3. Mark the last static block with `cache_control: { type: "ephemeral" }`
4. Resolve all dynamic sections
5. Format conversation messages from dynamic sections + db messages
6. Return the complete prompt structure ready for Anthropic's API

---

## Sections for a Coding Agent

```typescript
const codingAgentPrompt = definePrompt({
  sections: [
    // STATIC — cached across turns
    {
      name: "identity",
      placement: "static",
      resolve: () => SYSTEM_IDENTITY,
    },
    {
      name: "project-overview",
      placement: "static",
      resolve: (db) => {
        const stats = getLanguageStats(db);
        const tree = getFileTreeSummary(db);
        return formatProjectOverview(stats, tree);
      },
    },
    {
      name: "conventions",
      placement: "static",
      resolve: (db) => {
        // Read .gents/rules or project conventions
        return getProjectRules(db);
      },
    },

    // DYNAMIC — changes each turn
    {
      name: "search-context",
      placement: "dynamic",
      resolve: (db, ctx) => {
        if (!ctx.searchQuery) return "";
        const results = hybridSearch(db, ctx.searchQuery);
        return formatSearchResults(results);
      },
    },
    {
      name: "conversation",
      placement: "dynamic",
      resolve: (db) => getConversation(db),
    },
  ],
  tools: getRegisteredTools(),
});
```

---

## Output Format (Anthropic)

The assembled prompt produces the exact shape for `anthropic.messages.create()`:

```typescript
{
  system: [
    {
      type: "text",
      text: "You are gents, a software engineering agent...",
    },
    {
      type: "text",
      text: "## Project Overview\n\nTypeScript monorepo with 47 files...",
      cache_control: { type: "ephemeral" },  // ← caches everything up to here
    },
  ],
  messages: [
    { role: "user", content: "Fix the auth bug in login.ts" },
    { role: "assistant", content: "...", tool_use: [...] },
    { role: "user", content: [{ type: "tool_result", ... }] },
    // ...current turn
  ],
  tools: [
    { name: "file_read", description: "...", input_schema: {...} },
    { name: "code_search", description: "...", input_schema: {...} },
    // ...
  ],
}
```

---

## Adding Other Providers (Future)

The section system is provider-agnostic. Only the final formatting step is Anthropic-specific. To add OpenAI:

```typescript
function formatForOpenAI(sections: ResolvedSection[], messages: Message[], tools: Tool[]): OpenAIRequest;
```

Different providers have different caching mechanisms (or none). The breakpoint remains useful as a logical separator even without provider-specific caching support.

---

## Differences from livectx

| livectx | gents/ctx |
|---|---|
| SWR cache with staleTime/gcTime | No cache (SQLite reads are fast enough) |
| Async resolvers with retry | Sync resolvers (local DB reads) |
| Dependency graphs between bindings | No dependencies (sections are independent) |
| Push invalidation / subscriptions | No subscriptions (re-resolve each turn) |
| Multiple sink adapters | Anthropic only (add others as needed) |
| Budget accounting at context layer | Handled by hooks in the agent loop |
| Template tagged literal DSL | Plain function calls |
| General-purpose library | Purpose-built for gents agent |

The simplification is intentional. livectx solves problems that don't exist when your data is in a local database: network fetching, caching remote data, handling stale responses, async resolution ordering. With SQLite, resolvers are synchronous microsecond reads. The complexity budget goes elsewhere.
