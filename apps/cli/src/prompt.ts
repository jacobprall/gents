import { definePrompt, type AnthropicToolDef, type ContentBlock, type Prompt } from "@gents/agent-ctx";
import { getConversation } from "@gents/agent-db";

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
        name: "conversation",
        placement: "dynamic",
        resolve: (db, _ctx) => getConversation(db) as unknown as ContentBlock[],
      },
    ],
    tools,
  });
}
