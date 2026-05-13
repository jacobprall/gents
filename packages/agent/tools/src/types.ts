import type { Database } from "bun:sqlite";
import { z } from "zod";

/** Minimal DB handle for tools until full AgentDB is wired everywhere. */
export interface AgentDB {
  db: Database;
  repoPath?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute: (input: unknown, context: ToolContext) => Promise<string>;
}

export interface ToolContext {
  db: AgentDB;
  repoPath: string;
  workingDir: string;
  signal?: AbortSignal;
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  listForLLM(): AnthropicToolDef[];
  execute(name: string, input: unknown, context: ToolContext): Promise<string>;
}

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
