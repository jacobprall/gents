import { z } from "zod";
import { getSkill, getSkillFile, listSkillFiles } from "@gents/agent-db";
import type { ToolDefinition } from "../types.js";
import { truncate } from "../utils.js";

const inputSchema = z.object({
  name: z.string().describe("Name of the skill to load"),
  path: z
    .string()
    .optional()
    .describe(
      "Relative path to a supporting file within the skill. " +
        "Omit to get the main skill instructions (SKILL.md). " +
        'Use "__list__" to list all available files for the skill.',
    ),
});

export const readSkillTool: ToolDefinition = {
  name: "read_skill",
  description:
    "Load skill instructions or supporting files by name. " +
    "Omit path for the main skill content, provide a relative path for a specific file, " +
    'or pass path "__list__" to list all available files.',
  inputSchema,
  async execute(input, context): Promise<string> {
    const parsed = input as z.infer<typeof inputSchema>;

    if (!parsed.path) {
      const skill = getSkill(context.db, parsed.name);
      if (!skill) {
        return `Error: skill "${parsed.name}" not found.`;
      }
      return truncate(skill.instructions);
    }

    if (parsed.path === "__list__") {
      const skill = getSkill(context.db, parsed.name);
      if (!skill) {
        return `Error: skill "${parsed.name}" not found.`;
      }
      const files = listSkillFiles(context.db, parsed.name);
      if (files.length === 0) {
        return `Skill "${parsed.name}" has no supporting files.`;
      }
      return files.join("\n");
    }

    const content = getSkillFile(context.db, parsed.name, parsed.path);
    if (content === undefined) {
      const skill = getSkill(context.db, parsed.name);
      if (!skill) {
        return `Error: skill "${parsed.name}" not found.`;
      }
      return `Error: file "${parsed.path}" not found in skill "${parsed.name}".`;
    }
    return truncate(content);
  },
};
