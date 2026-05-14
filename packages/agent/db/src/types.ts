import type { Database } from "bun:sqlite";

/**
 * Shared workspace-level index DB. One per workspace, used by all agent
 * sessions targeting the same directory tree. Contains the file tree,
 * code chunks, FTS index, and exclude patterns.
 */
export interface WorkspaceDB {
  readonly db: Database;
  readonly dbPath: string;
  readonly workspacePath: string;
  readonly modelLoaded: boolean;
  /** Whether the sqlite-sync extension is loaded. */
  readonly syncLoaded?: boolean;
  /** Unique database identity from sqlite-sync's cloudsync_siteid(). */
  readonly siteId?: string;
  vectorAvailable?: boolean;
}

export interface AgentDB {
  readonly db: Database;
  readonly repoPath: string;
  readonly dbPath: string;
  readonly modelLoaded: boolean;
  /** Whether the sqlite-sync extension is loaded (enables CRDT sync and site identity). */
  readonly syncLoaded?: boolean;
  /** Unique database identity from sqlite-sync's cloudsync_siteid(). Stable across sessions, unique per DB. */
  readonly siteId?: string;
  /** Shared workspace index. When set, search/index operations use this DB. */
  readonly workspace?: WorkspaceDB;
  /** Active session ID. Set via setActiveSession(). Scopes messages/events/metrics writes. */
  activeSessionId?: string;
  /** @deprecated Use workspace.vectorAvailable instead when workspace is set. */
  vectorAvailable?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface Permission {
  id: string;
  type: "tool_allow" | "tool_deny" | "path_allow" | "path_deny";
  pattern: string;
}

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  source?: "builtin" | "blueprint" | "user";
}

export interface SubagentDef {
  name: string;
  skill: string;
  description: string;
  allowedTools: string[];
  maxIterations?: number;
  maxCostUsd?: number;
  source?: "builtin" | "blueprint" | "user";
}

export interface AgentBlueprint {
  name: string;
  description?: string;
  tools: ToolDef[];
  permissions: Permission[];
  excludePatterns: string[];
  config: Record<string, string>;
  seedMessages?: NewMessage[];
  systemInstructions?: string;
  skills?: Skill[];
  subagents?: SubagentDef[];
}

export interface Session {
  id: string;
  label: string | null;
  createdAt: number;
  lastActiveAt: number;
  isActive: boolean;
}

export interface SessionSummary {
  id: string;
  label: string | null;
  turns: number;
  costUsd: number;
  lastActiveAt: number;
  createdAt: number;
}

export interface NewMessage {
  turn: number;
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolCalls?: string;
  toolCallId?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export interface Message extends NewMessage {
  id: string;
  createdAt: number;
}

export interface NewEvent {
  type: string;
  payload: Record<string, unknown>;
  turn?: number;
}

export interface Event extends NewEvent {
  id: string;
  createdAt: number;
}

export interface TurnMetrics {
  turn: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd: number;
  toolCalls?: number;
  elapsedMs?: number;
}

export interface SessionMetrics {
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalToolCalls: number;
}

export interface SearchResult {
  path: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  language: string | null;
  chunkText: string;
  score: number;
}

export interface IndexResult {
  filesScanned: number;
  filesChanged: number;
  chunksCreated: number;
  embeddingsGenerated: number;
  elapsedMs: number;
}

export interface IndexStatus {
  totalFiles: number;
  totalChunks: number;
  lastIndexedAt: number | null;
  pendingFiles: number;
  languageBreakdown: Record<string, number>;
}

export interface FileEntry {
  path: string;
  hash: string;
  size: number | null;
  modifiedAt: number | null;
  language: string | null;
  indexedAt: number | null;
}

export interface TreeDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface CreateDBOptions {
  modelPath?: string;
  repoPath?: string;
  blueprint?: AgentBlueprint;
  workspace?: WorkspaceDB;
}

export interface IndexOptions {
  include?: string[];
  exclude?: string[];
  chunkSize?: number;
  chunkOverlap?: number;
  forceReindex?: boolean;
}

export interface SearchOptions {
  limit?: number;
  languages?: string[];
  paths?: string[];
  bm25Weight?: number;
  vectorWeight?: number;
}

export interface ConversationOptions {
  maxTokens?: number;
  fromTurn?: number;
  sessionId?: string;
}
