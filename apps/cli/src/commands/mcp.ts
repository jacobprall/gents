import { createMCPServer } from "@gents/agent-mcp";
import { Command } from "commander";
import * as path from "node:path";

import { openSession } from "../session";

export const mcpCommand = new Command("mcp")
  .description("Start MCP server for IDE integration")
  .option("--repo <path>", "Repository path", process.cwd())
  .action(async (opts: { repo: string }) => {
    const repoPath = path.resolve(opts.repo);
    const db = openSession(repoPath);
    const server = createMCPServer(db, { repoPath });
    await server.serveStdio();
  });
