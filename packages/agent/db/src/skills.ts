import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { sqlError } from "./errors";
import type { AgentDB, Skill } from "./types";

export function getSkill(db: AgentDB, name: string): Skill | undefined {
  try {
    const row = db.db
      .prepare(`SELECT name, description, instructions, source FROM skills WHERE name = ?`)
      .get(name) as { name: string; description: string; instructions: string; source: string } | null;
    if (!row) return undefined;
    return {
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      source: row.source as Skill["source"],
    };
  } catch (e) {
    throw sqlError("getSkill", e);
  }
}

export function listSkills(db: AgentDB): Skill[] {
  try {
    const rows = db.db
      .prepare(`SELECT name, description, instructions, source FROM skills ORDER BY name`)
      .all() as { name: string; description: string; instructions: string; source: string }[];
    return rows.map((r) => ({
      name: r.name,
      description: r.description,
      instructions: r.instructions,
      source: r.source as Skill["source"],
    }));
  } catch (e) {
    throw sqlError("listSkills", e);
  }
}

export function upsertSkill(db: AgentDB, skill: Skill): void {
  try {
    db.db
      .prepare(
        `INSERT OR REPLACE INTO skills (name, description, instructions, source, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(skill.name, skill.description, skill.instructions, skill.source ?? "user", Date.now());
  } catch (e) {
    throw sqlError("upsertSkill", e);
  }
}

// --- Filesystem-based skill loading ---

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse a single `.md` skill file into a Skill.
 * Supports optional YAML frontmatter with `name` and `description` fields.
 * Falls back to the filename (minus extension) as the skill name.
 */
export function parseSkillFile(filePath: string, contents: string): Skill {
  const basename = path.basename(filePath, ".md");
  let name = basename;
  let description = "";
  let body = contents;

  const match = FRONTMATTER_RE.exec(contents);
  if (match) {
    body = contents.slice(match[0].length);
    const frontmatter = match[1]!;
    for (const line of frontmatter.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "name" && value) name = value;
      if (key === "description" && value) description = value;
    }
  }

  return {
    name,
    description,
    instructions: body.trim(),
    source: "user",
  };
}

/**
 * Load all `.md` skill files from a directory.
 * Returns an empty array if the directory doesn't exist.
 * Pure function — no DB writes.
 */
export function loadSkillsFromDir(dir: string): Skill[] {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    const contents = readFileSync(filePath, "utf-8");
    skills.push(parseSkillFile(filePath, contents));
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
