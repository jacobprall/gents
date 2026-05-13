import type { AgentDB } from "@gents/agent-db";
import type { Prompt } from "@gents/agent-ctx";
import type { ToolRegistry } from "@gents/agent-tools";
import type { HookPipeline } from "@gents/agent-hooks";

export interface LoopConfig {
  model: string;
  apiKey: string;
  tools: ToolRegistry;
  hooks: HookPipeline;
  ctx: Prompt;
  maxIterations?: number; // default 25
  maxCostPerTurn?: number; // USD
  maxCostPerSession?: number; // USD
  repoPath: string;
  workingDir?: string; // defaults to repoPath
  onEvent?: (event: LoopEvent) => void;
}

export type LoopEvent =
  | { type: "turn.started"; turn: number }
  | { type: "llm.streaming"; delta: string }
  | { type: "llm.complete"; message: AssistantMessage; usage: TokenUsage }
  | { type: "tool.calling"; name: string; input: unknown }
  | { type: "tool.complete"; name: string; output: string; durationMs: number }
  | { type: "tool.error"; name: string; error: string }
  | { type: "turn.complete"; turn: number; cost: CostInfo }
  | { type: "error"; error: Error }
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
