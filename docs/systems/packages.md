# gents — Package Reference

Every package, its responsibility, API surface, and dependencies.

---

## Package Map

```
packages/
  agent/
    db/       @gents/agent-db       SQLite database layer
    loop/     @gents/agent-loop     Agent execution engine
    ctx/      @gents/agent-ctx      Prompt assembly + LLM caching
    tools/    @gents/agent-tools    Tool registry + builtins
    hooks/    @gents/agent-hooks    Middleware pipeline
    otel/     @gents/agent-otel     OpenTelemetry instrumentation
    mcp/      @gents/agent-mcp      MCP server (internal + external)
  runner/     @gents/runner         Headless cloud execution (phase 2)
```

---

## @gents/agent-db

The foundation. SQLite + extensions for agent state, code search, and conversation.

### Dependencies
- `better-sqlite3` or Bun built-in SQLite
- sqlite-vector (native extension, loaded at runtime)
- sqlite-ai (native extension, loaded at runtime)

### Exports

```typescript
// Database lifecycle
createAgentDB(path: string, opts?: CreateDBOptions): AgentDB
createAgentDBFromBlueprint(path: string, blueprint: AgentBlueprint, opts?: CreateDBOptions): AgentDB
closeAgentDB(db: AgentDB): void

// Code indexing
indexCodebase(db: AgentDB, repoPath: string, opts?: IndexOptions): IndexResult
getIndexStatus(db: AgentDB): IndexStatus

// Hybrid search
hybridSearch(db: AgentDB, query: string, opts?: SearchOptions): SearchResult[]

// Conversation
appendMessage(db: AgentDB, message: NewMessage): Message
getConversation(db: AgentDB, opts?: ConversationOptions): Message[]
compactConversation(db: AgentDB, upToTurn: number, summary: string): void
getCurrentTurn(db: AgentDB): number

// Events
appendEvent(db: AgentDB, event: NewEvent): Event
getEvents(db: AgentDB, opts?: EventQueryOptions): Event[]
getLastEvent(db: AgentDB): Event | null

// Metrics
recordTurnMetrics(db: AgentDB, metrics: TurnMetrics): void
getSessionMetrics(db: AgentDB): SessionMetrics

// File tree
getFileTree(db: AgentDB): FileEntry[]
getFileTreeDiff(db: AgentDB, repoPath: string): TreeDiff

// Config
getConfig(db: AgentDB, key: string): string | null
setConfig(db: AgentDB, key: string, value: string): void

// Tools and permissions (from blueprint)
getEnabledTools(db: AgentDB): ToolDefinition[]
getPermissions(db: AgentDB): Permission[]
getExcludePatterns(db: AgentDB): string[]

// Tool cache
getCachedResult(db: AgentDB, toolName: string, input: string): string | null
setCachedResult(db: AgentDB, toolName: string, input: string, output: string): void

// Blueprints
interface AgentBlueprint {
  name: string
  tools: ToolDefinition[]
  permissions: Permission[]
  excludePatterns: string[]
  config: Record<string, string>
  seedMessages?: NewMessage[]
  systemInstructions?: string
}
```

### No dependencies on other gents packages.

---

## @gents/agent-loop

Stateless turn-based execution. Reads from db, calls LLM, writes results.

### Dependencies
- `@gents/agent-db`
- `@gents/agent-ctx`
- `@gents/agent-tools`
- `@gents/agent-hooks`
- `@gents/agent-otel`
- `@anthropic-ai/sdk`

### Exports

```typescript
// Loop creation
createAgentLoop(config: LoopConfig): AgentLoop

// Execution
interface AgentLoop {
  run(db: AgentDB, userMessage: string): AsyncGenerator<LoopEvent>
  step(db: AgentDB): AsyncGenerator<LoopEvent>
  resume(db: AgentDB): AsyncGenerator<LoopEvent>
}

// Configuration
interface LoopConfig {
  model: string                    // e.g. "claude-sonnet-4-20250514"
  apiKey: string
  tools: ToolRegistry
  hooks: HookPipeline
  ctx: Prompt
  maxIterations?: number           // default 25
  maxCostPerTurn?: number          // USD
  maxCostPerSession?: number       // USD
  onEvent?: (event: LoopEvent) => void
}

// Events emitted during execution
type LoopEvent =
  | { type: "turn.started"; turn: number }
  | { type: "llm.streaming"; delta: string }
  | { type: "llm.complete"; message: AssistantMessage }
  | { type: "tool.calling"; name: string; input: unknown }
  | { type: "tool.complete"; name: string; output: string }
  | { type: "tool.error"; name: string; error: string }
  | { type: "turn.complete"; turn: number; cost: Cost }
  | { type: "error"; error: Error }
  | { type: "paused"; reason: string }
```

