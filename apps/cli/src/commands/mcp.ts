import { createMCPServer } from "@gents/agent-mcp";
import { Command } from "commander";
import * as path from "node:path";

import { openSession } from "../session";

export const mcpCommand = new Command("mcp")
  .description("Start MCP server for IDE integration")
  .option("--repo <path>", "Repository path", process.cwd())
  .option("--session <id>", "Session ID", "default")
  .action(async (opts: { repo: string; session: string }) => {
    const repoPath = path.resolve(opts.repo);
    const db = openSession(repoPath, { session: opts.session });
    const server = createMCPServer(db, { repoPath });
    process.stderr.write(`gents MCP server starting (repo: ${repoPath})\n`);
    await server.serveStdio();
  });
