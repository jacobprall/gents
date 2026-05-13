import { z } from "zod";
import { compactConversation } from "@gents/agent-db";
import type { AgentDB as DbAgentDB } from "@gents/agent-db";
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
      const parsed = inputSchema.parse(input);
      const db = context.db as unknown as DbAgentDB;
      compactConversation(db, parsed.up_to_turn, parsed.summary);
      return `Compaction recorded up to turn ${parsed.up_to_turn}.`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
