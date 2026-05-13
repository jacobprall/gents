import type {
  CostGuardConfig,
  Hook,
  HookContext,
  PostHookResult,
  PreHookResult,
} from "./types";

type ShortCircuitResult =
  | { action: "pause"; reason: string }
  | { action: "reject"; reason: string };

function evaluateCost(
  context: HookContext,
  config: CostGuardConfig,
): ShortCircuitResult | null {
  const mode = config.onExceeded ?? "pause";
  if (
    config.maxCostPerSession != null &&
    context.sessionCostUsd >= config.maxCostPerSession
  ) {
    return { action: mode, reason: "Session cost limit exceeded" };
  }
  if (
    config.maxCostPerTurn != null &&
    context.turnCostUsd >= config.maxCostPerTurn
  ) {
    return { action: mode, reason: "Turn cost limit exceeded" };
  }
  return null;
}

export function costGuard(config: CostGuardConfig): Hook {
  return {
    name: "cost-guard",
    async preLLM(context: HookContext): Promise<PreHookResult> {
      return evaluateCost(context, config) ?? { action: "continue" };
    },
    async postLLM(
      context: HookContext,
      _responseText: string,
    ): Promise<PostHookResult> {
      return evaluateCost(context, config) ?? { action: "continue" };
    },
    async preTool(
      context: HookContext,
      _toolName: string,
      _input: unknown,
    ): Promise<PreHookResult> {
      return evaluateCost(context, config) ?? { action: "continue" };
    },
    async postTool(
      context: HookContext,
      _toolName: string,
      _output: string,
    ): Promise<PostHookResult> {
      return evaluateCost(context, config) ?? { action: "continue" };
    },
  };
}
