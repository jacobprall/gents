import {
  appendEvent,
  appendMessage,
  type AgentDB,
} from "@gents/agent-db";
import type { HookContext, HookPipeline } from "@gents/agent-hooks";
import { recordToolCall } from "@gents/agent-otel";
import type { ToolContext, ToolRegistry } from "@gents/agent-tools";
import { LoopError, type LoopEvent, type ToolCallInfo } from "./types";

export interface ToolExecutorConfig {
  hooks: HookPipeline;
  tools: ToolRegistry;
  maxToolOutputBytes: number;
  signal?: AbortSignal;
  onEvent: (e: LoopEvent) => LoopEvent;
}

function truncateOutput(output: string, maxBytes: number): string {
  if (output.length <= maxBytes) return output;
  return output.slice(0, maxBytes) + `\n\n[truncated: output exceeded ${maxBytes} bytes]`;
}

function extractTransformed(result: { action: string; transformed?: unknown }): string | undefined {
  if (result.action === "continue" && "transformed" in result && typeof result.transformed === "string") {
    return result.transformed;
  }
  return undefined;
}

export async function* executeToolsSequential(
  cfg: ToolExecutorConfig,
  db: AgentDB,
  turn: number,
  toolCalls: ToolCallInfo[],
  toolContext: ToolContext,
  hookCtx: HookContext,
): AsyncGenerator<LoopEvent> {
  for (const toolCall of toolCalls) {
    if (cfg.signal?.aborted) {
      yield cfg.onEvent({ type: "error", error: new LoopError("Aborted", "aborted") });
      return;
    }
    const result = yield* executeSingleTool(cfg, db, turn, toolCall, toolContext, hookCtx);
    if (result === "pause") return;
  }
}

