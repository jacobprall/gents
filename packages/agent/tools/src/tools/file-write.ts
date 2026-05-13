import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { resolveSafePath, MAX_FILE_SIZE } from "../utils.js";
import { tryWriteThrough } from "../write-through.js";

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
      const { path: filePath, content } = input as z.infer<typeof inputSchema>;
      if (content.length > MAX_FILE_SIZE) {
        const mb = (content.length / 1024 / 1024).toFixed(1);
        const maxMb = (MAX_FILE_SIZE / 1024 / 1024).toFixed(0);
        return `Error: content too large (${mb}MB, max ${maxMb}MB)`;
      }
      const abs = resolveSafePath(context.repoPath, filePath);
      await mkdir(path.dirname(abs), { recursive: true });
      await Bun.write(abs, content);
      tryWriteThrough(context.db, filePath, content);
      return `Wrote ${content.length} bytes to ${filePath}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
