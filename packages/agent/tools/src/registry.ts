import { z } from "zod";
import type { AnthropicToolDef, ToolContext, ToolDefinition, ToolRegistry } from "./types.js";
import { zodToJsonSchema } from "./zod-to-json.js";

const NAME_RE = /^[a-zA-Z0-9_]+$/;

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      if (!NAME_RE.test(tool.name)) {
        throw new Error(
          `Invalid tool name "${tool.name}": use only letters, digits, and underscores.`,
        );
      }
      tools.set(tool.name, tool);
    },

    get(name: string): ToolDefinition | undefined {
      return tools.get(name);
    },

    list(): ToolDefinition[] {
      return [...tools.values()];
    },

    listForLLM(): AnthropicToolDef[] {
      const defs: AnthropicToolDef[] = [];
      for (const t of tools.values()) {
        let input_schema: Record<string, unknown>;
        try {
          input_schema = zodToJsonSchema(t.inputSchema as z.ZodTypeAny);
        } catch {
          input_schema = { type: "object", properties: {} };
        }
        defs.push({ name: t.name, description: t.description, input_schema });
      }
      return defs;
    },

    async execute(name: string, input: unknown, context: ToolContext): Promise<string> {
      const tool = tools.get(name);
      if (!tool) {
        return `Error: unknown tool "${name}".`;
      }

      let parsed: unknown;
      try {
        parsed = (tool.inputSchema as z.ZodType).parse(input);
      } catch (e) {
        const msg = e instanceof z.ZodError ? e.flatten() : e instanceof Error ? e.message : String(e);
        return `Validation error for tool "${name}": ${typeof msg === "string" ? msg : JSON.stringify(msg)}`;
      }

      try {
        return await tool.execute(parsed, context);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `Error executing tool "${name}": ${msg}`;
      }
    },
  };
}
