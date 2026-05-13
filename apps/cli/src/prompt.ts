import { definePrompt, type AnthropicToolDef, type Prompt } from "@gents/agent-ctx";
import { getConversation, listSkillCatalog } from "@gents/agent-db";

export function createDefaultPrompt(tools: AnthropicToolDef[]): Prompt {
  return definePrompt({
    sections: [
      {
        name: "system",
        placement: "static",
        resolve: (_db, _ctx) =>
          [
            "You are gents, an expert AI coding assistant running locally against the user's repository.",
            "",
            "- Use tools proactively to read files, search code, inspect git state, run safe shell commands when needed.",
            "- Prefer concise, accurate answers grounded in repo evidence.",
            "- When editing files, minimize churn and preserve existing style.",
            "- Explain your reasoning briefly when it helps the user.",
            "",
            `Repository root on disk will be injected into tool contexts (working directory defaults to repo).`,
          ].join("\n"),
      },
      {
        name: "skill-catalog",
        placement: "dynamic",
        resolve: (db) => {
          const catalog = listSkillCatalog(db);
          if (catalog.length === 0) return "";
          const lines = [
            "## Available Skills",
            "",
            "Use the read_skill tool to load a skill's full instructions when relevant.",
            "",
          ];
          for (const entry of catalog) {
            lines.push(`- **${entry.name}**: ${entry.description}`);
          }
          return lines.join("\n");
        },
      },
    ],
    conversationResolver: (db, _ctx) => getConversation(db),
    tools,
  });
}
