import { existsSync, mkdirSync, readdirSync } from "node:fs";
import * as path from "node:path";
import {
  createAgentDB,
  createWorkspaceDB,
  closeAgentDB,
  getConfig,
  DEFAULT_BLUEPRINT,
  type AgentDB,
  type AgentBlueprint,
  type WorkspaceDB,
} from "@gents/agent-db";

export function getGentsDir(repoPath: string): string {
  return path.join(repoPath, ".gents");
}

export function getDbPath(repoPath: string, agentName?: string): string {
  const dir = getGentsDir(repoPath);
  if (!agentName || agentName === "default") {
    return path.join(dir, "default.agent.db");
  }
  return path.join(dir, "agents", `${agentName}.agent.db`);
}

/**
 * Open the shared workspace index DB. Created once per workspace at
 * `.gents/workspace.sqlite`; all sessions share the same index.
 */
export function openWorkspace(repoPath: string): WorkspaceDB {
  return createWorkspaceDB(repoPath);
}

export interface AgentInfo {
  name: string;
  dbPath: string;
  blueprintName: string | null;
  blueprintDescription: string | null;
}

/** List agent DBs that exist on disk for this repo. */
export function listAgents(repoPath: string): AgentInfo[] {
  const gentsDir = getGentsDir(repoPath);
  const results: AgentInfo[] = [];

  const defaultPath = path.join(gentsDir, "default.agent.db");
  if (existsSync(defaultPath)) {
    const info = readAgentInfo("default", defaultPath);
    if (info) results.push(info);
  }

  const agentsDir = path.join(gentsDir, "agents");
  if (existsSync(agentsDir)) {
    try {
      const files = readdirSync(agentsDir).filter((f) => f.endsWith(".agent.db"));
      for (const f of files) {
        const name = f.replace(".agent.db", "");
        const info = readAgentInfo(name, path.join(agentsDir, f));
        if (info) results.push(info);
      }
    } catch { /* skip */ }
  }

  return results;
}

function readAgentInfo(name: string, dbPath: string): AgentInfo | null {
  try {
    const db = createAgentDB(dbPath);
    const blueprintName = getConfig(db, "blueprint_name") ?? null;
    const blueprintDescription = getConfig(db, "blueprint_description") ?? null;
    closeAgentDB(db);
    return { name, dbPath, blueprintName, blueprintDescription };
  } catch {
    return { name, dbPath, blueprintName: null, blueprintDescription: null };
  }
}

export function openAgent(
  repoPath: string,
  opts?: { name?: string; blueprint?: AgentBlueprint; workspace?: WorkspaceDB },
): AgentDB {
  const dbPath = getDbPath(repoPath, opts?.name);
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return createAgentDB(dbPath, {
    repoPath,
    workspace: opts?.workspace,
    blueprint: opts?.blueprint ?? DEFAULT_BLUEPRINT,
  });
}

/** @deprecated Use openAgent instead. Compat shim for other commands. */
export function openSession(
  repoPath: string,
  opts?: { session?: string; forceNew?: boolean; workspace?: WorkspaceDB },
): AgentDB {
  return openAgent(repoPath, {
    name: opts?.session === "default" ? undefined : opts?.session,
    workspace: opts?.workspace,
  });
}
