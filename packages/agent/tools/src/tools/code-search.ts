import path from "node:path";
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { hybridSearch, validateAndRefreshResults } from "@gents/agent-db";
import type { SearchOptions, SearchResult } from "@gents/agent-db";
import type { ToolDefinition } from "../types.js";
import { truncate } from "../utils.js";

const LANG_EXT: Record<string, string[]> = {
  typescript: [".ts", ".tsx"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  python: [".py"],
  rust: [".rs"],
  go: [".go"],
  java: [".java"],
  kotlin: [".kt", ".kts"],
  csharp: [".cs"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp"],
  c: [".c", ".h"],
  ruby: [".rb"],
  php: [".php"],
  swift: [".swift"],
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".svn", ".hg"]);

async function* walkFiles(
  dir: string,
  skipDirs: Set<string>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (signal?.aborted) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (signal?.aborted) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue;
      yield* walkFiles(full, skipDirs, signal);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

function matchesLanguages(filePath: string, langs?: string[]): boolean {
  if (!langs?.length) return true;
  const lower = filePath.toLowerCase();
  for (const lang of langs) {
    const exts = LANG_EXT[lang.toLowerCase()];
    if (!exts) continue;
    if (exts.some((ext) => lower.endsWith(ext))) return true;
  }
  return false;
}

function matchesPaths(relPath: string, prefixes?: string[]): boolean {
  if (!prefixes?.length) return true;
  const norm = relPath.split(path.sep).join("/");
  return prefixes.some((p) => {
    const prefix = p.replace(/\\/g, "/");
    return norm === prefix || norm.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
  });
}

async function grepFallback(
  repoPath: string,
  query: string,
  opts?: { limit?: number; languages?: string[]; paths?: string[]; signal?: AbortSignal },
): Promise<string> {
  const limit = opts?.limit ?? 20;
  const matches: string[] = [];
  const root = path.resolve(repoPath);

  outer: for await (const abs of walkFiles(root, SKIP_DIRS, opts?.signal)) {
    const rel = path.relative(root, abs);
    if (!matchesPaths(rel, opts?.paths)) continue;
    if (!matchesLanguages(abs, opts?.languages)) continue;

    let content: string;
    try {
      content = await Bun.file(abs).text();
    } catch {
      continue;
    }
    if (!content.includes(query)) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.includes(query)) continue;
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length - 1, i + 1);
      const snippet = lines.slice(start, end + 1).join("\n");
      matches.push(`--- ${rel}:${start + 1}-${end + 1} ---\n${snippet}`);
      if (matches.length >= limit) break outer;
    }
  }

  if (matches.length === 0) {
    return `No matches for "${query}" (filesystem grep fallback).`;
  }
  return truncate(matches.join("\n\n"));
}

function formatHybridResults(results: SearchResult[]): string {
  if (results.length === 0) return "No search results.";
  const chunks = results.map((r) => {
    const lang = r.language ?? "?";
    const score =
      typeof r.score === "number" && Number.isFinite(r.score) ? r.score.toFixed(4) : String(r.score);
    return `--- ${r.path}:${r.startLine}-${r.endLine} (${lang}, score=${score}) ---\n${r.chunkText}`;
  });
  return truncate(chunks.join("\n\n"));
}

const inputSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional(),
  languages: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
});

export const codeSearchTool: ToolDefinition = {
  name: "code_search",
  description:
    "Hybrid lexical/semantic code search over the indexed repo when available; otherwise scans files for substring matches.",
  inputSchema,
  async execute(input, context): Promise<string> {
    try {
      const parsed = input as z.infer<typeof inputSchema>;
      const opts: SearchOptions = {
        limit: parsed.limit,
        languages: parsed.languages,
        paths: parsed.paths,
      };

      try {
        let results = hybridSearch(context.db, parsed.query, opts);
        if (context.db.workspace) {
          results = validateAndRefreshResults(context.db.workspace, results);
        }
        return formatHybridResults(results);
      } catch (searchErr) {
        const errMsg = searchErr instanceof Error ? searchErr.message : String(searchErr);
        const isHarmless = /no such table|no such column|database.*not/.test(errMsg);
        const fallback = await grepFallback(context.repoPath, parsed.query, {
          ...opts,
          signal: context.signal,
        });
        if (isHarmless) {
          return fallback;
        }
        return `[warning: index search failed: ${errMsg}]\n${fallback}`;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error: ${msg}`;
    }
  },
};
