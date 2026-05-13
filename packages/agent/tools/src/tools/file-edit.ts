import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { resolveSafePath, assertFileSizeLimit } from "../utils.js";
import { tryWriteThrough } from "../write-through.js";

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
      const { path: filePath, oldString, newString } = input as z.infer<typeof inputSchema>;
      const abs = resolveSafePath(context.repoPath, filePath);
      const file = Bun.file(abs);
      if (!(await file.exists())) {
        return `Error: file not found: ${filePath}`;
      }
      assertFileSizeLimit(abs);
      const text = await file.text();
      const first = text.indexOf(oldString);
      if (first === -1) {
        return `Error: oldString not found in ${filePath}`;
      }
      if (text.indexOf(oldString, first + oldString.length) !== -1) {
        return `Error: oldString is not unique in ${filePath}`;
      }
      const next = text.slice(0, first) + newString + text.slice(first + oldString.length);
      await Bun.write(abs, next);
      tryWriteThrough(context.db, filePath, next);
      return `Updated ${filePath} (${oldString.length} chars → ${newString.length} chars)`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
