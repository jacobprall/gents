import { z } from "zod";
import { compactConversation } from "@gents/agent-db";
import type { ToolDefinition } from "../types.js";

const inputSchema = z.object({
  up_to_turn: z.number(),
  summary: z.string(),
});

export const compactConversationTool: ToolDefinition = {
  name: "compact_conversation",
  description:
    "Record a compaction boundary in the agent database (summary replaces older turns per conversation reads).",
  inputSchema,
  async execute(input, context): Promise<string> {
    try {
      const { up_to_turn, summary } = input as z.infer<typeof inputSchema>;
      compactConversation(context.db, up_to_turn, summary);
      return `Compaction recorded up to turn ${up_to_turn}.`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
