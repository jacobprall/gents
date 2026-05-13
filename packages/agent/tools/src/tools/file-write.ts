import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";

function resolveSafePath(repoPath: string, userPath: string): string {
  const root = realpathSync(path.resolve(repoPath));
  const resolved = path.resolve(root, userPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path escapes repository root");
  }
  const parentDir = path.dirname(resolved);
  try {
    const realParent = realpathSync(parentDir);
    if (!realParent.startsWith(root + path.sep) && realParent !== root) {
      throw new Error("Path escapes repository root via symlink");
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("symlink")) throw e;
  }
  return resolved;
}

const inputSchema = z.object({
  path: z.string().describe("File path relative to the repository root"),
  content: z.string().describe("Full file contents to write"),
});

export const fileWriteTool: ToolDefinition = {
  name: "file_write",
  description: "Write text to a file under the repo root, creating parent directories if needed.",
  inputSchema,
  async execute(input, context): Promise<string> {
    try {
      const parsed = inputSchema.parse(input);
      const abs = resolveSafePath(context.repoPath, parsed.path);
      await mkdir(path.dirname(abs), { recursive: true });
      await Bun.write(abs, parsed.content);
      return `Wrote ${parsed.content.length} bytes to ${parsed.path}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
