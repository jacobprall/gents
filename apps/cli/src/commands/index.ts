import { getIndexStatus, indexCodebase } from "@gents/agent-db";
import { Command } from "commander";
import * as path from "node:path";

import { printInfo } from "../display";
import { openSession } from "../session";

export const indexCommand = new Command("index")
  .description("Build or update the code search index")
  .option("--repo <path>", "Repository path", process.cwd())
  .option("--force", "Force full re-index")
  .option("--stats", "Show indexing stats")
  .action(async (opts: { repo: string; force?: boolean; stats?: boolean }) => {
    const repoPath = path.resolve(opts.repo);
    const db = openSession(repoPath);

    printInfo(`Indexing ${repoPath}...`);
    const result = indexCodebase(db, repoPath, { forceReindex: Boolean(opts.force) });

    console.log(`  Files scanned: ${String(result.filesScanned)}`);
    console.log(`  Changed: ${String(result.filesChanged)}`);
    console.log(`  Chunks created: ${String(result.chunksCreated)}`);
    console.log(`  Time: ${(result.elapsedMs / 1000).toFixed(1)}s`);

    if (opts.stats) {
      const status = getIndexStatus(db);
      console.log(`\n  Total files: ${String(status.totalFiles)}`);
      console.log(`  Total chunks: ${String(status.totalChunks)}`);
      const langs = Object.entries(status.languageBreakdown).sort((a, b) => b[1]! - a[1]!);
      console.log(`  Languages: ${langs.map(([l, c]) => `${l} (${String(c)})`).join(", ")}`);
    }
  });
