import type { GovernanceConfig, Hook, HookContext, HookResult } from "./types";

function normalizePathSegments(pathStr: string): string[] {
  return pathStr.replace(/\\/g, "/").split("/").filter(Boolean);
}

function normalizePatternSegments(pattern: string): string[] {
  return pattern.replace(/\\/g, "/").split("/").filter(Boolean);
}

function matchSegment(patternSeg: string, pathSeg: string): boolean {
  if (patternSeg === "*") return true;
  if (!patternSeg.includes("*")) return patternSeg === pathSeg;
  const escaped = patternSeg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(pathSeg);
}

function matchGlob(patternParts: string[], pathParts: string[], pi: number, si: number): boolean {
  if (pi === patternParts.length) return si === pathParts.length;
  const pat = patternParts[pi]!;
  if (pat === "**") {
    if (pi === patternParts.length - 1) return true;
    for (let k = si; k <= pathParts.length; k++) {
      if (matchGlob(patternParts, pathParts, pi + 1, k)) return true;
    }
    return false;
  }
  if (si === pathParts.length) return false;
  if (!matchSegment(pat, pathParts[si]!)) return false;
  return matchGlob(patternParts, pathParts, pi + 1, si + 1);
}

function pathMatches(pattern: string, pathStr: string): boolean {
  return matchGlob(normalizePatternSegments(pattern), normalizePathSegments(pathStr), 0, 0);
}

function pathFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  if (!("path" in input)) return undefined;
  const p = (input as { path: unknown }).path;
  return typeof p === "string" ? p : undefined;
}

export function toolGovernance(config: GovernanceConfig): Hook {
  const denied = config.deniedTools ?? [];
  const allowed = config.allowedTools;
  const paths = config.pathRestrictions;

  return {
    name: "tool-governance",
    async preTool(
      _context: HookContext,
      toolName: string,
      input: unknown
    ): Promise<HookResult> {
      if (denied.includes(toolName)) {
        return { action: "reject", reason: `Tool "${toolName}" is denied` };
      }
      if (allowed !== undefined && !allowed.includes(toolName)) {
        return { action: "reject", reason: `Tool "${toolName}" is not allowed` };
      }

      if (paths !== undefined) {
        const pathStr = pathFromInput(input);
        if (pathStr !== undefined) {
          for (const pattern of paths.deny ?? []) {
            if (pathMatches(pattern, pathStr)) {
              return { action: "reject", reason: "Path denied by policy" };
            }
          }
          const allowList = paths.allow;
          if (allowList !== undefined && allowList.length > 0) {
            const ok = allowList.some((pattern) => pathMatches(pattern, pathStr));
            if (!ok) {
              return { action: "reject", reason: "Path not allowed by policy" };
            }
          }
        }
      }

      return { action: "continue" };
    },
  };
}
