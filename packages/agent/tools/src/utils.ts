import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export const MAX_OUTPUT_CHARS = 10_000;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export function truncate(s: string, maxLen = MAX_OUTPUT_CHARS): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}\n...[truncated ${s.length - maxLen} chars]`;
}

/**
 * Resolve a user-supplied path within the repository root, guarding against
 * both path-traversal (../) and symlink escapes.  When the target file does
 * not exist yet (write/mkdir scenarios), the parent directory is checked
 * instead.
 */
export function resolveSafePath(repoPath: string, userPath: string): string {
  const root = realpathSync(path.resolve(repoPath));
  const resolved = path.resolve(root, userPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path escapes repository root");
  }

  try {
    const real = realpathSync(resolved);
    if (!real.startsWith(root + path.sep) && real !== root) {
      throw new Error("Path escapes repository root via symlink");
    }
    return real;
  } catch (e) {
    if (e instanceof Error && e.message.includes("escapes")) throw e;
    // Target doesn't exist yet — verify the parent instead.
    try {
      const realParent = realpathSync(path.dirname(resolved));
      if (!realParent.startsWith(root + path.sep) && realParent !== root) {
        throw new Error("Path escapes repository root via symlink");
      }
    } catch (pe) {
      if (pe instanceof Error && pe.message.includes("escapes")) throw pe;
    }
    return resolved;
  }
}

/**
 * Throw if `abs` exceeds the size limit.  Silently no-ops when the file
 * doesn't exist (the caller will handle that separately).
 */
export function assertFileSizeLimit(abs: string, maxSize = MAX_FILE_SIZE): void {
  try {
    const { size } = statSync(abs);
    if (size > maxSize) {
      const mb = (size / 1024 / 1024).toFixed(1);
      const maxMb = (maxSize / 1024 / 1024).toFixed(0);
      throw new Error(`File too large (${mb}MB, max ${maxMb}MB)`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("too large")) throw e;
  }
}

// ── Process spawning ────────────────────────────────────────────────────

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export async function spawnWithTimeout(
  cmd: string[],
  opts: {
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<SpawnResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer =
    opts.timeoutMs != null
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, opts.timeoutMs)
      : undefined;

  const onAbort = opts.signal
    ? () => {
        proc.kill();
      }
    : undefined;
  if (onAbort) opts.signal!.addEventListener("abort", onAbort, { once: true });

  let stdout = "";
  let stderr = "";
  try {
    stdout = await new Response(proc.stdout).text();
    stderr = await new Response(proc.stderr).text();
  } catch {
    /* process may have been killed */
  }

  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } catch {
    exitCode = null;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) opts.signal!.removeEventListener("abort", onAbort);
  }

  return { stdout, stderr, exitCode, timedOut };
}
