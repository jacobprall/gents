import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { resolveSafePath, truncate, assertFileSizeLimit } from "../utils.js";

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
      const { path: filePath, startLine, endLine } = input as z.infer<typeof inputSchema>;
      const abs = resolveSafePath(context.repoPath, filePath);
      const file = Bun.file(abs);
      if (!(await file.exists())) {
        return `Error: file not found: ${filePath}`;
      }
      assertFileSizeLimit(abs);
      const text = await file.text();
      const lines = text.split(/\r?\n/);
      const start = startLine ?? 1;
      const end = endLine ?? lines.length;
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
