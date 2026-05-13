import type { Skill, SubagentDef } from "./types";

/**
 * Hardcoded default skills have been replaced by file-based bundled skills
 * in packages/agent/skills/bundled/. Skills are now loaded from disk via scanSkillDirs()
 * at session startup and stored in the DB.
 *
 * These empty arrays are kept for backward compatibility with DEFAULT_BLUEPRINT.
 */

export const DEFAULT_SKILLS: Skill[] = [];

export const DEFAULT_SUBAGENT_DEFS: SubagentDef[] = [];
