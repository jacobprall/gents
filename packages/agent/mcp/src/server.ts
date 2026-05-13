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

// Single source of truth for inspectable tables — drives both the Zod enum and iteration.
const INSPECT_TABLES = ["events", "messages", "code_chunks", "file_tree", "config", "metrics"] as const;
type InspectTable = (typeof INSPECT_TABLES)[number];
const INSPECT_TABLE_ENUM = z.enum(INSPECT_TABLES);

// ---------------------------------------------------------------------------
// Access-control helpers
// ---------------------------------------------------------------------------

/** `undefined` = all, `[]` = none, `[...names]` = only those. */
function allowName(name: string, config?: MCPServerConfig): boolean {
  const allowed = config?.tools;
  if (allowed == null) return true;
  if (allowed.length === 0) return false;
  return allowed.includes(name);
}

function allowResource(name: string, config?: MCPServerConfig): boolean {
  if (config?.resources === false) return false;
  const allowed = config?.resourceNames;
  if (allowed == null) return true;
  if (allowed.length === 0) return false;
  return allowed.includes(name);
}

// ---------------------------------------------------------------------------
// Response helpers + handler wrappers
// ---------------------------------------------------------------------------

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: true };

function toolErr(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolOk(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Wraps a plain `(args) => string | Promise<string>` function into the shape
 * expected by `McpServer.registerTool`, with uniform error handling.
 */
function wrapToolHandler(
  name: string,
  fn: (args: any) => string | Promise<string>,
): (args: any) => Promise<ToolResult> {
  return async (args) => {
    try {
      return toolOk(await fn(args));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return toolErr(`${name} failed: ${msg}`);
    }
  };
}

/**
 * Wraps a plain `() => string | Promise<string>` function into the shape
 * expected by `McpServer.registerResource`, with uniform error handling.
 */
function wrapResourceHandler(fn: () => string | Promise<string>) {
  return async (uri: { href: string }) => {
    try {
      const text = await fn();
      return {
        contents: [{ uri: uri.href, text, mimeType: "application/json" }],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        contents: [{ uri: uri.href, text: JSON.stringify({ error: msg }), mimeType: "application/json" }],
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Path + schema helpers
// ---------------------------------------------------------------------------

function resolveRepoPath(db: AgentDB, config?: MCPServerConfig): string {
  const p = config?.repoPath ?? db.repoPath;
  return p && p.length > 0 ? p : ".";
}

/**
 * Extract the raw shape from a Zod schema so the MCP SDK can advertise it.
 * Handles plain `z.object()` and unwraps `z.ZodEffects` (`.refine()`, `.transform()`).
 */
function zodShape(schema: z.ZodType): Record<string, z.ZodTypeAny> | null {
  if (schema instanceof z.ZodObject) {
    return schema.shape;
  }
  if (schema instanceof z.ZodEffects) {
    return zodShape(schema.innerType());
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prepared-statement maps for inspect_db (avoids string-interpolating table
// names into SQL, even though the values are currently safe).
// ---------------------------------------------------------------------------

const INSPECT_QUERIES: Record<InspectTable, string> = {
  events: `SELECT * FROM events ORDER BY created_at DESC LIMIT ?`,
  messages: `SELECT * FROM messages ORDER BY turn DESC, created_at DESC LIMIT ?`,
  code_chunks: `SELECT path, chunk_index, start_line, end_line, language, chunk_text FROM code_chunks ORDER BY rowid DESC LIMIT ?`,
  file_tree: `SELECT * FROM file_tree ORDER BY path ASC LIMIT ?`,
  config: `SELECT * FROM config ORDER BY key ASC LIMIT ?`,
  metrics: `SELECT * FROM metrics ORDER BY turn DESC LIMIT ?`,
};

const INSPECT_COUNT_QUERIES: Record<InspectTable, string> = Object.fromEntries(
  INSPECT_TABLES.map((t) => [t, `SELECT COUNT(*) AS c FROM "${t}"`]),
) as Record<InspectTable, string>;

// ---------------------------------------------------------------------------
// Native tool registration (agent-db tools that bypass the tool registry)
// ---------------------------------------------------------------------------

function registerInspectTool(server: McpServer, db: AgentDB, config?: MCPServerConfig): string[] {
  if (!allowName("inspect_db", config)) return [];

  server.registerTool(
    "inspect_db",
    {
      description:
        "Inspect the agent database. Returns table row counts, recent events, and config; or rows from a specific table.",
      inputSchema: {
        table: INSPECT_TABLE_ENUM.optional().describe("When set, return rows from this table"),
        limit: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe("Max rows when reading a table (default: 50)"),
      },
    },
    wrapToolHandler("inspect_db", (args) => {
      const limit = args.limit ?? 50;

      if (args.table == null) {
        const rowCounts: Record<string, number> = {};
        for (const t of INSPECT_TABLES) {
          const row = db.db.prepare(INSPECT_COUNT_QUERIES[t]).get() as { c: number };
          rowCounts[t] = Number(row.c);
        }
        const recentEvents = db.db
          .prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT 5`)
          .all() as Record<string, unknown>[];
        const configRows = db.db
          .prepare(`SELECT key, value FROM config`)
          .all() as { key: string; value: string }[];
        const configObj = Object.fromEntries(configRows.map((r) => [r.key, r.value]));
        return JSON.stringify({ rowCounts, recentEvents, config: configObj }, null, 2);
      }

      const table: InspectTable = args.table;
      const rows = db.db.prepare(INSPECT_QUERIES[table]).all(limit);
      return JSON.stringify(rows);
    }),
  );

  return ["inspect_db"];
}

/**
 * Registers native agent-db tools on the MCP server and returns the set of
 * registered tool names so the registry pass can skip duplicates.
 */
function registerNativeAgentDbTools(server: McpServer, db: AgentDB, config?: MCPServerConfig): string[] {
  const registered: string[] = [];

  if (allowName("code_search", config)) {
    server.registerTool(
      "code_search",
      {
        description:
          "Search the codebase using natural language or code snippets. Returns relevant code chunks ranked by combined keyword and semantic similarity.",
        inputSchema: {
          query: z.string().describe("Natural language question or code snippet to search for"),
          limit: z
            .number()
            .int()
            .positive()
            .max(500)
            .optional()
            .describe("Maximum results to return (default: 20)"),
          languages: z.array(z.string()).optional().describe("Filter by programming language"),
          paths: z.array(z.string()).optional().describe("Filter by path glob patterns"),
        },
      },
      wrapToolHandler("code_search", (args) => {
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
        return formatted || "No results found.";
      }),
    );
    registered.push("code_search");
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
      wrapToolHandler("compact_conversation", (args) => {
        compactConversation(db, args.up_to_turn, args.summary);
        return `Compacted conversation up to turn ${args.up_to_turn}.`;
      }),
    );
    registered.push("compact_conversation");
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
      wrapToolHandler("index_codebase", (args) => {
        const repoPath = resolveRepoPath(db, config);
        const result = indexCodebase(db, repoPath, { forceReindex: args.force });
        return `Indexed ${result.filesScanned} files (${result.filesChanged} changed), created ${result.chunksCreated} chunks in ${result.elapsedMs}ms.`;
      }),
    );
    registered.push("index_codebase");
  }

  if (allowName("index_status", config)) {
    server.registerTool(
      "index_status",
      {
        description: "Returns statistics about the current code index.",
      },
      wrapToolHandler("index_status", () => {
        const status = getIndexStatus(db);
        return JSON.stringify(status, null, 2);
      }),
    );
    registered.push("index_status");
  }

  registered.push(...registerInspectTool(server, db, config));
  return registered;
}

// ---------------------------------------------------------------------------
// Registry tool bridge (tools from @gents/agent-tools exposed as MCP tools)
// ---------------------------------------------------------------------------

function registerRegistryTools(
  server: McpServer,
  db: AgentDB,
  nativeNames: Set<string>,
  config?: MCPServerConfig,
): void {
  const registry = createToolRegistry();
  const repoPath = resolveRepoPath(db, config);
  registerBuiltinTools(registry);

  for (const tool of registry.list()) {
    if (nativeNames.has(tool.name)) continue;
    if (!allowName(tool.name, config)) continue;

    const shape = zodShape(tool.inputSchema);
    if (shape == null) {
      console.warn(`[gents-mcp] Skipping tool "${tool.name}": could not extract input schema shape`);
      continue;
    }

    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: shape },
      wrapToolHandler(tool.name, async (args) => {
        const ctx: ToolContext = {
          db,
          repoPath,
          workingDir: repoPath,
        };
        return await tool.execute(args, ctx);
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// MCP resources
// ---------------------------------------------------------------------------

function registerMCPResources(server: McpServer, db: AgentDB, config?: MCPServerConfig): void {
  if (allowResource("conversation", config)) {
    server.registerResource(
      "conversation",
      "conversation://current",
      { mimeType: "application/json" },
      wrapResourceHandler(() => {
        const messages = getConversation(db);
        return JSON.stringify(messages, null, 2);
      }),
    );
  }

  if (allowResource("events", config)) {
    server.registerResource(
      "events",
      "events://recent",
      { mimeType: "application/json" },
      wrapResourceHandler(() => {
        const events = getEvents(db, { limit: 50 });
        return JSON.stringify(events, null, 2);
      }),
    );
  }

  if (allowResource("config", config)) {
    server.registerResource(
      "config",
      "config://all",
      { mimeType: "application/json" },
      wrapResourceHandler(() => {
        const rows = db.db.prepare("SELECT key, value FROM config").all() as { key: string; value: string }[];
        return JSON.stringify(Object.fromEntries(rows.map((r) => [r.key, r.value])), null, 2);
      }),
    );
  }

  if (allowResource("index-stats", config)) {
    server.registerResource(
      "index-stats",
      "index://stats",
      { mimeType: "application/json" },
      wrapResourceHandler(() => {
        const status = getIndexStatus(db);
        return JSON.stringify(status, null, 2);
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createMCPServer(db: AgentDB, config?: MCPServerConfig): MCPServerHandle {
  const server = new McpServer({
    name: "gents",
    version: "0.1.0",
  });

  // Native tools register first and report their names so the registry pass
  // can skip duplicates (no more hardcoded NATIVE_TOOL_NAMES set).
  const nativeNames = new Set(registerNativeAgentDbTools(server, db, config));
  registerRegistryTools(server, db, nativeNames, config);

  if (config?.resources !== false) {
    registerMCPResources(server, db, config);
  }

  let transport: StdioServerTransport | null = null;

  return {
    async serveStdio() {
      transport = new StdioServerTransport();
      await server.connect(transport);
    },
    async close() {
      await server.close();
      transport = null;
    },
  };
}
