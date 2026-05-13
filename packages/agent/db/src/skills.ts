import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { sqlError } from "./errors";
import type { AgentDB, Skill } from "./types";

// --- DB queries ---

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

export interface SkillCatalogEntry {
  name: string;
  description: string;
  source: string;
}

/** Returns name + description for every skill (lightweight, no instructions). */
export function listSkillCatalog(db: AgentDB): SkillCatalogEntry[] {
  try {
    return db.db
      .prepare(`SELECT name, description, source FROM skills ORDER BY name`)
      .all() as SkillCatalogEntry[];
  } catch (e) {
    throw sqlError("listSkillCatalog", e);
  }
}

/** Fetch a supporting file for a skill by relative path. */
export function getSkillFile(db: AgentDB, skillName: string, filePath: string): string | undefined {
  try {
    const row = db.db
      .prepare(`SELECT content FROM skill_files WHERE skill_name = ? AND path = ?`)
      .get(skillName, filePath) as { content: string } | null;
    return row?.content;
  } catch (e) {
    throw sqlError("getSkillFile", e);
  }
}

/** List all supporting file paths for a skill. */
export function listSkillFiles(db: AgentDB, skillName: string): string[] {
  try {
    const rows = db.db
      .prepare(`SELECT path FROM skill_files WHERE skill_name = ? ORDER BY path`)
      .all(skillName) as { path: string }[];
    return rows.map((r) => r.path);
  } catch (e) {
    throw sqlError("listSkillFiles", e);
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

function upsertSkillFile(db: AgentDB, skillName: string, filePath: string, content: string): void {
  db.db
    .prepare(
      `INSERT OR REPLACE INTO skill_files (skill_name, path, content, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(skillName, filePath, content, Date.now());
}

function deleteSkillFiles(db: AgentDB, skillName: string): void {
  db.db.prepare(`DELETE FROM skill_files WHERE skill_name = ?`).run(skillName);
}

// --- Frontmatter parsing ---

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface SkillFrontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(contents: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = FRONTMATTER_RE.exec(contents);
  if (!match) return { frontmatter: {}, body: contents };

  const body = contents.slice(match[0].length);
  const raw = parseYamlLite(match[1]!);
  const fm: SkillFrontmatter = {};
  if (raw.name) fm.name = raw.name;
  if (raw.description) fm.description = raw.description;

  return { frontmatter: fm, body };
}

/**
 * Minimal YAML parser that handles scalar values, quoted strings,
 * and YAML folded/literal block scalars (>-, |-, >, |) plus
 * indented continuation lines.
 */
function parseYamlLite(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1 || line[0] === " " || line[0] === "\t") {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    if (value === ">-" || value === "|-" || value === ">" || value === "|") {
      const parts: string[] = [];
      i++;
      while (i < lines.length && (lines[i]!.startsWith("  ") || lines[i]!.trim() === "")) {
        parts.push(lines[i]!.replace(/^  /, ""));
        i++;
      }
      const joined = value.startsWith(">")
        ? parts.join(" ").replace(/\s+/g, " ").trim()
        : parts.join("\n").trim();
      if (key && joined) result[key] = joined;
      continue;
    }

    value = value.replace(/^["']|["']$/g, "");
    if (key && value) result[key] = value;
    i++;
  }

  return result;
}

// --- Filesystem scanning ---

export interface SkillDirConfig {
  dir: string;
  source: "builtin" | "user";
}

/**
 * Walk a directory recursively collecting all `.md` files.
 * Returns paths relative to `baseDir`.
 */
function walkMdFiles(baseDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(path.relative(baseDir, fullPath));
      }
    }
  }

  walk(baseDir);
  return results;
}

/**
 * Scan a single skill directory (a directory containing SKILL.md + supporting files).
 * Upserts the skill and all its supporting files into the DB.
 */
function scanSingleSkill(db: AgentDB, skillDir: string, source: "builtin" | "user"): void {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) return;

  const contents = readFileSync(skillMdPath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(contents);
  const dirName = path.basename(skillDir);
  const name = frontmatter.name ?? dirName;
  const description = frontmatter.description ?? "";

  upsertSkill(db, {
    name,
    description,
    instructions: body.trim(),
    source,
  });

  deleteSkillFiles(db, name);

  const allMdFiles = walkMdFiles(skillDir);
  for (const relPath of allMdFiles) {
    if (relPath === "SKILL.md") continue;
    const filePath = path.join(skillDir, relPath);
    const fileContents = readFileSync(filePath, "utf-8");
    upsertSkillFile(db, name, relPath, fileContents);
  }
}

/**
 * Scan skill directories and upsert all discovered skills + files into the DB.
 * Directories are processed in order; later entries override earlier ones by name,
 * so pass builtins first and user skills second.
 */
export function scanSkillDirs(db: AgentDB, dirs: SkillDirConfig[]): void {
  const tx = db.db.transaction(() => {
    for (const { dir, source } of dirs) {
      if (!existsSync(dir)) continue;

      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = path.join(dir, entry.name);
        try {
          const st = statSync(path.join(skillDir, "SKILL.md"));
          if (!st.isFile()) continue;
        } catch {
          continue;
        }
        scanSingleSkill(db, skillDir, source);
      }
    }
  });

  try {
    tx();
  } catch (e) {
    throw sqlError("scanSkillDirs", e);
  }
}