### Execution Flow

```
run(db, userMessage):
  1. appendMessage(db, { role: "user", content: userMessage })
  2. appendEvent(db, { type: "turn.started" })
  3. yield { type: "turn.started" }
  4. Loop:
     a. Assemble context via ctx (reads from db)
     b. Run pre-LLM hooks
     c. Call Anthropic API (streaming)
     d. yield streaming deltas
     e. Run post-LLM hooks
     f. If tool_calls:
        - For each tool:
          - Run pre-tool hooks (governance check)
          - Execute tool
          - yield tool events
          - appendMessage(db, tool result)
          - appendEvent(db, tool event)
        - Continue loop
     g. If text response:
        - appendMessage(db, assistant message)
        - appendEvent(db, { type: "turn.complete" })
        - yield { type: "turn.complete" }
        - Return
```

### Resume

If the process was killed mid-turn, `resume(db)` reads the last event and continues:
- Last event is `turn.started` with no `turn.complete` → re-assemble and call LLM
- Last event is `tool.calling` with no `tool.complete` → re-execute the tool
- Last event is `turn.complete` → nothing to resume, return

---

## @gents/agent-ctx

Prompt assembly with Anthropic prefix caching.

### Dependencies
- `@gents/agent-db`

### Exports

```typescript
// Define a prompt structure
definePrompt(config: PromptConfig): Prompt

interface PromptConfig {
  sections: Section[]
  tools?: ToolDefinition[]
}

interface Section {
  name: string
  placement: "static" | "dynamic"
  resolve: (db: AgentDB, context: AssemblyContext) => string | ContentBlock[]
}

interface AssemblyContext {
  searchQuery?: string
  currentTurn?: number
  [key: string]: unknown
}

// Assemble for Anthropic API
interface Prompt {
  assemble(db: AgentDB, context: AssemblyContext): AssembleResult
}

interface AssembleResult {
  system: AnthropicSystemBlock[]
  messages: AnthropicMessage[]
  tools: AnthropicToolDef[]
}
```

---

## @gents/agent-tools

Tool registry with Zod schema validation and built-in implementations.

### Dependencies
- `@gents/agent-db`
- `zod`

### Exports

```typescript
// Registry
createToolRegistry(): ToolRegistry

interface ToolRegistry {
  register(tool: ToolDefinition): void
  get(name: string): ToolDefinition | undefined
  list(): ToolDefinition[]
  listForLLM(): AnthropicToolDef[]
  execute(name: string, input: unknown, context: ToolContext): Promise<string>
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: ZodSchema
  execute: (input: unknown, context: ToolContext) => Promise<string>
}

interface ToolContext {
  db: AgentDB
  repoPath: string
  workingDir: string
  signal?: AbortSignal
}

// Built-in tool factories
registerBuiltinTools(registry: ToolRegistry): void
```

### Built-in Tools

| Tool | Input | Description |
|---|---|---|
| `file_read` | `{ path, startLine?, endLine? }` | Read file contents |
| `file_write` | `{ path, content }` | Write/create file |
| `file_edit` | `{ path, oldString, newString }` | Targeted string replacement |
| `code_search` | `{ query, limit?, languages?, paths? }` | Hybrid BM25 + vector search |
| `file_search` | `{ pattern, path? }` | Glob file finding |
| `bash` | `{ command, timeout? }` | Shell execution |
| `git_status` | `{}` | Git status |
| `git_diff` | `{ staged? }` | Show diff |
| `git_commit` | `{ message, files? }` | Stage and commit |
| `compact_conversation` | `{ up_to_turn, summary }` | Compact old messages |

---

## @gents/agent-hooks

Composable middleware pipeline for governance and safety.

### Dependencies
- None (pure middleware abstractions)

### Exports

