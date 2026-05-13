import { closeWorkspaceDB } from "@gents/agent-db";
import { createMCPServer } from "@gents/agent-mcp";
import { Command } from "commander";
import * as path from "node:path";

import { printError } from "../display";
import { openSession, openWorkspace } from "../session";

export const mcpCommand = new Command("mcp")
  .description("Start MCP server for IDE integration")
  .option("--repo <path>", "Repository path", process.cwd())
  .option("--session <id>", "Session ID", "default")
  .action(async (opts: { repo: string; session: string }) => {
    const repoPath = path.resolve(opts.repo);
    const workspace = openWorkspace(repoPath);
    const db = openSession(repoPath, { session: opts.session, workspace });
    const server = createMCPServer(db, { repoPath });
    process.stderr.write(`gents MCP server starting (repo: ${repoPath})\n`);
    try {
      await server.serveStdio();
    } catch (e) {
      printError(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    } finally {
      try { closeWorkspaceDB(workspace); } catch { /* best effort */ }
    }
  });