export async function* executeToolsParallel(
  cfg: ToolExecutorConfig,
  db: AgentDB,
  turn: number,
  toolCalls: ToolCallInfo[],
  toolContext: ToolContext,
  hookCtx: HookContext,
): AsyncGenerator<LoopEvent> {
  if (cfg.signal?.aborted) {
    yield cfg.onEvent({ type: "error", error: new LoopError("Aborted", "aborted") });
    return;
  }

  const rejectedIds = new Set<string>();
  for (const toolCall of toolCalls) {
    const preToolResult = await cfg.hooks.runPreTool(hookCtx, toolCall.name, toolCall.input);
    if (preToolResult.action === "pause") {
      yield cfg.onEvent({ type: "paused", reason: preToolResult.reason });
      appendEvent(db, { type: "turn.paused", payload: { reason: preToolResult.reason }, turn });
      return;
    }
    if (preToolResult.action === "reject") {
      const errorMsg = `Tool ${toolCall.name} rejected: ${preToolResult.reason}`;
      yield cfg.onEvent({ type: "tool.error", name: toolCall.name, error: errorMsg });
      appendMessage(db, { turn, role: "tool", toolCallId: toolCall.id, content: errorMsg });
      appendEvent(db, { type: "tool.error", payload: { tool: toolCall.name, error: errorMsg }, turn });
      rejectedIds.add(toolCall.id);
    }
  }

  const executableCalls = toolCalls.filter((tc) => !rejectedIds.has(tc.id));
  if (executableCalls.length === 0) return;

  for (const tc of executableCalls) {
    yield cfg.onEvent({ type: "tool.calling", name: tc.name, input: tc.input });
    appendEvent(db, { type: "tool.called", payload: { tool: tc.name, input: tc.input }, turn });
  }

  const results = await Promise.allSettled(
    executableCalls.map(async (toolCall) => {
      const startMs = Date.now();
      const output = await cfg.tools.execute(toolCall.name, toolCall.input, toolContext);
      const durationMs = Date.now() - startMs;
      return { toolCall, output, durationMs };
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      const err = result.reason instanceof Error ? result.reason.message : String(result.reason);
      yield cfg.onEvent({ type: "tool.error", name: "unknown", error: err });
      continue;
    }

    const { toolCall, output, durationMs } = result.value;
    let finalOutput = truncateOutput(output, cfg.maxToolOutputBytes);

    const postToolResult = await cfg.hooks.runPostTool(hookCtx, toolCall.name, finalOutput);
    if (postToolResult.action === "reject") {
      yield cfg.onEvent({ type: "tool.error", name: toolCall.name, error: postToolResult.reason });
      appendMessage(db, { turn, role: "tool", toolCallId: toolCall.id, content: postToolResult.reason });
      appendEvent(db, { type: "tool.error", payload: { tool: toolCall.name, error: postToolResult.reason }, turn });
      recordToolCall(toolCall.name, durationMs, false);
      continue;
    }
    if (postToolResult.action === "pause") {
      yield cfg.onEvent({ type: "paused", reason: postToolResult.reason });
      appendEvent(db, { type: "turn.paused", payload: { reason: postToolResult.reason }, turn });
      return;
    }

    const transformed = extractTransformed(postToolResult);
    if (transformed !== undefined) finalOutput = transformed;

    yield cfg.onEvent({ type: "tool.complete", name: toolCall.name, output: finalOutput, durationMs });
    appendMessage(db, { turn, role: "tool", toolCallId: toolCall.id, content: finalOutput });
    appendEvent(db, { type: "tool.complete", payload: { tool: toolCall.name, durationMs }, turn });
    recordToolCall(toolCall.name, durationMs, true);
  }
}

async function* executeSingleTool(
  cfg: ToolExecutorConfig,
  db: AgentDB,
  turn: number,
  toolCall: ToolCallInfo,
  toolContext: ToolContext,
  hookCtx: HookContext,
): AsyncGenerator<LoopEvent, "pause" | "continue"> {
  const preToolResult = await cfg.hooks.runPreTool(hookCtx, toolCall.name, toolCall.input);
  if (preToolResult.action === "pause") {
    yield cfg.onEvent({ type: "paused", reason: preToolResult.reason });
    appendEvent(db, { type: "turn.paused", payload: { reason: preToolResult.reason }, turn });
    return "pause";
  }
  if (preToolResult.action === "reject") {
    const errorMsg = `Tool ${toolCall.name} rejected: ${preToolResult.reason}`;
    yield cfg.onEvent({ type: "tool.error", name: toolCall.name, error: errorMsg });
    appendMessage(db, { turn, role: "tool", toolCallId: toolCall.id, content: errorMsg });
    appendEvent(db, { type: "tool.error", payload: { tool: toolCall.name, error: errorMsg }, turn });
    return "continue";
  }

  yield cfg.onEvent({ type: "tool.calling", name: toolCall.name, input: toolCall.input });
  appendEvent(db, { type: "tool.called", payload: { tool: toolCall.name, input: toolCall.input }, turn });

  const startMs = Date.now();
  const output = await cfg.tools.execute(toolCall.name, toolCall.input, toolContext);
  const durationMs = Date.now() - startMs;

  let finalOutput = truncateOutput(output, cfg.maxToolOutputBytes);

  const postToolResult = await cfg.hooks.runPostTool(hookCtx, toolCall.name, finalOutput);
  if (postToolResult.action === "reject") {
    yield cfg.onEvent({ type: "tool.error", name: toolCall.name, error: postToolResult.reason });
    appendMessage(db, { turn, role: "tool", toolCallId: toolCall.id, content: postToolResult.reason });
    appendEvent(db, { type: "tool.error", payload: { tool: toolCall.name, error: postToolResult.reason }, turn });
    recordToolCall(toolCall.name, durationMs, false);
    return "continue";
  }
  if (postToolResult.action === "pause") {
    yield cfg.onEvent({ type: "paused", reason: postToolResult.reason });
    appendEvent(db, { type: "turn.paused", payload: { reason: postToolResult.reason }, turn });
    return "pause";
  }

  const transformed = extractTransformed(postToolResult);
  if (transformed !== undefined) finalOutput = transformed;

  yield cfg.onEvent({ type: "tool.complete", name: toolCall.name, output: finalOutput, durationMs });
  appendMessage(db, { turn, role: "tool", toolCallId: toolCall.id, content: finalOutput });
  appendEvent(db, { type: "tool.complete", payload: { tool: toolCall.name, durationMs }, turn });
  recordToolCall(toolCall.name, durationMs, true);
  return "continue";
}