```typescript
// Pipeline
createHookPipeline(hooks: Hook[]): HookPipeline

interface HookPipeline {
  runPreLLM(context: HookContext): HookResult
  runPostLLM(context: HookContext, response: LLMResponse): HookResult
  runPreTool(context: HookContext, tool: string, input: unknown): HookResult
  runPostTool(context: HookContext, tool: string, output: string): HookResult
}

type HookResult =
  | { action: "continue" }
  | { action: "continue"; transformed: unknown }
  | { action: "reject"; reason: string }
  | { action: "pause"; reason: string }

// Built-in hooks
costGuard(config: CostGuardConfig): Hook
credentialRedactor(config: RedactorConfig): Hook
toolGovernance(config: GovernanceConfig): Hook
confirmationGate(config: ConfirmationConfig): Hook
```

### Hook Types

**Cost Guard:**
```typescript
costGuard({
  maxCostPerTurn: 0.50,      // USD
  maxCostPerSession: 10.00,  // USD
  onExceeded: "pause",       // "pause" | "reject"
})
```

**Credential Redactor:**
```typescript
credentialRedactor({
  patterns: [
    /sk-[a-zA-Z0-9]{20,}/,              // API keys
    /ghp_[a-zA-Z0-9]{36}/,              // GitHub tokens
    /-----BEGIN.*PRIVATE KEY-----/s,      // Private keys
  ],
  replacement: "[REDACTED]",
})
```

**Tool Governance:**
```typescript
toolGovernance({
  allowedTools: ["file_read", "code_search", "bash"],
  deniedTools: ["file_write"],  // or use allowedTools as allowlist
  pathRestrictions: {
    allow: ["src/**", "tests/**"],
    deny: ["node_modules/**", ".env*"],
  },
})
```

**Confirmation Gate (CLI only):**
```typescript
confirmationGate({
  requireConfirmation: ["bash", "file_write", "git_commit"],
  promptFn: async (tool, input) => {
    // Show user what's about to happen, get y/n
    return await confirm(`Execute ${tool}?`);
  },
})
```

---

## @gents/agent-otel

Optional OpenTelemetry instrumentation. No-op when not configured.

### Dependencies
- `@opentelemetry/api`
- `@opentelemetry/sdk-trace-node` (optional, for exporting)

### Exports

```typescript
// Initialization
initTelemetry(config?: OtelConfig): void

// Decorators / wrappers
traced(name: string, fn: Function): Function
withSpan(name: string, attributes?: Record<string, string>): SpanHandle

// Metrics
recordTokenUsage(model: string, tokensIn: number, tokensOut: number): void
recordCost(model: string, costUsd: number): void
recordToolCall(toolName: string, durationMs: number, success: boolean): void
recordSearchLatency(searchType: string, durationMs: number): void
```

---

## @gents/agent-mcp

MCP server exposing agent-db operations.

### Dependencies
- `@gents/agent-db`
- `@gents/agent-tools`
- `@modelcontextprotocol/sdk`

### Exports

```typescript
// Server creation
createMCPServer(db: AgentDB, config?: MCPServerConfig): MCPServer

interface MCPServerConfig {
  tools?: string[]           // subset of tools to expose (default: all)
  resources?: boolean        // expose MCP resources (default: true)
}

// Transport
interface MCPServer {
  serveStdio(): void                        // for CLI: gents mcp
  serveHTTP(port: number): void             // for cloud (future)
  handleRequest(request: MCPRequest): MCPResponse  // for direct use
}
```

---

## @gents/runner (Phase 2)

Agent execution for Render Workflows. The runner runs the agent loop **inside the workflow** and executes tools against a remote sandbox over HTTP. Optionally composes livectx bindings for custom agents that need live awareness.

### Dependencies
- `@gents/agent-db`
- `@gents/agent-loop`
- `@gents/agent-ctx`
- `@gents/agent-tools`
- `@gents/agent-hooks`
- `@livectx/core` (optional, for custom agents with live context)

### Exports

