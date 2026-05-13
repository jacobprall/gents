import { realpathSync } from "node:fs";
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
  try {
    const real = realpathSync(resolved);
    if (!real.startsWith(root + path.sep) && real !== root) {
      throw new Error("Path escapes repository root via symlink");
    }
    return real;
  } catch (e) {
    if (e instanceof Error && e.message.includes("symlink")) throw e;
    return resolved;
  }
}

const inputSchema = z.object({
  path: z.string().describe("File path relative to the repository root"),
  oldString: z.string().describe("Exact substring to replace (must occur exactly once)"),
  newString: z.string().describe("Replacement text"),
});

export const fileEditTool: ToolDefinition = {
  name: "file_edit",
  description:
    "Replace a unique substring in a file under the repo root. Fails if oldString is missing or ambiguous.",
  inputSchema,
  async execute(input, context): Promise<string> {
    try {
      const parsed = inputSchema.parse(input);
      const abs = resolveSafePath(context.repoPath, parsed.path);
      const file = Bun.file(abs);
      const exists = await file.exists();
      if (!exists) {
        return `Error: file not found: ${parsed.path}`;
      }
      const text = await file.text();
      const first = text.indexOf(parsed.oldString);
      if (first === -1) {
        return `Error: oldString not found in ${parsed.path}`;
      }
      const second = text.indexOf(parsed.oldString, first + parsed.oldString.length);
      if (second !== -1) {
        return `Error: oldString is not unique in ${parsed.path}`;
      }
      const next = text.slice(0, first) + parsed.newString + text.slice(first + parsed.oldString.length);
      await Bun.write(abs, next);
      return `Updated ${parsed.path} (${parsed.oldString.length} chars → ${parsed.newString.length} chars)`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
