import { definePrompt, type AnthropicToolDef, type Prompt, type Section } from "@gents/agent-ctx";
import { getConversation, type Skill } from "@gents/agent-db";

export function createDefaultPrompt(tools: AnthropicToolDef[], skills?: Skill[]): Prompt {
  const sections: Section[] = [
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
  ];

  if (skills && skills.length > 0) {
    sections.push({
      name: "skills",
      placement: "static",
      resolve: () => {
        const parts = ["# Skills", ""];
        for (const skill of skills) {
          parts.push(`<skill name="${skill.name}">`);
          parts.push(skill.instructions);
          parts.push("</skill>");
          parts.push("");
        }
        return parts.join("\n");
      },
    });
  }

  return definePrompt({
    sections,
    conversationResolver: (db, _ctx) => getConversation(db),
    tools,
  });
}
