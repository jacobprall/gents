import type {
  ConfirmationConfig,
  Hook,
  HookContext,
  PreHookResult,
} from "./types";

export function confirmationGate(config: ConfirmationConfig): Hook {
  const requireConfirmation = config.requireConfirmation ?? [];
  return {
    name: "confirmation-gate",
    async preTool(
      _context: HookContext,
      toolName: string,
      input: unknown,
    ): Promise<PreHookResult> {
      if (!requireConfirmation.includes(toolName)) {
        return { action: "continue" };
      }
      const ok = await config.promptFn(toolName, input);
      return ok
        ? { action: "continue" }
        : { action: "reject", reason: "User declined" };
    },
  };
}
