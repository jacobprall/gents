import {
  compactConversation,
  getConversation,
  getEvents,
  getIndexStatus,
  hybridSearch,
  indexCodebase,
  type AgentDB,
} from "@gents/agent-db";
import { createToolRegistry, registerBuiltinTools, type ToolContext } from "@gents/agent-tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { MCPServerConfig, MCPServerHandle } from "./types.js";

const NATIVE_TOOL_NAMES = new Set([
  "code_search",
  "compact_conversation",
  "index_codebase",
  "index_status",
  "inspect_db",
]);

const INSPECT_TABLES = z.enum(["events", "messages", "code_chunks", "file_tree", "config", "metrics"]);

function allowName(name: string, config?: MCPServerConfig): boolean {
  const allowed = config?.tools;
  if (allowed == null || allowed.length === 0) return true;
  return allowed.includes(name);
}

function toolErr(message: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolOk(text: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text }] };
}

function resolveRepoPath(db: AgentDB, config?: MCPServerConfig): string {
  const p = config?.repoPath ?? db.repoPath;
  return p && p.length > 0 ? p : ".";
}

function zodShape(schema: z.ZodType): Record<string, z.ZodTypeAny> | null {
  if (schema instanceof z.ZodObject) {
    return schema.shape;
  }
  return null;
}

function registerInspectTool(server: McpServer, db: AgentDB, config?: MCPServerConfig): void {
  if (!allowName("inspect_db", config)) return;

  server.registerTool(
    "inspect_db",
    {
      description:
        "Inspect the agent database. Returns table row counts, recent events, and config; or rows from a specific table.",
      inputSchema: {
        table: INSPECT_TABLES.optional().describe("When set, return rows from this table"),
        limit: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe("Max rows when reading a table (default: 50)"),
      },
    },
    async (args) => {
      try {
        const limit = args.limit ?? 50;
        if (args.table == null) {
          const tables = ["events", "messages", "code_chunks", "file_tree", "config", "metrics"] as const;
          const rowCounts: Record<string, number> = {};
          for (const t of tables) {
            const row = db.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number };
            rowCounts[t] = Number(row.c);
          }
          const recentEvents = db.db
            .prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT 5`)
            .all() as Record<string, unknown>[];
          const configRows = db.db.prepare(`SELECT key, value FROM config`).all() as { key: string; value: string }[];
          const configObj = Object.fromEntries(configRows.map((r) => [r.key, r.value]));
          const overview = { rowCounts, recentEvents, config: configObj };
          return toolOk(JSON.stringify(overview, null, 2));
        }

        const table = args.table;
        let rows: unknown[];
        switch (table) {
          case "events":
            rows = db.db
              .prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT ?`)
              .all(limit) as unknown[];
            break;
          case "messages":
            rows = db.db
              .prepare(`SELECT * FROM messages ORDER BY turn DESC, created_at DESC LIMIT ?`)
              .all(limit) as unknown[];
            break;
          case "code_chunks":
            rows = db.db
              .prepare(
                `SELECT path, chunk_index, start_line, end_line, language, chunk_text FROM code_chunks ORDER BY rowid DESC LIMIT ?`,
              )
              .all(limit) as unknown[];
            break;
          case "file_tree":
            rows = db.db
              .prepare(`SELECT * FROM file_tree ORDER BY path ASC LIMIT ?`)
              .all(limit) as unknown[];
            break;
          case "config":
            rows = db.db.prepare(`SELECT * FROM config ORDER BY key ASC LIMIT ?`).all(limit) as unknown[];
            break;
          case "metrics":
            rows = db.db
              .prepare(`SELECT * FROM metrics ORDER BY turn DESC LIMIT ?`)
              .all(limit) as unknown[];
            break;
          default: {
            const _exhaustive: never = table;
            return toolErr(`Unsupported table: ${String(_exhaustive)}`);
          }
        }
        return toolOk(JSON.stringify(rows, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolErr(`inspect_db failed: ${msg}`);
      }
    },
  );
}

