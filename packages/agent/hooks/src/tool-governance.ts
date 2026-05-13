import { globMatch } from "@gents/agent-db";
import type { GovernanceConfig, Hook, HookContext, PreHookResult } from "./types";

const PATH_KEYS = [
  "path",
  "filePath",
  "filepath",
  "file",
  "filename",
  "target",
  "directory",
  "dest",
  "src",
  "destination",
  "source",
  "uri",
  "url",
] as const;

const segmentRegexCache = new Map<string, RegExp>();

function getSegmentRegex(patternSeg: string): RegExp {
  let re = segmentRegexCache.get(patternSeg);
  if (!re) {
    const escaped = patternSeg
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    re = new RegExp(`^${escaped}$`);
    segmentRegexCache.set(patternSeg, re);
  }
  return re;
}

function pathsFromInput(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const obj = input as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const val = obj[key];
    if (typeof val === "string") paths.push(val);
  }
  for (const val of Object.values(obj)) {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      const nested = val as Record<string, unknown>;
      for (const key of PATH_KEYS) {
        const nval = nested[key];
        if (typeof nval === "string") paths.push(nval);
      }
    }
  }
  return paths;
}

function matchToolName(pattern: string, toolName: string): boolean {
  if (!pattern.includes("*")) return pattern === toolName;
  return getSegmentRegex(pattern).test(toolName);
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
      input: unknown,
    ): Promise<PreHookResult> {
      if (denied.some((p) => matchToolName(p, toolName))) {
        return { action: "reject", reason: `Tool "${toolName}" is denied` };
      }
      if (
        allowed !== undefined &&
        !allowed.some((p) => matchToolName(p, toolName))
      ) {
        return {
          action: "reject",
          reason: `Tool "${toolName}" is not allowed`,
        };
      }

      if (paths !== undefined) {
        const inputPaths = pathsFromInput(input);
        for (const pathStr of inputPaths) {
          for (const pattern of paths.deny ?? []) {
            if (globMatch(pattern, pathStr)) {
              return {
                action: "reject",
                reason: `Path "${pathStr}" denied by policy`,
              };
            }
          }
          const allowList = paths.allow;
          if (allowList !== undefined) {
            const ok = allowList.some((pattern) =>
              globMatch(pattern, pathStr),
            );
            if (!ok) {
              return {
                action: "reject",
                reason: `Path "${pathStr}" not allowed by policy`,
              };
            }
          }
        }
      }

      return { action: "continue" };
    },
  };
}
