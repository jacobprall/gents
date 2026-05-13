import type { AgentDB } from "@gents/agent-db";
import { formatConversation, normalizeToBlocks } from "./format";
import type {
  ContentBlock,
  AssemblyContext,
  AssembleResult,
  Prompt,
  PromptConfig,
  SectionWithPriority,
} from "./types";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateBlockTokens(blocks: ContentBlock[]): number {
  let total = 0;
  for (const b of blocks) total += estimateTokens(b.text);
  return total;
}

interface ResolvedSection {
  blocks: ContentBlock[];
  placement: "static" | "dynamic";
  priority: number;
  tokens: number;
}

export function definePrompt(config: PromptConfig): Prompt {
  return {
    async assemble(db: AgentDB, context: AssemblyContext): Promise<AssembleResult> {
      const resolved: ResolvedSection[] = [];

      for (const section of config.sections) {
        const result = await section.resolve(db, context);
        const blocks = normalizeToBlocks(result);
        const priority = (section as SectionWithPriority).priority ?? 0;
        const tokens = estimateBlockTokens(blocks);
        resolved.push({ blocks, placement: section.placement, priority, tokens });
      }

      const maxTokens = config.maxSystemTokens;
      let sections = resolved;

      if (maxTokens != null && maxTokens > 0) {
        let totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
        if (totalTokens > maxTokens) {
          const sorted = [...sections].sort((a, b) => a.priority - b.priority);
          const dropped = new Set<ResolvedSection>();
          for (const s of sorted) {
            if (totalTokens <= maxTokens) break;
            dropped.add(s);
            totalTokens -= s.tokens;
          }
          sections = sections.filter((s) => !dropped.has(s));
        }
      }

      const staticBlocks: ContentBlock[] = [];
      const dynamicBlocks: ContentBlock[] = [];

      for (const section of sections) {
        if (section.placement === "static") {
          staticBlocks.push(...section.blocks);
        } else {
          dynamicBlocks.push(...section.blocks);
        }
      }

      if (staticBlocks.length > 0) {
        const last = staticBlocks[staticBlocks.length - 1]!;
        if (!last.cache_control) {
          staticBlocks[staticBlocks.length - 1] = {
            ...last,
            cache_control: { type: "ephemeral" },
          };
        }
      }

      const system = [...staticBlocks, ...dynamicBlocks];

      let messages: ReturnType<typeof formatConversation> = [];
      if (config.conversationResolver) {
        const rawConversation = await config.conversationResolver(db, context);
        messages = formatConversation(rawConversation);
      }

      return {
        system,
        messages,
        tools: config.tools ?? [],
      };
    },
  };
}
