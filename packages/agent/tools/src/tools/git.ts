import { z } from "zod";
import { reindexFiles } from "@gents/agent-db";
import type { ToolDefinition } from "../types.js";
import type { SpawnResult } from "../utils.js";
import { truncate, spawnWithTimeout, resolveSafePath } from "../utils.js";

function formatGitResult(result: SpawnResult): string {
  const out = [result.stdout, result.stderr].filter(Boolean).join("").trimEnd();
  const timeout = result.timedOut ? "\n[process killed by timeout]" : "";
  return `${out}${timeout}\n[exit code: ${result.exitCode ?? "unknown"}]`;
}

export const gitStatusTool: ToolDefinition = {
  name: "git_status",
  description: "Run `git status --porcelain` in the working directory.",
  inputSchema: z.object({}),
  async execute(_input, context): Promise<string> {
    try {
      const result = await spawnWithTimeout(["git", "status", "--porcelain"], {
        cwd: context.workingDir,
        signal: context.signal,
      });
      return truncate(formatGitResult(result));
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
      const { staged } = input as z.infer<typeof gitDiffSchema>;
      const args = staged ? ["diff", "--staged"] : ["diff"];
      const result = await spawnWithTimeout(["git", ...args], {
        cwd: context.workingDir,
        signal: context.signal,
      });
      return truncate(formatGitResult(result));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};

const gitCommitSchema = z.object({
  message: z.string().min(1),
  files: z.array(z.string()).optional().describe("If set, `git add` these paths before committing"),
});

export const gitCommitTool: ToolDefinition = {
  name: "git_commit",
  description: "Optionally stage files, then create a git commit with the given message.",
  inputSchema: gitCommitSchema,
  async execute(input, context): Promise<string> {
    try {
      const { message, files } = input as z.infer<typeof gitCommitSchema>;
      const lines: string[] = [];

      if (files?.length) {
        const safePaths: string[] = [];
        for (const f of files) {
          try {
            resolveSafePath(context.repoPath, f);
            safePaths.push(f);
          } catch (pathErr) {
            const msg = pathErr instanceof Error ? pathErr.message : String(pathErr);
            return `Error: invalid file path "${f}": ${msg}`;
          }
        }
        const addResult = await spawnWithTimeout(["git", "add", "--", ...safePaths], {
          cwd: context.workingDir,
          signal: context.signal,
        });
        lines.push(`git add: exit ${addResult.exitCode ?? "unknown"}`);
        const addOutput = [addResult.stdout, addResult.stderr].filter(Boolean).join("").trimEnd();
        if (addOutput) lines.push(addOutput);
        if (addResult.exitCode !== 0) {
          return truncate(lines.join("\n"));
        }
      }

      const commitResult = await spawnWithTimeout(["git", "commit", "-m", message], {
        cwd: context.workingDir,
        signal: context.signal,
      });
      lines.push(formatGitResult(commitResult));

      if (commitResult.exitCode === 0 && context.db.workspace) {
        try {
          const diffResult = await spawnWithTimeout(
            ["git", "diff", "--name-only", "HEAD~1", "HEAD"],
            { cwd: context.workingDir, signal: context.signal },
          );
          if (diffResult.exitCode === 0) {
            const changed = diffResult.stdout
              .trim()
              .split("\n")
              .filter(Boolean);
            if (changed.length > 0) {
              reindexFiles(context.db.workspace, changed);
            }
          }
        } catch {
          // Non-fatal: index will catch up on next incremental pass.
        }
      }

      return truncate(lines.join("\n"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
