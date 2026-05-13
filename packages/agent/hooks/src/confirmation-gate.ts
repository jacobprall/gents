import type { ConfirmationConfig, Hook, HookContext, HookResult } from "./types";

export function confirmationGate(config: ConfirmationConfig): Hook {
  const requireConfirmation = config.requireConfirmation ?? [];
  return {
    name: "confirmation-gate",
    async preTool(
      _context: HookContext,
      toolName: string,
      input: unknown
    ): Promise<HookResult> {
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
