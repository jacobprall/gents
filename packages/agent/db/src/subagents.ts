import { sqlError } from "./errors";
import type { AgentDB, SubagentDef } from "./types";

export function getSubagentDef(db: AgentDB, name: string): SubagentDef | undefined {
  try {
    const row = db.db
      .prepare(
        `SELECT name, skill, description, allowed_tools, max_iterations, max_cost_usd, source
         FROM subagent_defs WHERE name = ?`,
      )
      .get(name) as {
      name: string;
      skill: string;
      description: string;
      allowed_tools: string;
      max_iterations: number | null;
      max_cost_usd: number | null;
      source: string;
    } | null;
    if (!row) return undefined;
    return {
      name: row.name,
      skill: row.skill,
      description: row.description,
      allowedTools: JSON.parse(row.allowed_tools) as string[],
      maxIterations: row.max_iterations ?? undefined,
      maxCostUsd: row.max_cost_usd ?? undefined,
      source: row.source as SubagentDef["source"],
    };
  } catch (e) {
    throw sqlError("getSubagentDef", e);
  }
}

export function listSubagentDefs(db: AgentDB): SubagentDef[] {
  try {
    const rows = db.db
      .prepare(
        `SELECT name, skill, description, allowed_tools, max_iterations, max_cost_usd, source
         FROM subagent_defs ORDER BY name`,
      )
      .all() as {
      name: string;
      skill: string;
      description: string;
      allowed_tools: string;
      max_iterations: number | null;
      max_cost_usd: number | null;
      source: string;
    }[];
    return rows.map((r) => ({
      name: r.name,
      skill: r.skill,
      description: r.description,
      allowedTools: JSON.parse(r.allowed_tools) as string[],
      maxIterations: r.max_iterations ?? undefined,
      maxCostUsd: r.max_cost_usd ?? undefined,
      source: r.source as SubagentDef["source"],
    }));
  } catch (e) {
    throw sqlError("listSubagentDefs", e);
  }
}

export function upsertSubagentDef(db: AgentDB, def: SubagentDef): void {
  try {
    db.db
      .prepare(
        `INSERT OR REPLACE INTO subagent_defs
         (name, skill, description, allowed_tools, max_iterations, max_cost_usd, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        def.name,
        def.skill,
        def.description,
        JSON.stringify(def.allowedTools),
        def.maxIterations ?? 10,
        def.maxCostUsd ?? null,
        def.source ?? "user",
        Date.now(),
      );
  } catch (e) {
    throw sqlError("upsertSubagentDef", e);
  }
}
