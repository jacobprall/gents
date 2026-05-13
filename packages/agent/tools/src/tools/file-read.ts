import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";

const MAX_OUT = 10000;

function truncate(s: string): string {
  if (s.length <= MAX_OUT) return s;
  return `${s.slice(0, MAX_OUT)}\n...[truncated ${s.length - MAX_OUT} chars]`;
}

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
  startLine: z.number().int().positive().optional().describe("First line (1-based, inclusive)"),
  endLine: z.number().int().positive().optional().describe("Last line (1-based, inclusive)"),
});

export const fileReadTool: ToolDefinition = {
  name: "file_read",
  description:
    "Read a text file under the repo root. Optionally returns a slice by line range with line numbers.",
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
      const lines = text.split(/\r?\n/);
      const start = parsed.startLine ?? 1;
      const end = parsed.endLine ?? lines.length;
      if (start < 1 || end < start || start > lines.length) {
        return `Error: invalid line range (${start}-${end}); file has ${lines.length} lines.`;
      }
      const endClamped = Math.min(end, lines.length);
      const slice = lines.slice(start - 1, endClamped);
      const numbered = slice.map((line, i) => `${start + i}|${line}`).join("\n");
      return truncate(numbered);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
