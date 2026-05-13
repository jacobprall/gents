export interface HookContext {
  sessionCostUsd: number;
  turnCostUsd: number;
  turnNumber: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export type HookResult =
  | { action: "continue" }
  | { action: "continue"; transformed: string }
  | { action: "reject"; reason: string }
  | { action: "pause"; reason: string };

export interface Hook {
  name: string;
  preLLM?: (context: HookContext) => Promise<HookResult>;
  postLLM?: (context: HookContext, responseText: string) => Promise<HookResult>;
  preTool?: (
    context: HookContext,
    toolName: string,
    input: unknown
  ) => Promise<HookResult>;
  postTool?: (
    context: HookContext,
    toolName: string,
    output: string
  ) => Promise<HookResult>;
}

export interface HookPipeline {
  runPreLLM(context: HookContext): Promise<HookResult>;
  runPostLLM(context: HookContext, responseText: string): Promise<HookResult>;
  runPreTool(
    context: HookContext,
    toolName: string,
    input: unknown
  ): Promise<HookResult>;
  runPostTool(
    context: HookContext,
    toolName: string,
    output: string
  ): Promise<HookResult>;
}

export interface CostGuardConfig {
  maxCostPerTurn?: number;
  maxCostPerSession?: number;
  onExceeded?: "pause" | "reject";
}

export interface RedactorConfig {
  patterns?: RegExp[];
  replacement?: string;
}

export interface GovernanceConfig {
  allowedTools?: string[];
  deniedTools?: string[];
  pathRestrictions?: {
    allow?: string[];
    deny?: string[];
  };
}

export interface ConfirmationConfig {
  requireConfirmation?: string[];
  promptFn: (toolName: string, input: unknown) => Promise<boolean>;
}
