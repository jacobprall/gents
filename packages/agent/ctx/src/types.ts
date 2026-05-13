import type { AgentDB } from "@gents/agent-db";

export interface Section {
  name: string;
  placement: "static" | "dynamic";
  resolve: (db: AgentDB, context: AssemblyContext) => string | ContentBlock[];
}

export interface AssemblyContext {
  searchQuery?: string;
  currentTurn?: number;
  [key: string]: unknown;
}

export interface ContentBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
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

export interface PromptConfig {
  sections: Section[];
  tools?: AnthropicToolDef[];
}

export interface AssembleResult {
  system: AnthropicSystemBlock[];
  messages: AnthropicMessage[];
  tools: AnthropicToolDef[];
}

export interface Prompt {
  assemble(db: AgentDB, context: AssemblyContext): AssembleResult;
}
