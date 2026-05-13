# gents — MCP Server

The agent database is exposed as an MCP server. This serves two purposes: the agent's own tools route through it, and external LLM clients (Cursor, Claude Desktop) can connect to it.

---

## Dual-Use Design

```
┌─────────────────────────────────────────────────┐
│                 MCP Server                        │
│                                                   │
│  Tools:                                           │
│    code_search · compact_conversation ·           │
│    index_status · get_context · inspect_db        │
│                                                   │
│  Resources:                                       │
│    conversation:// · events:// · config://        │
│                                                   │
└──────────────────┬──────────────────┬────────────┘
                   │                  │
         ┌─────────┘                  └──────────┐
         ▼                                       ▼
┌─────────────────┐                   ┌─────────────────┐
│  Agent Loop     │                   │  External Client │
│  (internal)     │                   │  (Cursor, etc.)  │
│                 │                   │                  │
│  Uses tools via │                   │  Connects via    │
│  direct call or │                   │  stdio or HTTP   │
│  MCP client     │                   │                  │
└─────────────────┘                   └─────────────────┘
```

### Internal Use

The agent loop calls tools directly (function calls). But the same operations are also available via MCP. This means:
- The agent can be configured to use MCP transport for its own operations (useful for testing, logging, or remote execution)
- Tool definitions are shared between internal and external interfaces
- The MCP server is the canonical API for agent-db operations

### External Use

When run in MCP mode (`gents mcp`), the server accepts connections over stdio. This integrates with:
- **Cursor** — add gents as an MCP server in settings, get code search in any Cursor chat
- **Claude Desktop** — same, via MCP server config
- **Other agents** — any MCP client can use gents' code intelligence

---

## Tools Exposed

### code_search

Hybrid BM25 + semantic search over the indexed codebase.

```json
{
  "name": "code_search",
  "description": "Search the codebase using natural language or code snippets. Returns relevant code chunks ranked by combined keyword and semantic similarity.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural language question or code snippet to search for"
      },
      "limit": {
        "type": "number",
        "description": "Maximum results to return (default: 20)"
      },
      "languages": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Filter by programming language (e.g. ['typescript', 'python'])"
      },
      "paths": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Filter by path glob patterns (e.g. ['src/**', '!test/**'])"
      }
    },
    "required": ["query"]
  }
}
```

### compact_conversation

Triggers conversation compaction. The agent calls this when it detects context pressure.

```json
{
  "name": "compact_conversation",
  "description": "Compact earlier conversation turns into a summary to free context space. Creates a marker; subsequent context assembly will use the summary instead of raw messages before the marker.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "up_to_turn": {
        "type": "number",
        "description": "Compact all messages up to and including this turn number"
      },
      "summary": {
        "type": "string",
        "description": "A comprehensive summary of the compacted conversation turns"
      }
    },
    "required": ["up_to_turn", "summary"]
  }
}
```

### index_codebase

Trigger incremental re-indexing.

```json
{
  "name": "index_codebase",
  "description": "Update the code search index. Only re-indexes files that have changed since last index.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "force": {
        "type": "boolean",
        "description": "Force full re-index even if files appear unchanged"
      }
    }
  }
}
```

### index_status

Check the state of the code index.

```json
{
  "name": "index_status",
  "description": "Returns statistics about the current code index: total files, total chunks, last indexed timestamp, files pending indexing.",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

### inspect_db

Read agent database state for debugging/transparency.

```json
{
  "name": "inspect_db",
  "description": "Inspect the agent database. Returns table row counts, recent events, current config, and conversation summary.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "table": {
        "type": "string",
        "enum": ["events", "messages", "code_chunks", "file_tree", "config", "metrics"],
        "description": "Specific table to inspect (omit for overview)"
      },
      "limit": {
        "type": "number",
        "description": "Max rows to return when inspecting a specific table"
      }
    }
  }
}
```

---

## Resources Exposed

MCP resources provide read-only access to agent state:

### conversation://current

The current conversation (with compaction applied).

### events://recent?limit=50

Recent events from the log.

### config://all

Current agent configuration.

### index://stats

Index statistics (file count, chunk count, last update).

---

## Transport

### stdio (default for external clients)

```bash
# In Cursor MCP settings or Claude Desktop config:
{
  "mcpServers": {
    "gents": {
      "command": "gents",
      "args": ["mcp", "--repo", "/path/to/project"]
    }
  }
}
```

### HTTP (future, for cloud)

Streamable HTTP transport for remote MCP access. Enables cloud dashboard or remote agents to interact with a running agent's database.

---

## Relationship to Agent Tools

The agent loop's built-in tool registry includes `code_search`, `compact_conversation`, etc. These tools can be implemented in two ways:

1. **Direct function call** (default for performance): The tool implementation directly calls agent-db functions.
2. **Via MCP client** (optional): The tool routes through the MCP server. Useful when the agent runs remotely and the database is accessed over the network.

Both paths call the same underlying functions. The MCP server is the external-facing interface; direct calls are the fast internal path.
