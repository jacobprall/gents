import { getIndexStatus, indexCodebase } from "@gents/agent-db";
import { Command } from "commander";
import * as path from "node:path";

import { muted, success, Spinner } from "../display";
import { openSession } from "../session";

export const indexCommand = new Command("index")
  .description("Build or update the code search index")
  .option("--repo <path>", "Repository path", process.cwd())
  .option("--session <id>", "Session ID", "default")
  .option("--force", "Force full re-index")
  .option("--stats", "Show indexing stats")
  .action(async (opts: { repo: string; session: string; force?: boolean; stats?: boolean }) => {
    const repoPath = path.resolve(opts.repo);
    const db = openSession(repoPath, { session: opts.session });

    const spinner = new Spinner();
    spinner.start("Indexing...");
    const result = indexCodebase(db, repoPath, { forceReindex: Boolean(opts.force) });
    spinner.stop();

    process.stdout.write(`  ${success("✔")} Indexed in ${(result.elapsedMs / 1000).toFixed(1)}s\n`);
    process.stdout.write(`  ${muted("files")}    ${String(result.filesScanned)} scanned, ${String(result.filesChanged)} changed\n`);
    process.stdout.write(`  ${muted("chunks")}   ${String(result.chunksCreated)} created\n`);

    if (opts.stats) {
      const status = getIndexStatus(db);
      process.stdout.write(`\n  ${muted("totals")}   ${String(status.totalFiles)} files, ${String(status.totalChunks)} chunks\n`);
      const langs = Object.entries(status.languageBreakdown).sort((a, b) => b[1]! - a[1]!);
      process.stdout.write(`  ${muted("langs")}    ${langs.map(([l, c]) => `${l} (${String(c)})`).join(", ")}\n`);
    }
  });
