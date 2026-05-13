import type { AgentDB } from "@gents/agent-db";
import type { Prompt } from "@gents/agent-ctx";
import type { ToolRegistry, ChildLoopFactory } from "@gents/agent-tools";
import type { HookPipeline } from "@gents/agent-hooks";
import type { ProviderName, LLMProvider } from "./provider";

export const DEFAULT_MAX_ITERATIONS = 25;
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 100_000;

export interface LoopConfig {
  model: string;
  apiKey: string;
  /** LLM provider name or a pre-built LLMProvider instance. Defaults to "anthropic". */
  provider?: ProviderName | LLMProvider;
  tools: ToolRegistry;
  hooks: HookPipeline;
  ctx: Prompt;
  maxIterations?: number;
  /**
   * Hard cost limit per turn (USD). Checked after each LLM response.
   * This is the loop's built-in enforcement and is independent of any
   * cost-guard hook in the pipeline. Do not set both this AND a cost-guard
   * hook with the same limits — use one or the other.
   */
  maxCostPerTurn?: number;
  /**
   * Hard cost limit per session (USD). Checked before and after each LLM call.
   * See maxCostPerTurn for guidance on avoiding duplication with cost-guard hooks.
   */
  maxCostPerSession?: number;
  maxTokens?: number;
  maxToolOutputBytes?: number;
  parallelToolExecution?: boolean;
  repoPath: string;
  workingDir?: string;
  signal?: AbortSignal;
  onEvent?: (event: LoopEvent) => void;
  childLoopFactory?: ChildLoopFactory;
}

export type LoopEvent =
  | { type: "turn.started"; turn: number }
  | { type: "llm.streaming"; delta: string }
  | { type: "llm.complete"; message: AssistantMessage; usage: TokenUsage }
  | { type: "tool.calling"; name: string; input: unknown }
  | { type: "tool.complete"; name: string; output: string; durationMs: number }
  | { type: "tool.error"; name: string; error: string }
  | { type: "turn.complete"; turn: number; cost: CostInfo }
  | { type: "error"; error: LoopError }
  | { type: "paused"; reason: string };

export interface AssistantMessage {
  content: string | null;
  toolCalls: ToolCallInfo[];
}

export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface CostInfo {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  turnNumber: number;
}

export interface AgentLoop {
  run(db: AgentDB, userMessage: string): AsyncGenerator<LoopEvent>;
  step(db: AgentDB): AsyncGenerator<LoopEvent>;
  resume(db: AgentDB): AsyncGenerator<LoopEvent>;
}

// --- Structured error types ---

export class LoopError extends Error {
  constructor(message: string, public readonly code: LoopErrorCode) {
    super(message);
    this.name = "LoopError";
  }
}

export type LoopErrorCode =
  | "llm_api_error"
  | "llm_empty_response"
  | "cost_limit_exceeded"
  | "hook_rejected"
  | "tool_execution_error"
  | "tool_rejected"
  | "max_iterations"
  | "aborted"
  | "context_assembly_error"
  | "no_conversation";

export class CostLimitError extends LoopError {
  constructor(
    message: string,
    public readonly limitType: "turn" | "session",
    public readonly costUsd: number,
    public readonly limitUsd: number,
  ) {
    super(message, "cost_limit_exceeded");
    this.name = "CostLimitError";
  }
}

export class HookRejectionError extends LoopError {
  constructor(
    message: string,
    public readonly phase: "pre_llm" | "post_llm" | "pre_tool" | "post_tool",
    public readonly reason: string,
  ) {
    super(message, "hook_rejected");
    this.name = "HookRejectionError";
  }
}

export class ToolExecutionError extends LoopError {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly cause?: Error,
  ) {
    super(message, "tool_execution_error");
    this.name = "ToolExecutionError";
  }
}
