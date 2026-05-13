import { closeWorkspaceDB, getConversation, getEvents } from "@gents/agent-db";
import { Command } from "commander";
import * as path from "node:path";

import { printError, printInfo } from "../display";
import { openSession, openWorkspace } from "../session";

export const inspectCommand = new Command("inspect")
  .description("Inspect the local agent database")
  .option("--repo <path>", "Repository path", process.cwd())
  .option("--session <id>", "Session ID", "default")
  .option("--table <name>", "Dump rows from table (recent first)")
  .option("--events", "List recent timeline events")
  .option("--conversation", "Dump conversation snapshot used for assembly")
  .option("--stats", "Counts for major tables")
  .option("--sql <query>", "Run a read-only SQL SELECT or PRAGMA query")
  .action(
    async (opts: {
      repo: string;
      session: string;
      table?: string;
      events?: boolean;
      conversation?: boolean;
      stats?: boolean;
      sql?: string;
    }) => {
      const repoPath = path.resolve(opts.repo);
      const workspace = openWorkspace(repoPath);
      const db = openSession(repoPath, { session: opts.session, workspace });

      try {
        if (opts.sql) {
          const q = opts.sql.trim();
          const isSelect = /^\s*select\s/i.test(q);
          const isPragma = /^\s*pragma\s/i.test(q);
          if ((!isSelect && !isPragma) || q.includes(";") || (isPragma && q.includes("="))) {
            printError(
              "Only read-only SELECT and PRAGMA queries are allowed via --sql.\n" +
                "  Multi-statement queries (;) and PRAGMA writes (=) are blocked.",
            );
            process.exitCode = 1;
            return;
          }
          try {
            const rows = db.db.prepare(q).all() as unknown[];
            console.log(JSON.stringify(rows, null, 2));
          } catch (e) {
            printError(e instanceof Error ? e.message : String(e));
            process.exitCode = 1;
          }
          return;
        }

        if (opts.table) {
          const name = opts.table.trim();
          if (!/^[\w_]+$/.test(name)) {
            printError("Invalid table name.");
            process.exitCode = 1;
            return;
          }
          try {
            const rows = db.db
              .prepare(`SELECT * FROM "${name}" ORDER BY rowid DESC LIMIT 100`)
              .all() as unknown[];
            console.log(JSON.stringify(rows, null, 2));
          } catch (e) {
            printError(e instanceof Error ? e.message : String(e));
            process.exitCode = 1;
          }
          return;
        }

        if (opts.events) {
          const ev = getEvents(db, { limit: 80 });
          console.log(JSON.stringify(ev, null, 2));
          return;
        }

        if (opts.conversation) {
          const msgs = getConversation(db);
          console.log(JSON.stringify(msgs, null, 2));
          return;
        }

        if (opts.stats) {
          const tables = [
            "events",
            "messages",
            "code_chunks",
            "file_tree",
            "config",
            "metrics",
            "compaction_markers",
            "tools",
            "permissions",
            "exclude_patterns",
          ] as const;
          const counts: Record<string, number> = {};
          for (const t of tables) {
            try {
              const row = db.db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number };
              counts[t] = Number(row.c);
            } catch {
              counts[t] = -1;
            }
          }
          console.log(JSON.stringify(counts, null, 2));
          return;
        }

        printInfo("Usage hints: pass one of --table, --events, --conversation, --stats, or --sql.");
      } finally {
        try { closeWorkspaceDB(workspace); } catch { /* best effort */ }
      }
    },
  );