```typescript
// Runner entry point (called inside a Render Workflow)
runTask(spec: RunnerSpec, sandbox: Sandbox): Promise<TaskResult>

// Spec provided when dispatching a workflow
interface RunnerSpec {
  taskId: string
  repo: string
  ref: string
  blueprint: string
  instructions: string
  callbackUrl: string         // POST events back here
  constraints: {
    maxTurns: number
    maxCostUsd: number
    timeoutMinutes: number
  }
  secrets: {
    anthropicKey: string
    githubToken: string
  }
  preserveDb?: boolean        // upload agent.db on completion for debugging
  livectx?: LivectxConfig     // opt-in live context for custom agents
}

interface TaskResult {
  status: "completed" | "failed" | "cancelled" | "timeout"
  turnCount: number
  costUsd: number
  result?: Record<string, unknown>  // PR URL, comments posted, etc.
  error?: string
}

// Sandbox interface (remote execution over HTTP)
interface Sandbox {
  id: string
  url: string
  exec(command: string, opts?: { cwd?: string; timeout?: number }): Promise<ExecResult>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  listDir(path: string, opts?: { recursive?: boolean }): Promise<DirEntry[]>
}

interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

// Service abstractions (used by the Next.js app)
interface SandboxService {
  create(config: SandboxConfig): Promise<Sandbox>
  destroy(sandboxId: string): Promise<void>
}

interface WorkflowService {
  dispatch(spec: RunnerSpec): Promise<{ workflowId: string }>
  getStatus(workflowId: string): Promise<WorkflowStatus>
  cancel(workflowId: string): Promise<void>
}

// Remote tool registry (tools execute against sandbox over HTTP)
createRemoteToolRegistry(sandbox: Sandbox): ToolRegistry

// Event reporting
interface EventReporter {
  postEvents(taskId: string, events: LoopEvent[]): Promise<void>
  fetchMessages(taskId: string): Promise<SteeringMessage[]>
  reportCompletion(taskId: string, result: TaskResult): Promise<void>
}

createEventReporter(callbackUrl: string): EventReporter

// livectx composition (for custom agents)
interface LivectxConfig {
  bindings: LivectxBinding[]
}

interface LivectxBinding {
  key: string
  source: "render" | "github" | "custom"
  resolver: string
  staleTime: string
  placement: "static" | "dynamic"
}
```

### Execution Model

The agent loop runs in the Render Workflow. The sandbox is a remote execution target.

```
Render Workflow (the brain):        Sandbox (the hands):
┌─────────────────────────┐        ┌─────────────────────────┐
│  agent-db (SQLite)       │        │  /workspace (cloned repo)│
│  agent-loop              │        │  git, node, python, etc. │
│  ctx assembly            │  HTTP  │  file system             │
│  LLM calls (Anthropic)  │◄──────►│  shell execution         │
│  code_search (local)     │        │  no agent code           │
│  event reporting         │        │  no LLM keys             │
└─────────────────────────┘        └─────────────────────────┘
```

### Execution Flow

```
1. Render Workflow starts, receives RunnerSpec
2. Provision sandbox via SandboxService (E2B, Fly, etc.)
3. Clone repo + install deps in sandbox (HTTP exec calls)
4. createAgentDB locally in workflow process
5. Index codebase (read files from sandbox over HTTP, embed locally)
6. createAgentLoop with remote tool registry:
   - bash, file_read, file_write, git_* → execute in sandbox over HTTP
   - code_search, compact_conversation → execute locally against agent-db
   - If livectx configured: compose ctx with live sources
7. Loop:
   a. Run agent turn (LLM call in workflow, tool execution in sandbox)
   b. Post events to callbackUrl
   c. Poll for steering messages
   d. If messages: inject as user turns, continue
   e. If constraints exceeded or agent finished: exit loop
8. Report completion
9. Optionally upload agent.db
10. Destroy sandbox via SandboxService
```

### Sandbox Providers

| Provider | Implementation | Best For |
|---|---|---|
| E2B | `E2BSandboxService` | Production — fast startup, AI-optimized |
| Fly Machines | `FlySandboxService` | Self-managed, low-latency VMs |
| Modal | `ModalSandboxService` | GPU workloads, serverless |
| Docker | `DockerSandboxService` | Local development and testing |

### livectx for Custom Agents

Standard blueprints use the same ctx layer as local — tools for on-demand data. Custom agents that need ambient awareness can opt into livectx:

```typescript
if (spec.livectx) {
  const liveSections = spec.livectx.bindings.map(binding =>
    source({
      key: [binding.source, binding.key],
      resolver: resolveBinding(binding),
      staleTime: binding.staleTime,
      placement: binding.placement,
    })
  );
  ctx = compose(baseCtx, liveSections);
}
```

livectx is a workflow-level concern, not a platform-level one. Most agents never use it.
