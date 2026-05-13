import type { AgentDB } from "@gents/agent-db";

export type MaybePromise<T> = T | Promise<T>;

export interface ContentBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** @deprecated Use ContentBlock directly. */
export type AnthropicSystemBlock = ContentBlock;

export interface Section {
  name: string;
  placement: "static" | "dynamic";
  resolve: (db: AgentDB, context: AssemblyContext) => MaybePromise<string | ContentBlock[]>;
}

export interface AssemblyContext {
  searchQuery?: string;
  currentTurn?: number;
  metadata?: Record<string, unknown>;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ConversationResolver = (
  db: AgentDB,
  context: AssemblyContext,
) => MaybePromise<unknown>;

export interface PromptConfig {
  sections: Section[];
  tools?: AnthropicToolDef[];
  conversationResolver?: ConversationResolver;
  /** Approximate max tokens for the system prompt. Sections are dropped (lowest priority first) if exceeded. */
  maxSystemTokens?: number;
}

export interface SectionWithPriority extends Section {
  /** Higher = more important, kept when trimming. Default: 0. */
  priority?: number;
}

export interface AssembleResult {
  system: ContentBlock[];
  messages: AnthropicMessage[];
  tools: AnthropicToolDef[];
}

export interface Prompt {
  assemble(db: AgentDB, context: AssemblyContext): Promise<AssembleResult>;
}
