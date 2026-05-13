import type { CostGuardConfig, Hook, HookContext, HookResult } from "./types";

function evaluateCost(
  context: HookContext,
  config: CostGuardConfig
): HookResult | null {
  const mode = config.onExceeded ?? "pause";
  if (
    config.maxCostPerSession != null &&
    context.sessionCostUsd >= config.maxCostPerSession
  ) {
    return mode === "pause"
      ? { action: "pause", reason: "Session cost limit exceeded" }
      : { action: "reject", reason: "Session cost limit exceeded" };
  }
  if (
    config.maxCostPerTurn != null &&
    context.turnCostUsd >= config.maxCostPerTurn
  ) {
    return mode === "pause"
      ? { action: "pause", reason: "Turn cost limit exceeded" }
      : { action: "reject", reason: "Turn cost limit exceeded" };
  }
  return null;
}

export function costGuard(config: CostGuardConfig): Hook {
  return {
    name: "cost-guard",
    async preLLM(context: HookContext): Promise<HookResult> {
      return evaluateCost(context, config) ?? { action: "continue" };
    },
    async postLLM(context: HookContext, _responseText: string): Promise<HookResult> {
      return evaluateCost(context, config) ?? { action: "continue" };
    },
  };
}
