# Local Text Generation via sqlite-ai

**Status:** Proposed
**Depends on:** agent-db (sqlite-ai extension already loaded), workspace DB, sessions

---

## Motivation

gents already runs Nomic Embed locally via sqlite-ai for code search embeddings. The same extension exposes `llm_text_generate()` and `llm_chat_respond()` for text completion — meaning local text generation requires no new native dependencies, just a second GGUF model.

This unlocks several features that currently require a cloud LLM call (or don't exist at all):

- **Session auto-naming** — generate a short label from the first user message, zero-cost
- **Compaction summaries** — summarize conversation history locally instead of burning API tokens
- **Commit message drafting** — generate conventional commit messages from diffs
- **Offline chat** — basic conversational ability with no API key or network

All of these are low-stakes text generation tasks where a 0.5B model is sufficient and a 70B model is wasteful.

---

## Key Insight: sqlite-ai Already Supports This

The sqlite-ai extension gents already loads provides a complete text generation API:

```sql
SELECT llm_model_load('./models/qwen2.5-0.5b-instruct-q4_k_m.gguf', 'gpu_layers=99');
SELECT llm_context_create_textgen('context_size=2048,n_predict=256');
SELECT llm_text_generate('Summarize this conversation in 5 words: ...');
```

sqlite-ai state is **per-connection** in SQLite. This means we can keep the existing workspace DB connection with Nomic Embed loaded for embeddings, and open a separate connection with a text generation model loaded — no model swapping, no interference.

---

## Model Choice: Qwen2.5-0.5B-Instruct (Q4_K_M)

| Property | Value |
|---|---|
| Parameters | 0.5B |
| Quantization | Q4_K_M |
| Download size | ~400MB |
| RAM usage | ~500MB |
| Context window | 32K (we use 2-4K) |
| Speed (Apple Silicon) | ~80-120 tok/s |
| Instruction following | Good for its size |

**Why this model:**
- Small enough to download on first use without friction (same pattern as Nomic Embed ~150MB)
- Fast enough that session naming feels instant (<500ms for a 10-token label)
- Instruction-following quality is sufficient for structured extraction tasks
- Qwen2.5 family is well-supported in llama.cpp / GGUF ecosystem
- Q4_K_M is the sweet spot for quality/size on small models

**Why not larger:**
- 1.5B+ models add 1-2GB download and proportionally more RAM for marginal quality gains on these simple tasks
- The tasks (naming, summarizing, commit messages) are constrained-output — a small model with good prompting is enough

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Process                         │
│                                                         │
│  ┌──────────────────────┐  ┌────────────────────────┐  │
│  │   Workspace DB        │  │   Local Gen Connection  │  │
│  │   (existing)          │  │   (new)                 │  │
│  │                       │  │                         │  │
│  │   Nomic Embed 1.5     │  │   Qwen2.5-0.5B-Instruct│  │
│  │   llm_embed_generate  │  │   llm_text_generate     │  │
│  │   code search         │  │   session naming        │  │
│  │                       │  │   compaction summaries   │  │
│  │                       │  │   commit messages        │  │
│  └──────────────────────┘  └────────────────────────┘  │
│                                                         │
│  ┌──────────────────────┐  ┌────────────────────────┐  │
│  │   Agent DB            │  │   Cloud LLM Provider    │  │
│  │   (existing)          │  │   (existing)            │  │
│  │                       │  │                         │  │
│  │   conversations       │  │   Anthropic / OpenAI /  │  │
│  │   events, metrics     │  │   Google                │  │
│  │   sessions            │  │   main agent reasoning  │  │
│  └──────────────────────┘  └────────────────────────┘  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

The local gen connection is a **dedicated SQLite connection** (can be in-memory or to a small helper file) that loads sqlite-ai with the text generation model. It is completely independent of the workspace DB's embedding model.

---

## New Package: `@gents/agent-local-gen`

A thin wrapper over sqlite-ai's text generation API. Lives at `packages/agent/local-gen/`.

### Interface

```typescript
export interface LocalGenOptions {
  modelPath: string;       // path to GGUF file
  contextSize?: number;    // default 2048
  maxPredict?: number;     // default 256
  gpuLayers?: number;      // default 99
  temperature?: number;    // default 0.3 (low for deterministic tasks)
}

export interface LocalGen {
  generate(prompt: string, opts?: { maxTokens?: number; temperature?: number }): string;
  isAvailable(): boolean;
  close(): void;
}

export function createLocalGen(options: LocalGenOptions): LocalGen;
```

### Implementation

`createLocalGen` opens a fresh SQLite connection (in-memory), loads the sqlite-ai extension, then:

```sql
SELECT llm_model_load(?, ?);           -- model path + gpu_layers
SELECT llm_context_create_textgen(?);  -- context_size, n_predict
SELECT llm_sampler_init_greedy();      -- deterministic for naming/summarization
```

`generate()` calls:

```sql
SELECT llm_text_generate(?, ?);        -- prompt + n_predict override
```

`close()` frees the context and model:

```sql
SELECT llm_context_free();
SELECT llm_model_free();
```

The entire package is <100 lines. All complexity is in sqlite-ai.

### Non-fatal Loading

Same pattern as embedding model loading — if sqlite-ai isn't available or the text gen model isn't downloaded, `createLocalGen` returns a stub where `isAvailable()` is `false` and `generate()` throws. Callers check `isAvailable()` before use. Nothing breaks if the model is missing.

---

## Model Download

Same pattern as Nomic Embed: downloaded on first use to `~/.gents/models/`.

```
~/.gents/models/
  nomic-embed-text-v1.5-GGUF/       # existing
  qwen2.5-0.5b-instruct-q4_k_m.gguf # new
```

Download triggered by `gents doctor` or on first invocation of a feature that needs it. Source: Hugging Face (direct GGUF download URL). Progress bar in CLI.

A `gents config set local_gen_model <path>` escape hatch lets users point to a different GGUF if they prefer another model.

---

## Consumer 1: Session Auto-Naming

### When

After the first `turn.complete` event in a new session. The session has the user's first message and the assistant's first response — enough signal to generate a meaningful name.

### Prompt

```
Generate a short label (3-6 words) for this conversation. Return ONLY the label, nothing else.

User: {first_user_message (truncated to 500 chars)}
Assistant: {first_assistant_response (truncated to 500 chars)}

Label:
```

### Integration Point

In the agent loop (`packages/agent/loop/src/loop.ts`), after emitting `turn.complete` for turn 1:

```typescript
if (turn === 1 && localGen?.isAvailable() && !getSessionLabel(db)) {
  const label = localGen.generate(buildNamingPrompt(userMessage, assistantText), {
    maxTokens: 20,
    temperature: 0.3,
  });
  updateSessionLabel(db, sessionId, label.trim());
}
```

This is fire-and-forget — if the local model fails or is unavailable, the session stays unlabeled (current behavior). The label appears in `/sessions` and the session picker on next chat start.

### Fallback

If local gen is unavailable and a cloud provider is configured, optionally use the cloud LLM with a cheap, minimal prompt. Cost: <$0.001 per naming. Configurable: `gents config set session_naming cloud|local|off`.

---

## Consumer 2: Compaction Summaries

### Current State

The `/compact` slash command writes a compaction marker but relies on the user to provide the summary text, or uses a placeholder. The `compact_conversation` tool lets the agent LLM write the summary — which costs API tokens.

### With Local Gen

When the agent (or user via `/compact`) triggers compaction, the summary can be generated locally:

```
Summarize the following conversation turns concisely. Focus on decisions made, code changes discussed, and open questions.

{messages from turn 1 to compaction point, truncated to fit context}

Summary:
```

The 2K context window is sufficient for summarizing ~10-15 turns of conversation. For longer histories, chunk the messages and summarize iteratively.

### Integration Point

New option on `compactConversation` in `agent-db`:

```typescript
export function compactConversation(
  db: AgentDB,
  upToTurn: number,
  summary: string,        // explicit summary (existing)
  sessionId?: string,
): void;

// New helper:
export function autoCompact(
  db: AgentDB,
  upToTurn: number,
  localGen: LocalGen,
  sessionId?: string,
): void;
```

`autoCompact` reads messages up to the turn, builds the summarization prompt, calls `localGen.generate()`, and writes the compaction marker.

---

## Consumer 3: Commit Message Drafting

### When

When the agent's `git_commit` tool is called without an explicit message, or when the user runs `/commit` in the CLI.

### Prompt

```
Write a concise conventional commit message for the following diff. Format: type(scope): description

{git diff output, truncated to 1500 chars}

Commit message:
```

### Integration Point

In `packages/agent/tools/src/tools/git.ts`, the `git_commit` tool can use local gen as a fallback when no message is provided:

```typescript
if (!input.message && localGen?.isAvailable()) {
  const diff = execSync("git diff --cached", { cwd: repoPath });
  input.message = localGen.generate(buildCommitPrompt(diff), {
    maxTokens: 60,
    temperature: 0.2,
  });
}
```

---

## Consumer 4: Offline Chat (Future)

With local gen available, gents could offer a degraded but functional chat mode when no API key is configured:

```
gents chat --local
```

This would use `llm_chat_respond()` from sqlite-ai for multi-turn conversation. Quality is significantly lower than Claude/GPT, but it works offline and costs nothing. The agent loop would need a `"local"` provider option.

**This is explicitly out of scope for the initial implementation** — session naming, compaction, and commit messages are the motivating use cases. Offline chat is a natural follow-on once the infrastructure exists.

---

## Dependency Flow

```
agent/local-gen    ← depends on nothing (sqlite-ai extension only)
agent/db           ← depends on nothing (unchanged)
agent/loop         ← depends on agent/db, agent/local-gen (optional)
agent/tools        ← depends on agent/db, agent/local-gen (optional for commit messages)
apps/cli           ← depends on agent/loop, agent/local-gen
```

`agent/local-gen` is an **optional** dependency everywhere. If the model isn't downloaded or sqlite-ai can't load, everything degrades gracefully to current behavior.

---

## Files Changed / Created

| File | Change |
|---|---|
| `packages/agent/local-gen/` | **New package** — `createLocalGen`, `LocalGen` interface |
| `packages/agent/local-gen/src/index.ts` | Main module (~80 lines) |
| `packages/agent/local-gen/src/prompts.ts` | Prompt templates for naming, compaction, commits |
| `packages/agent/local-gen/src/download.ts` | Model download helper (HuggingFace fetch + progress) |
| `packages/agent/db/src/sessions.ts` | Add `updateSessionLabel()` |
| `packages/agent/db/src/conversation.ts` | Add `autoCompact()` helper |
| `packages/agent/loop/src/loop.ts` | Auto-name session after turn 1 |
| `packages/agent/loop/src/types.ts` | Add optional `localGen` to `LoopConfig` |
| `packages/agent/tools/src/tools/git.ts` | Use local gen for commit message fallback |
| `apps/cli/src/commands/chat.ts` | Initialize local gen, pass to loop |
| `apps/cli/src/commands/doctor.ts` | Add text gen model check + download |
| `docs/tech-decisions.md` | Document local gen decision |

---

## Implementation Order

1. **`@gents/agent-local-gen` package** — core `createLocalGen` / `generate` wrapper over sqlite-ai
2. **Model download** — `gents doctor` downloads Qwen2.5-0.5B on first run
3. **Session auto-naming** — first consumer, simplest integration, immediate UX improvement
4. **Compaction summaries** — `autoCompact` helper, integrate with `/compact` and agent tool
5. **Commit message drafting** — `git_commit` tool fallback
6. **Config** — `local_gen_model`, `session_naming` mode, enable/disable

---

## Not in Scope

- Offline chat as a full `"local"` provider (future — needs prompt reformatting for small models)
- Fine-tuning or LoRA adapters (sqlite-ai supports `llm_lora_load` but not needed now)
- Vision/multimodal (sqlite-ai supports it but no use case yet)
- Streaming text generation in the CLI (sqlite-ai supports `llm_chat` virtual table for streaming, but all initial consumers want one-shot completion)

---

## Open Questions

1. **Memory budget** — Nomic Embed (~300MB) + Qwen2.5-0.5B (~500MB) = ~800MB resident. Acceptable on modern dev machines, but should we unload one model when the other is active? sqlite-ai's `llm_model_free()` makes this possible.

2. **Model swapping latency** — If we decide to share one connection and swap models, how fast is `llm_model_load`? Likely 1-3 seconds for a 400MB model. Acceptable for session naming (happens once), less so for compaction mid-conversation.

3. **Context window for compaction** — 2K tokens covers ~10-15 turns. For longer sessions, do we chunk-and-summarize or just summarize the most recent N turns? The iterative approach is better but adds complexity.

4. **Prompt engineering** — Small models are sensitive to prompt format. Qwen2.5-0.5B uses ChatML (`<|im_start|>user\n...<|im_end|>`). Should we use `llm_text_generate` with raw prompts or `llm_chat_respond` with the built-in chat template? The chat template approach is more robust.
