import type { Hook, HookContext, HookPipeline, HookResult } from "./types";

function isShortCircuit(result: HookResult): boolean {
  return result.action === "reject" || result.action === "pause";
}

export function createHookPipeline(hooks: Hook[]): HookPipeline {
  return {
    async runPreLLM(context: HookContext): Promise<HookResult> {
      for (const hook of hooks) {
        if (!hook.preLLM) continue;
        const result = await hook.preLLM(context);
        if (isShortCircuit(result)) return result;
      }
      return { action: "continue" };
    },

    async runPostLLM(
      context: HookContext,
      responseText: string
    ): Promise<HookResult> {
      let text = responseText;
      let mutated = false;
      for (const hook of hooks) {
        if (!hook.postLLM) continue;
        const result = await hook.postLLM(context, text);
        if (isShortCircuit(result)) return result;
        if (result.action === "continue" && "transformed" in result) {
          text = result.transformed;
          mutated = true;
        }
      }
      return mutated ? { action: "continue", transformed: text } : { action: "continue" };
    },

    async runPreTool(
      context: HookContext,
      toolName: string,
      input: unknown
    ): Promise<HookResult> {
      for (const hook of hooks) {
        if (!hook.preTool) continue;
        const result = await hook.preTool(context, toolName, input);
        if (isShortCircuit(result)) return result;
      }
      return { action: "continue" };
    },

    async runPostTool(
      context: HookContext,
      toolName: string,
      output: string
    ): Promise<HookResult> {
      let text = output;
      let mutated = false;
      for (const hook of hooks) {
        if (!hook.postTool) continue;
        const result = await hook.postTool(context, toolName, text);
        if (isShortCircuit(result)) return result;
        if (result.action === "continue" && "transformed" in result) {
          text = result.transformed;
          mutated = true;
        }
      }
      return mutated ? { action: "continue", transformed: text } : { action: "continue" };
    },
  };
}
