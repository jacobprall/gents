import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { createAgentDB, type AgentDB } from "@gents/agent-db";

export function getGentsDir(repoPath: string): string {
  return path.join(repoPath, ".gents");
}

export function getDbPath(repoPath: string, session?: string): string {
  const dir = getGentsDir(repoPath);
  if (!session || session === "default") {
    return path.join(dir, "default.agent.db");
  }
  return path.join(dir, "sessions", `${session}.agent.db`);
}

export function openSession(repoPath: string, opts?: { session?: string; forceNew?: boolean }): AgentDB {
  const dbPath = getDbPath(repoPath, opts?.session);
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (opts?.forceNew && existsSync(dbPath)) {
    const archiveBase = path.basename(dbPath, ".agent.db");
    const archiveName = `${archiveBase}-${String(Date.now())}.agent.db`;
    const archiveDir = path.join(getGentsDir(repoPath), "archive");
    mkdirSync(archiveDir, { recursive: true });
    copyFileSync(dbPath, path.join(archiveDir, archiveName));
    unlinkSync(dbPath);
  }

  return createAgentDB(dbPath, { repoPath });
}
