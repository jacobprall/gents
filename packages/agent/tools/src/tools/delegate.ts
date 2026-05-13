import { z } from "zod";
import { getSkill, getSubagentDef } from "@gents/agent-db";
import type { ToolDefinition, ToolContext } from "../types.js";
import { truncate } from "../utils.js";

/**
 * Factory that spawns a scoped child agent loop and returns its final text.
 * Provided via ToolContext.childLoopFactory by the CLI/worker wiring layer,
 * keeping agent-tools free of a dependency on agent-loop.
 */
export interface ChildLoopFactory {
  run(params: ChildLoopParams): Promise<ChildLoopResult>;
}

export interface ChildLoopParams {
  db: ToolContext["db"];
  repoPath: string;
  workingDir: string;
  signal?: AbortSignal;
  task: string;
  skillInstructions: string;
  allowedTools: string[];
  maxIterations: number;
  maxCostUsd?: number;
}

export interface ChildLoopResult {
  content: string;
  costUsd: number;
  iterations: number;
}

const inputSchema = z.object({
  subagent: z.string().describe("Name of the subagent to delegate to (e.g. code_explorer, code_reviewer)"),
  task: z.string().describe("What the subagent should do"),
  context: z.string().optional().describe("Additional context for the subagent"),
});

export const delegateTool: ToolDefinition = {
  name: "delegate",
  description: [
    "Delegate a focused task to a specialized subagent.",
    "Available subagents: code_explorer (read-only codebase exploration),",
    "code_implementer (full-access implementation), code_reviewer (read-only code review),",
    "code_refactorer (behavior-preserving refactoring).",
    "Each subagent has its own tool restrictions, iteration budget, and specialized instructions.",
    "Use this when a task benefits from focused, specialized execution.",
  ].join(" "),
  inputSchema,
  async execute(input, context): Promise<string> {
    const parsed = input as z.infer<typeof inputSchema>;

    if (!context.childLoopFactory) {
      return "Error: delegate tool is not available in this environment (no childLoopFactory configured).";
    }
    const factory = context.childLoopFactory;

    const subagentDef = getSubagentDef(context.db, parsed.subagent);
    if (!subagentDef) {
      return `Error: unknown subagent "${parsed.subagent}". Available subagents can be found in the subagent_defs table.`;
    }

    const skill = getSkill(context.db, subagentDef.skill);
    if (!skill) {
      return `Error: skill "${subagentDef.skill}" referenced by subagent "${parsed.subagent}" not found.`;
    }

    const taskMessage = parsed.context
      ? `${parsed.task}\n\nAdditional context:\n${parsed.context}`
      : parsed.task;

    try {
      const result = await factory.run({
        db: context.db,
        repoPath: context.repoPath,
        workingDir: context.workingDir,
        signal: context.signal,
        task: taskMessage,
        skillInstructions: skill.instructions,
        allowedTools: subagentDef.allowedTools,
        maxIterations: subagentDef.maxIterations ?? 10,
        maxCostUsd: subagentDef.maxCostUsd,
      });

      const header = `[${parsed.subagent}] completed in ${String(result.iterations)} iteration(s), cost $${result.costUsd.toFixed(6)}`;
      return truncate(`${header}\n\n${result.content}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: subagent "${parsed.subagent}" failed: ${msg}`;
    }
  },
};
