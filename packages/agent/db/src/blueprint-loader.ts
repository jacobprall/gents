import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentBlueprint } from "./types";
import { DEFAULT_BLUEPRINT, DEFAULT_EXCLUDE_PATTERNS } from "./blueprint";

/**
 * Discover available blueprints from built-in defaults and user-defined JSON
 * files in `.gents/blueprints/`.
 */
export function discoverBlueprints(repoPath: string): AgentBlueprint[] {
  const results: AgentBlueprint[] = [DEFAULT_BLUEPRINT];

  const blueprintsDir = join(repoPath, ".gents", "blueprints");
  if (!existsSync(blueprintsDir)) return results;

  let files: string[];
  try {
    files = readdirSync(blueprintsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return results;
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(blueprintsDir, file), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.name !== "string" || !parsed.name) continue;

      const bp: AgentBlueprint = {
        name: parsed.name,
        description: typeof parsed.description === "string" ? parsed.description : undefined,
        tools: Array.isArray(parsed.tools) ? parsed.tools : [],
        permissions: Array.isArray(parsed.permissions) ? parsed.permissions : [],
        excludePatterns: Array.isArray(parsed.excludePatterns) ? parsed.excludePatterns : DEFAULT_EXCLUDE_PATTERNS,
        config: typeof parsed.config === "object" && parsed.config !== null && !Array.isArray(parsed.config)
          ? (parsed.config as Record<string, string>)
          : {},
        systemInstructions: typeof parsed.systemInstructions === "string" ? parsed.systemInstructions : undefined,
        seedMessages: Array.isArray(parsed.seedMessages) ? parsed.seedMessages : undefined,
        skills: Array.isArray(parsed.skills) ? parsed.skills : undefined,
        subagents: Array.isArray(parsed.subagents) ? parsed.subagents : undefined,
      };

      results.push(bp);
    } catch {
      /* skip malformed files */
    }
  }

  return results;
}
