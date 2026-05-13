import type { AgentBlueprint, AgentDB, Permission, ToolDef } from "./types";
import { sqlError } from "./errors";
import { generateUUIDv7 } from "./uuid";
import { DEFAULT_SKILLS, DEFAULT_SUBAGENT_DEFS } from "./default-skills";

export const DEFAULT_EXCLUDE_PATTERNS: string[] = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/target/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/.tox/**",
  "**/.gradle/**",
  "**/.idea/**",
  "**/.vscode/**",
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/Cargo.lock",
  "**/composer.lock",
  "**/Gemfile.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.ico",
  "**/*.pdf",
  "**/*.zip",
  "**/*.tar",
  "**/*.gz",
  "**/*.wasm",
  "**/*.exe",
  "**/*.dll",
  "**/*.so",
  "**/*.dylib",
];

const defaultTool = (name: string, description: string, inputSchema: Record<string, unknown>): ToolDef => ({
  name,
  description,
  inputSchema,
  enabled: true,
});

export const DEFAULT_BLUEPRINT: AgentBlueprint = {
  name: "gents-default",
  tools: [
    defaultTool("read_file", "Read file contents at a path.", {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    }),
    defaultTool("write_file", "Create or overwrite a file.", {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    }),
    defaultTool("list_dir", "List files in a directory.", {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    }),
    defaultTool("grep", "Search for a pattern in the repo.", {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
    }),
    defaultTool("run_terminal_cmd", "Run a shell command (sandboxed).", {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    }),
  ],
  permissions: [
    { id: "deny-node-modules", type: "path_deny", pattern: "**/node_modules/**" },
    { id: "deny-git", type: "path_deny", pattern: "**/.git/**" },
  ],
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
  config: {
    model: "default",
    max_turns: "64",
  },
  skills: DEFAULT_SKILLS,
  subagents: DEFAULT_SUBAGENT_DEFS,
};

/**
 * Apply a blueprint's tools, permissions, patterns, config, and seed messages atomically.
 * All operations (including message inserts) are within a single transaction.
 */
export function applyBlueprint(db: AgentDB, blueprint: AgentBlueprint): void {
  const now = Date.now();
  const tx = db.db.transaction(() => {
    for (const tool of blueprint.tools) {
      const definition = JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        enabled: tool.enabled ?? true,
        config: tool.config,
      });
      const cfg = tool.config != null ? JSON.stringify(tool.config) : null;
      db.db
        .prepare(`INSERT OR REPLACE INTO tools (name, definition, enabled, config) VALUES (?,?,?,?)`)
        .run(tool.name, definition, tool.enabled === false ? 0 : 1, cfg);
    }

    for (const perm of blueprint.permissions) {
      db.db
        .prepare(`INSERT OR REPLACE INTO permissions (id, type, pattern, created_at) VALUES (?,?,?,?)`)
        .run(perm.id, perm.type, perm.pattern, now);
    }

    for (const pattern of blueprint.excludePatterns) {
      db.db
        .prepare(`INSERT OR REPLACE INTO exclude_patterns (pattern, source) VALUES (?,?)`)
        .run(pattern, "blueprint");
    }

    for (const [key, value] of Object.entries(blueprint.config)) {
      db.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?,?)`).run(key, value);
    }

    if (blueprint.systemInstructions != null && blueprint.systemInstructions.length > 0) {
      db.db
        .prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?,?)`)
        .run("system_instructions", blueprint.systemInstructions);

      const id = generateUUIDv7();
      db.db
        .prepare(
          `INSERT INTO messages (id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, 0, "system", blueprint.systemInstructions, null, null, null, null, null, now);
    }

    if (blueprint.name) {
      db.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?,?)`).run("blueprint_name", blueprint.name);
    }

    if (blueprint.seedMessages != null) {
      for (const msg of blueprint.seedMessages) {
        const id = generateUUIDv7();
        db.db
          .prepare(
            `INSERT INTO messages (id, turn, role, content, tool_calls, tool_call_id, tokens_in, tokens_out, cost_usd, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            msg.turn,
            msg.role,
            msg.content ?? null,
            msg.toolCalls ?? null,
            msg.toolCallId ?? null,
            msg.tokensIn ?? null,
            msg.tokensOut ?? null,
            msg.costUsd ?? null,
            now,
          );
      }
    }

    if (blueprint.skills != null) {
      for (const skill of blueprint.skills) {
        db.db
          .prepare(
            `INSERT OR REPLACE INTO skills (name, description, instructions, source, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(skill.name, skill.description, skill.instructions, skill.source ?? "blueprint", now);
      }
    }

    if (blueprint.subagents != null) {
      for (const sa of blueprint.subagents) {
        db.db
          .prepare(
            `INSERT OR REPLACE INTO subagent_defs
             (name, skill, description, allowed_tools, max_iterations, max_cost_usd, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sa.name,
            sa.skill,
            sa.description,
            JSON.stringify(sa.allowedTools),
            sa.maxIterations ?? 10,
            sa.maxCostUsd ?? null,
            sa.source ?? "blueprint",
            now,
          );
      }
    }
  });

  try {
    tx();
  } catch (e) {
    throw sqlError("applyBlueprint", e);
  }
}

export function getEnabledTools(db: AgentDB): ToolDef[] {
  try {
    const rows = db.db.prepare(`SELECT definition FROM tools WHERE enabled = 1 ORDER BY name`).all() as {
      definition: string;
    }[];
    const out: ToolDef[] = [];
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.definition) as ToolDef;
        out.push(parsed);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch (e) {
    throw sqlError("getEnabledTools", e);
  }
}

export function getPermissions(db: AgentDB): Permission[] {
  try {
    return db.db
      .prepare(`SELECT id, type, pattern FROM permissions ORDER BY created_at ASC`)
      .all()
      .map((r) => {
        const row = r as { id: string; type: string; pattern: string };
        return {
          id: row.id,
          type: row.type as Permission["type"],
          pattern: row.pattern,
        };
      });
  } catch (e) {
    throw sqlError("getPermissions", e);
  }
}
