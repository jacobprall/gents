import type { AgentDB } from "@gents/agent-db";
import { formatConversation, normalizeToBlocks } from "./format";
import type {
  AnthropicSystemBlock,
  AssemblyContext,
  AssembleResult,
  Prompt,
  PromptConfig,
} from "./types";

export function definePrompt(config: PromptConfig): Prompt {
  return {
    assemble(db: AgentDB, context: AssemblyContext): AssembleResult {
      const systemBlocks: AnthropicSystemBlock[] = [];

      const staticSections = config.sections.filter((s) => s.placement === "static");
      for (const section of staticSections) {
        const result = section.resolve(db, context);
        systemBlocks.push(...normalizeToBlocks(result));
      }

      if (systemBlocks.length > 0) {
        const last = systemBlocks.at(-1)!;
        if (!last.cache_control) {
          last.cache_control = { type: "ephemeral" };
        }
      }

      const dynamicSections = config.sections.filter((s) => s.placement === "dynamic");
      for (const section of dynamicSections) {
        if (section.name === "conversation") continue;
        systemBlocks.push(...normalizeToBlocks(section.resolve(db, context)));
      }

      const convSection = dynamicSections.find((s) => s.name === "conversation");
      const messages =
        convSection !== undefined ? formatConversation(convSection.resolve(db, context)) : [];

      return {
        system: systemBlocks,
        messages,
        tools: config.tools ?? [],
      };
    },
  };
}
