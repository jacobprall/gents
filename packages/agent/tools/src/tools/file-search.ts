import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";

const MAX_RESULTS = 100;

function resolveSafeSubdir(repoPath: string, userSubdir?: string): string {
  const root = path.resolve(repoPath);
  const sub = userSubdir ?? ".";
  const resolved = path.resolve(root, sub);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Search path escapes repository root");
  }
  return resolved;
}

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern e.g. "**/*.ts"'),
  path: z.string().optional().describe("Subdirectory under repo root to search (default: repo root)"),
});

export const fileSearchTool: ToolDefinition = {
  name: "file_search",
  description: "Find files under the repo matching a glob pattern (max 100 results).",
  inputSchema,
  async execute(input, context): Promise<string> {
    try {
      const parsed = inputSchema.parse(input);
      const cwd = resolveSafeSubdir(context.repoPath, parsed.path);
      const glob = new Bun.Glob(parsed.pattern);
      const found: string[] = [];
      const root = path.resolve(context.repoPath);
      for await (const match of glob.scan({ cwd, onlyFiles: true })) {
        const abs = path.resolve(cwd, match);
        const rel = path.relative(root, abs).split(path.sep).join("/");
        found.push(rel);
        if (found.length >= MAX_RESULTS) break;
      }
      if (found.length === 0) {
        return `No files matched pattern "${parsed.pattern}" under ${parsed.path ?? "."}.`;
      }
      const suffix = found.length >= MAX_RESULTS ? `\n(showing first ${MAX_RESULTS} matches)` : "";
      return `${found.join("\n")}${suffix}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
