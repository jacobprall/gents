/**
 * Unified glob/pattern matching for the agent workspace.
 * Supports *, **, and ? wildcards with forward-slash path separators.
 */

const regexCache = new Map<string, RegExp>();

function normalizeSlashes(str: string): string {
  return str.replace(/\\/g, "/");
}

function splitSegments(str: string): string[] {
  return normalizeSlashes(str).split("/").filter(Boolean);
}

function resolveTraversals(segments: string[]): string[] {
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }
  return resolved;
}

function segmentMatchesPattern(patternSeg: string, pathSeg: string): boolean {
  if (patternSeg === "*") return true;
  if (!patternSeg.includes("*") && !patternSeg.includes("?")) {
    return patternSeg === pathSeg;
  }
  let re = regexCache.get(patternSeg);
  if (!re) {
    const escaped = patternSeg
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    re = new RegExp(`^${escaped}$`);
    regexCache.set(patternSeg, re);
  }
  return re.test(pathSeg);
}

function matchRecursive(
  patternParts: string[],
  pathParts: string[],
  pi: number,
  si: number,
  memo: Map<number, boolean>,
): boolean {
  const key = pi * (pathParts.length + 1) + si;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let result: boolean;
  if (pi === patternParts.length) {
    result = si === pathParts.length;
  } else {
    const pat = patternParts[pi]!;
    if (pat === "**") {
      if (pi === patternParts.length - 1) {
        result = true;
      } else {
        result = false;
        for (let k = si; k <= pathParts.length; k++) {
          if (matchRecursive(patternParts, pathParts, pi + 1, k, memo)) {
            result = true;
            break;
          }
        }
      }
    } else if (si === pathParts.length) {
      result = false;
    } else if (!segmentMatchesPattern(pat, pathParts[si]!)) {
      result = false;
    } else {
      result = matchRecursive(patternParts, pathParts, pi + 1, si + 1, memo);
    }
  }

  memo.set(key, result);
  return result;
}

/**
 * Test whether a file path matches a glob pattern.
 * Resolves `..` traversals in the path before matching.
 *
 * Patterns:
 *   - `*`  matches any single path segment (no slashes)
 *   - `**` matches zero or more path segments
 *   - `?`  matches a single non-slash character
 *
 * Also supports plain string prefix/suffix matching for non-wildcard patterns.
 */
export function globMatch(pattern: string, path: string): boolean {
  const patNorm = normalizeSlashes(pattern).replace(/^\/+/, "").replace(/\/+$/, "");
  const pathNorm = normalizeSlashes(path).replace(/^\/+/, "");

  if (!patNorm.includes("*") && !patNorm.includes("?")) {
    return (
      pathNorm === patNorm ||
      pathNorm.startsWith(`${patNorm}/`) ||
      pathNorm.endsWith(`/${patNorm}`) ||
      pathNorm.includes(`/${patNorm}/`)
    );
  }

  const patternParts = splitSegments(patNorm);
  const pathParts = resolveTraversals(splitSegments(pathNorm));
  return matchRecursive(patternParts, pathParts, 0, 0, new Map());
}

/**
 * Compile a glob pattern to a RegExp for repeated use in hot loops.
 * Useful for filtering large file lists.
 */
export function globToRegex(pattern: string): RegExp {
  const norm = normalizeSlashes(pattern).replace(/^\/+/, "");
  let re = regexCache.get(`full:${norm}`);
  if (re) return re;

  const esc = norm
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0DS\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\0DS\0/g, ".*");
  re = new RegExp(`^(?:${esc})$|(?:^|/)(?:${esc})(?:/|$)`);
  regexCache.set(`full:${norm}`, re);
  return re;
}
