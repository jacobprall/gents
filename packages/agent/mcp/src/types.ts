export interface MCPServerConfig {
  /**
   * Subset of tool names to expose.
   * - `undefined`: all tools
   * - `[]`: no tools (explicit empty = locked down)
   * - `["tool1", "tool2"]`: only named tools
   */
  tools?: string[];
  /** Expose MCP resources (default: true). Set `false` to disable all resources. */
  resources?: boolean;
  /**
   * Subset of resource names to expose. Only checked when `resources` is not `false`.
   * - `undefined`: all resources
   * - `[]`: no resources
   * - `["conversation", "events"]`: only named resources
   */
  resourceNames?: string[];
  /** Repo path for tools that need filesystem access. */
  repoPath?: string;
}

/** Handle returned by {@link createMCPServer}. */
export interface MCPServerHandle {
  serveStdio(): Promise<void>;
  close(): Promise<void>;
}
