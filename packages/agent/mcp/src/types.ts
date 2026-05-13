export interface MCPServerConfig {
  /** Subset of tool names to expose (default: all). */
  tools?: string[];
  /** Expose MCP resources (default: true). */
  resources?: boolean;
  /** Repo path for tools that need filesystem access. */
  repoPath?: string;
}

/** Handle returned by {@link createMCPServer}. */
export interface MCPServerHandle {
  serveStdio(): Promise<void>;
}
