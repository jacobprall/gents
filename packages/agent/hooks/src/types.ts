export interface HookContext {
  readonly sessionCostUsd: number;
  readonly turnCostUsd: number;
  readonly turnNumber: number;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export type PreHookResult =
  | { action: "continue" }
  | { action: "reject"; reason: string }
  | { action: "pause"; reason: string };

export type PostHookResult =
  | { action: "continue" }
  | { action: "continue"; transformed: string }
  | { action: "reject"; reason: string }
  | { action: "pause"; reason: string };

/** @deprecated Use PreHookResult or PostHookResult for phase-specific typing */
export type HookResult = PostHookResult;

export interface Hook {
  name: string;
  preLLM?: (context: HookContext) => Promise<PreHookResult>;
  postLLM?: (
    context: HookContext,
    responseText: string
  ) => Promise<PostHookResult>;
  preTool?: (
    context: HookContext,
    toolName: string,
    input: unknown
  ) => Promise<PreHookResult>;
  postTool?: (
    context: HookContext,
    toolName: string,
    output: string
  ) => Promise<PostHookResult>;
}

export interface HookPipeline {
  runPreLLM(context: HookContext): Promise<PreHookResult>;
  runPostLLM(
    context: HookContext,
    responseText: string
  ): Promise<PostHookResult>;
  runPreTool(
    context: HookContext,
    toolName: string,
    input: unknown
  ): Promise<PreHookResult>;
  runPostTool(
    context: HookContext,
    toolName: string,
    output: string
  ): Promise<PostHookResult>;
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
