import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { truncate, spawnWithTimeout } from "../utils.js";

const DEFAULT_TIMEOUT_MS = 30_000;

const inputSchema = z.object({
  command: z.string().describe("Shell command to run (non-interactive)"),
  timeout: z.number().positive().optional().describe("Timeout in milliseconds (default 30000)"),
});

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Run a shell command with cwd set to the agent working directory. stdout/stderr are captured.",
  inputSchema,
  async execute(input, context): Promise<string> {
    try {
      const { command, timeout } = input as z.infer<typeof inputSchema>;
      const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;

      const result = await spawnWithTimeout(["sh", "-c", command], {
        cwd: context.workingDir,
        timeoutMs,
        signal: context.signal,
      });

      const parts = [
        result.stdout,
        result.stderr,
        result.timedOut ? `\n[timeout after ${timeoutMs}ms]` : "",
        `\n[exit code: ${result.exitCode ?? "unknown"}]`,
      ].join("");

      return truncate(parts.trim() || `[exit code: ${result.exitCode ?? "unknown"}]`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
