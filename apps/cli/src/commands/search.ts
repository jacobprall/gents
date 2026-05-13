import { closeWorkspaceDB, hybridSearch } from "@gents/agent-db";
import { Command } from "commander";
import * as path from "node:path";

import { accent, muted, printError } from "../display";
import { openSession, openWorkspace } from "../session";

export const searchCommand = new Command("search")
  .description("Search the codebase")
  .argument("<query>", "Search query")
  .option("--repo <path>", "Repository path", process.cwd())
  .option("--session <id>", "Session ID", "default")
  .option("--limit <n>", "Max results", "20")
  .option("--lang <language>", "Filter by language")
  .option("--path <glob>", "Filter by path")
  .option("--json", "Output as JSON")
  .action(
    async (
      query: string,
      opts: { repo: string; session: string; limit: string; lang?: string; path?: string; json?: boolean },
    ) => {
      const repoPath = path.resolve(opts.repo);
      const workspace = openWorkspace(repoPath);
      const db = openSession(repoPath, { session: opts.session, workspace });
      try {
      const limit = Number.parseInt(opts.limit, 10);
      const results = hybridSearch(db, query, {
        limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
        languages: opts.lang ? [opts.lang] : undefined,
        paths: opts.path ? [opts.path] : undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      for (const r of results) {
        process.stdout.write(
          `\n  ${accent(r.path)}:${String(r.startLine)}-${String(r.endLine)} ${muted(`(score: ${r.score.toFixed(2)})`)}\n`,
        );
        process.stdout.write(`  ${muted("─".repeat(40))}\n`);
        const lines = r.chunkText.split("\n");
        for (const line of lines.slice(0, 8)) {
          process.stdout.write(`  ${line}\n`);
        }
        if (lines.length > 8) process.stdout.write(`${muted("  ...")}\n`);
      }
      if (results.length === 0) process.stdout.write(`${muted("  No results.")}\n`);
      } catch (e) {
        printError(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      } finally {
        try { closeWorkspaceDB(workspace); } catch { /* best effort */ }
      }
    },
  );
