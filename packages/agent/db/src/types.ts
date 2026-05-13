import type { Database } from "bun:sqlite";

/** Wrapper around Bun’s SQLite handle plus session/extension state. */
export interface AgentDB {
  readonly db: Database;
  /** Repo root used for indexing and relative paths. */
  repoPath: string;
  /** Database file path (empty string for :memory:). */
  dbPath: string;
  /** True when optional native extensions (e.g. sqlite-vector / sqlite-ai) loaded successfully. */
  modelLoaded: boolean;
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

export interface AgentBlueprint {
  name: string;
  tools: ToolDef[];
  permissions: Permission[];
  excludePatterns: string[];
  config: Record<string, string>;
  seedMessages?: NewMessage[];
  systemInstructions?: string;
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
}
