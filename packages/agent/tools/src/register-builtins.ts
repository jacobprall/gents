import type { ToolRegistry } from "./types.js";
import { bashTool } from "./tools/bash.js";
import { codeSearchTool } from "./tools/code-search.js";
import { compactConversationTool } from "./tools/compact-conversation.js";
import { delegateTool } from "./tools/delegate.js";
import { fileEditTool } from "./tools/file-edit.js";
import { fileReadTool } from "./tools/file-read.js";
import { fileSearchTool } from "./tools/file-search.js";
import { fileWriteTool } from "./tools/file-write.js";
import { gitCommitTool, gitDiffTool, gitStatusTool } from "./tools/git.js";
import { readSkillTool } from "./tools/read-skill.js";

/** Registers built-in coding-agent tools on the given registry. */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(fileEditTool);
  registry.register(codeSearchTool);
  registry.register(fileSearchTool);
  registry.register(bashTool);
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitCommitTool);
  registry.register(compactConversationTool);
  registry.register(delegateTool);
  registry.register(readSkillTool);
}
