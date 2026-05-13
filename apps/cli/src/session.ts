import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { createAgentDB, createWorkspaceDB, DEFAULT_BLUEPRINT, type AgentDB, type WorkspaceDB } from "@gents/agent-db";

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

/**
 * Open the shared workspace index DB. Created once per workspace at
 * `.gents/workspace.sqlite`; all sessions share the same index.
 */
export function openWorkspace(repoPath: string): WorkspaceDB {
  return createWorkspaceDB(repoPath);
}

export function openSession(
  repoPath: string,
  opts?: { session?: string; forceNew?: boolean; workspace?: WorkspaceDB },
): AgentDB {
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
    try {
      unlinkSync(dbPath);
    } catch {
      /* archive exists as safety net if unlink or createAgentDB fails */
    }
  }

  return createAgentDB(dbPath, { repoPath, workspace: opts?.workspace, blueprint: DEFAULT_BLUEPRINT });
}
