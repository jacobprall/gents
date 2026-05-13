import { z } from "zod";
import type { ToolDefinition } from "../types.js";

const MAX_OUT = 10000;

function truncate(s: string): string {
  if (s.length <= MAX_OUT) return s;
  return `${s.slice(0, MAX_OUT)}\n...[truncated ${s.length - MAX_OUT} chars]`;
}

async function gitSpawn(cwd: string, args: string[], killMs?: number): Promise<{ out: string; code: number | null }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer =
    killMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, killMs)
      : undefined;

  let stdout = "";
  let stderr = "";
  try {
    stdout = await new Response(proc.stdout).text();
    stderr = await new Response(proc.stderr).text();
  } catch {
    /* killed */
  }

  let code: number | null = null;
  try {
    code = await proc.exited;
  } catch {
    code = null;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const combined = [stdout, stderr, timedOut ? "\n[process killed by timeout]" : ""].join("").trimEnd();
  return { out: combined, code };
}

export const gitStatusTool: ToolDefinition = {
  name: "git_status",
  description: "Run `git status --porcelain` in the working directory.",
  inputSchema: z.object({}),
  async execute(_input, context): Promise<string> {
    try {
      const { out, code } = await gitSpawn(context.workingDir, ["status", "--porcelain"]);
      return truncate(`${out}\n[exit code: ${code ?? "unknown"}]`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};

const gitDiffSchema = z.object({
  staged: z.boolean().optional().describe("If true, compare staged changes (--staged)"),
});

export const gitDiffTool: ToolDefinition = {
  name: "git_diff",
  description: "Show `git diff` or `git diff --staged` from the working directory.",
  inputSchema: gitDiffSchema,
  async execute(input, context): Promise<string> {
    try {
      const parsed = gitDiffSchema.parse(input);
      const args = parsed.staged ? ["diff", "--staged"] : ["diff"];
      const { out, code } = await gitSpawn(context.workingDir, args);
      return truncate(`${out}\n[exit code: ${code ?? "unknown"}]`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};

const gitCommitSchema = z.object({
  message: z.string().min(1),
  files: z.array(z.string()).optional().describe("If set, `git add` each path before committing"),
});

export const gitCommitTool: ToolDefinition = {
  name: "git_commit",
  description: "Optionally stage files, then create a git commit with the given message.",
  inputSchema: gitCommitSchema,
  async execute(input, context): Promise<string> {
    try {
      const parsed = gitCommitSchema.parse(input);
      const lines: string[] = [];

      if (parsed.files?.length) {
        for (const f of parsed.files) {
          const { out: addOut, code: addCode } = await gitSpawn(context.workingDir, ["add", "--", f]);
          lines.push(`git add ${f}: exit ${addCode ?? "unknown"}`, addOut);
          if (addCode !== 0) {
            return truncate(lines.filter(Boolean).join("\n"));
          }
        }
      }

      const { out: commitOut, code: commitCode } = await gitSpawn(context.workingDir, [
        "commit",
        "-m",
        parsed.message,
      ]);
      lines.push(commitOut, `[exit code: ${commitCode ?? "unknown"}]`);

      return truncate(lines.filter(Boolean).join("\n"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
