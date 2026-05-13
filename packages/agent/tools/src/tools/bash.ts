import { z } from "zod";
import type { ToolDefinition } from "../types.js";

const MAX_OUT = 10000;
const DEFAULT_TIMEOUT_MS = 30_000;

function truncate(s: string): string {
  if (s.length <= MAX_OUT) return s;
  return `${s.slice(0, MAX_OUT)}\n...[truncated ${s.length - MAX_OUT} chars]`;
}

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
      const parsed = inputSchema.parse(input);
      const timeoutMs = parsed.timeout ?? DEFAULT_TIMEOUT_MS;

      const proc = Bun.spawn(["sh", "-c", parsed.command], {
        cwd: context.workingDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);

      let stdout = "";
      let stderr = "";
      try {
        stdout = await new Response(proc.stdout).text();
        stderr = await new Response(proc.stderr).text();
      } catch {
        /* process may have been killed */
      }

      let code: number | null = null;
      try {
        code = await proc.exited;
      } catch {
        code = null;
      } finally {
        clearTimeout(timer);
      }

      const combined = [
        stdout,
        stderr ? stderr : "",
        timedOut ? `\n[timeout after ${timeoutMs}ms]` : "",
        `\n[exit code: ${code ?? "unknown"}]`,
      ].join("");

      return truncate(combined.trim() || `[exit code: ${code ?? "unknown"}]`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