function registerNativeAgentDbTools(server: McpServer, db: AgentDB, config?: MCPServerConfig): void {
  if (allowName("code_search", config)) {
    server.registerTool(
      "code_search",
      {
        description:
          "Search the codebase using natural language or code snippets. Returns relevant code chunks ranked by combined keyword and semantic similarity.",
        inputSchema: {
          query: z.string().describe("Natural language question or code snippet to search for"),
          limit: z.number().optional().describe("Maximum results to return (default: 20)"),
          languages: z.array(z.string()).optional().describe("Filter by programming language"),
          paths: z.array(z.string()).optional().describe("Filter by path glob patterns"),
        },
      },
      async (args) => {
        try {
          const results = hybridSearch(db, args.query, {
            limit: args.limit,
            languages: args.languages,
            paths: args.paths,
          });
          const formatted = results
            .map(
              (r) =>
                `${r.path}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(2)})\n${r.chunkText}`,
            )
            .join("\n\n");
          return toolOk(formatted || "No results found.");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolErr(`code_search failed: ${msg}`);
        }
      },
    );
  }

  if (allowName("compact_conversation", config)) {
    server.registerTool(
      "compact_conversation",
      {
        description: "Compact earlier conversation turns into a summary to free context space.",
        inputSchema: {
          up_to_turn: z.number().describe("Compact all messages up to and including this turn number"),
          summary: z.string().describe("A comprehensive summary of the compacted conversation turns"),
        },
      },
      async (args) => {
        try {
          compactConversation(db, args.up_to_turn, args.summary);
          return toolOk(`Compacted conversation up to turn ${args.up_to_turn}.`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolErr(`compact_conversation failed: ${msg}`);
        }
      },
    );
  }

  if (allowName("index_codebase", config)) {
    server.registerTool(
      "index_codebase",
      {
        description: "Update the code search index. Only re-indexes files that have changed since last index.",
        inputSchema: {
          force: z.boolean().optional().describe("Force full re-index even if files appear unchanged"),
        },
      },
      async (args) => {
        try {
          const repoPath = resolveRepoPath(db, config);
          const result = indexCodebase(db, repoPath, { forceReindex: args.force });
          return toolOk(
            `Indexed ${result.filesScanned} files (${result.filesChanged} changed), created ${result.chunksCreated} chunks in ${result.elapsedMs}ms.`,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolErr(`index_codebase failed: ${msg}`);
        }
      },
    );
  }

  if (allowName("index_status", config)) {
    server.registerTool(
      "index_status",
      {
        description: "Returns statistics about the current code index.",
      },
      async () => {
        try {
          const status = getIndexStatus(db);
          return toolOk(JSON.stringify(status, null, 2));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolErr(`index_status failed: ${msg}`);
        }
      },
    );
  }

  registerInspectTool(server, db, config);
}

function registerRegistryTools(server: McpServer, db: AgentDB, config?: MCPServerConfig): void {
  const registry = createToolRegistry();
  const repoPath = resolveRepoPath(db, config);
  registerBuiltinTools(registry, { repoPath });

  const ctxBase: ToolContext = {
    db: { db: db.db, repoPath: db.repoPath },
    repoPath,
    workingDir: repoPath,
  };

  for (const tool of registry.list()) {
    if (NATIVE_TOOL_NAMES.has(tool.name)) continue;
    if (!allowName(tool.name, config)) continue;

    const shape = zodShape(tool.inputSchema);
    if (shape == null) continue;

    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: shape },
      async (args) => {
        try {
          const text = await tool.execute(args, ctxBase);
          return toolOk(text);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolErr(`${tool.name} failed: ${msg}`);
        }
      },
    );
  }
}

function registerMCPResources(server: McpServer, db: AgentDB): void {
  server.registerResource(
    "conversation",
    "conversation://current",
    { mimeType: "application/json" },
    async (uri) => {
      try {
        const messages = getConversation(db);
        return {
          contents: [{ uri: uri.href, text: JSON.stringify(messages, null, 2), mimeType: "application/json" }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ error: msg }),
              mimeType: "application/json",
            },
          ],
        };
      }
    },
  );

  server.registerResource(
    "events",
    "events://recent",
    { mimeType: "application/json" },
    async (uri) => {
      try {
        const events = getEvents(db, { limit: 50 });
        return {
          contents: [{ uri: uri.href, text: JSON.stringify(events, null, 2), mimeType: "application/json" }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ error: msg }),
              mimeType: "application/json",
            },
          ],
        };
      }
    },
  );

  server.registerResource(
    "config",
    "config://all",
    { mimeType: "application/json" },
    async (uri) => {
      try {
        const rows = db.db.prepare("SELECT key, value FROM config").all() as { key: string; value: string }[];
        const configObj = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        return {
          contents: [{ uri: uri.href, text: JSON.stringify(configObj, null, 2), mimeType: "application/json" }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ error: msg }),
              mimeType: "application/json",
            },
          ],
        };
      }
    },
  );

  server.registerResource(
    "index-stats",
    "index://stats",
    { mimeType: "application/json" },
    async (uri) => {
      try {
        const status = getIndexStatus(db);
        return {
          contents: [{ uri: uri.href, text: JSON.stringify(status, null, 2), mimeType: "application/json" }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ error: msg }),
              mimeType: "application/json",
            },
          ],
        };
      }
    },
  );
}

export function createMCPServer(db: AgentDB, config?: MCPServerConfig): MCPServerHandle {
  const server = new McpServer({
    name: "gents",
    version: "0.1.0",
  });

  registerNativeAgentDbTools(server, db, config);
  registerRegistryTools(server, db, config);

  if (config?.resources !== false) {
    registerMCPResources(server, db);
  }

  return {
    async serveStdio() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}
