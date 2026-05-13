import Anthropic from "@anthropic-ai/sdk";
import {
  appendEvent,
  appendMessage,
  getCurrentTurn,
  getLastEvent,
  getSessionMetrics,
  recordTurnMetrics,
  type AgentDB,
} from "@gents/agent-db";
import type { HookContext } from "@gents/agent-hooks";
import { recordCost, recordTokenUsage, recordToolCall } from "@gents/agent-otel";
import type { ToolContext } from "@gents/agent-tools";
import { streamCompletion } from "./anthropic";
import { calculateCost } from "./cost";
import type { AgentLoop, AssistantMessage, LoopConfig, LoopEvent, ToolCallInfo } from "./types";

function serializeToolCalls(calls: ToolCallInfo[]): string {
  return JSON.stringify(
    calls.map((c) => ({
      type: "tool_use" as const,
      id: c.id,
      name: c.name,
      input: c.input,
    })),
  );
}

export function createAgentLoop(config: LoopConfig): AgentLoop {
  const workingDir = config.workingDir ?? config.repoPath;
  const maxIter = config.maxIterations ?? 25;

  const notify = (e: LoopEvent): LoopEvent => {
    config.onEvent?.(e);
    return e;
  };

  async function* runAfterUserMessage(db: AgentDB, client: Anthropic, turn: number): AsyncGenerator<LoopEvent> {
    let sessionCostUsd = getSessionMetrics(db).totalCostUsd;
    let iteration = 0;

    while (iteration < maxIter) {
      iteration++;

      let assembled;
      try {
        assembled = config.ctx.assemble(db, { currentTurn: turn });
      } catch (e) {
        yield notify({ type: "error", error: e instanceof Error ? e : new Error(String(e)) });
        return;
      }

      const hookCtx: HookContext = {
        sessionCostUsd,
        turnCostUsd: 0,
        turnNumber: turn,
        model: config.model,
        tokensIn: 0,
        tokensOut: 0,
      };

      const preResult = await config.hooks.runPreLLM(hookCtx);
      if (preResult.action === "reject") {
        yield notify({ type: "error", error: new Error(preResult.reason) });
        return;
      }
      if (preResult.action === "pause") {
        yield notify({ type: "paused", reason: preResult.reason });
        appendEvent(db, { type: "turn.paused", payload: { reason: preResult.reason }, turn });
        return;
      }

      let assistantMsg: AssistantMessage | null = null;
      let usage = null;

      try {
        for await (const event of streamCompletion(client, {
          model: config.model,
          system: assembled.system,
          messages: assembled.messages,
          tools: assembled.tools,
        })) {
          if (event.type === "text_delta") {
            yield notify({ type: "llm.streaming", delta: event.text });
          } else if (event.type === "complete") {
            assistantMsg = event.message;
            usage = event.usage;
          }
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        yield notify({ type: "error", error: err });
        return;
      }

      if (!assistantMsg || !usage) {
        yield notify({ type: "error", error: new Error("LLM returned no response") });
        return;
      }

      let turnCostUsd = calculateCost(config.model, usage);
      sessionCostUsd += turnCostUsd;

      if (config.maxCostPerTurn != null && turnCostUsd >= config.maxCostPerTurn) {
        const reason = `Turn cost $${turnCostUsd.toFixed(6)} exceeds maxCostPerTurn ($${config.maxCostPerTurn})`;
        yield notify({ type: "paused", reason });
        appendEvent(db, { type: "turn.paused", payload: { reason }, turn });
        return;
      }
      if (config.maxCostPerSession != null && sessionCostUsd >= config.maxCostPerSession) {
        const reason = `Session cost $${sessionCostUsd.toFixed(6)} exceeds maxCostPerSession ($${config.maxCostPerSession})`;
        yield notify({ type: "paused", reason });
        appendEvent(db, { type: "turn.paused", payload: { reason }, turn });
        return;
      }

      recordTurnMetrics(db, {
        turn,
        model: config.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cacheReadInputTokens ?? 0,
        costUsd: turnCostUsd,
        toolCalls: assistantMsg.toolCalls.length,
      });

      appendEvent(db, {
        type: "cost.recorded",
        payload: {
          model: config.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: turnCostUsd,
        },
        turn,
      });

      yield notify({ type: "llm.complete", message: assistantMsg, usage });

      recordTokenUsage(config.model, usage.inputTokens, usage.outputTokens);
      recordCost(config.model, turnCostUsd);

      hookCtx.turnCostUsd = turnCostUsd;
      hookCtx.sessionCostUsd = sessionCostUsd;
      hookCtx.tokensIn = usage.inputTokens;
      hookCtx.tokensOut = usage.outputTokens;

      const postResult = await config.hooks.runPostLLM(hookCtx, assistantMsg.content ?? "");
      if (postResult.action === "reject") {
        yield notify({ type: "error", error: new Error(postResult.reason) });
        return;
      }
      if (postResult.action === "pause") {
        yield notify({ type: "paused", reason: postResult.reason });
        appendEvent(db, { type: "turn.paused", payload: { reason: postResult.reason }, turn });
        return;
      }

      let assistantText = assistantMsg.content;
      if (postResult.action === "continue" && "transformed" in postResult) {
        assistantText = postResult.transformed as string;
      }

      if (assistantMsg.toolCalls.length > 0) {
        appendMessage(db, {
          turn,
          role: "assistant",
          content: assistantText ?? undefined,
          toolCalls: serializeToolCalls(assistantMsg.toolCalls),
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          costUsd: turnCostUsd,
        });

        const toolContext: ToolContext = {
          db,
          repoPath: config.repoPath,
          workingDir,
        };

        for (const toolCall of assistantMsg.toolCalls) {
          const preToolResult = await config.hooks.runPreTool(hookCtx, toolCall.name, toolCall.input);
          if (preToolResult.action === "pause") {
            yield notify({ type: "paused", reason: preToolResult.reason });
            appendEvent(db, {
              type: "turn.paused",
              payload: { reason: preToolResult.reason },
              turn,
            });
            return;
          }
          if (preToolResult.action === "reject") {
            const errorMsg = `Tool ${toolCall.name} rejected: ${preToolResult.reason}`;
            yield notify({ type: "tool.error", name: toolCall.name, error: errorMsg });
            appendMessage(db, { turn, role: "tool", toolCallId: toolCall.id, content: errorMsg });
            appendEvent(db, {
              type: "tool.failed",
              payload: { tool: toolCall.name, error: errorMsg },
              turn,
            });
            continue;
          }

          yield notify({ type: "tool.calling", name: toolCall.name, input: toolCall.input });
          appendEvent(db, {
            type: "tool.called",
            payload: { tool: toolCall.name, input: toolCall.input },
            turn,
          });

          const startMs = Date.now();
          const output = await config.tools.execute(toolCall.name, toolCall.input, toolContext);
          const durationMs = Date.now() - startMs;

          let finalOutput = output;
          const postToolResult = await config.hooks.runPostTool(hookCtx, toolCall.name, output);
          if (postToolResult.action === "reject") {
            yield notify({
              type: "tool.error",
              name: toolCall.name,
              error: postToolResult.reason,
            });
            appendMessage(db, {
              turn,
              role: "tool",
              toolCallId: toolCall.id,
              content: postToolResult.reason,
            });
            appendEvent(db, {
              type: "tool.failed",
              payload: { tool: toolCall.name, error: postToolResult.reason },
              turn,
            });
            recordToolCall(toolCall.name, durationMs, false);
            continue;
          }
          if (postToolResult.action === "pause") {
            yield notify({ type: "paused", reason: postToolResult.reason });
            appendEvent(db, {
              type: "turn.paused",
              payload: { reason: postToolResult.reason },
              turn,
            });
            return;
          }
          if (postToolResult.action === "continue" && "transformed" in postToolResult) {
            finalOutput = postToolResult.transformed;
          }

          yield notify({ type: "tool.complete", name: toolCall.name, output: finalOutput, durationMs });
          appendMessage(db, {
            turn,
            role: "tool",
            toolCallId: toolCall.id,
            content: finalOutput,
          });
          appendEvent(db, {
            type: "tool.completed",
            payload: { tool: toolCall.name, durationMs },
            turn,
          });
          recordToolCall(toolCall.name, durationMs, true);
        }

        continue;
      }

      appendMessage(db, {
        turn,
        role: "assistant",
        content: assistantText ?? undefined,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costUsd: turnCostUsd,
      });

      appendEvent(db, { type: "turn.completed", payload: { costUsd: turnCostUsd }, turn });

      yield notify({
        type: "turn.complete",
        turn,
        cost: {
          model: config.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cacheReadInputTokens ?? 0,
          costUsd: turnCostUsd,
          turnNumber: turn,
        },
      });

      return;
    }

    yield notify({
      type: "error",
      error: new Error(`Max iterations (${maxIter}) reached`),
    });
  }

  async function* run(db: AgentDB, userMessage: string): AsyncGenerator<LoopEvent> {
    try {
      const turn = getCurrentTurn(db) + 1;
      appendMessage(db, { turn, role: "user", content: userMessage });
      appendEvent(db, { type: "turn.started", payload: {}, turn });
      yield notify({ type: "turn.started", turn });

      const client = new Anthropic({ apiKey: config.apiKey });
      yield* runAfterUserMessage(db, client, turn);
    } catch (e) {
      yield notify({ type: "error", error: e instanceof Error ? e : new Error(String(e)) });
    }
  }

  async function* step(db: AgentDB): AsyncGenerator<LoopEvent> {
    try {
      const turn = getCurrentTurn(db);
      if (turn === 0) {
        yield notify({ type: "error", error: new Error("No conversation to step") });
        return;
      }
      const client = new Anthropic({ apiKey: config.apiKey });
      yield* runAfterUserMessage(db, client, turn);
    } catch (e) {
      yield notify({ type: "error", error: e instanceof Error ? e : new Error(String(e)) });
    }
  }

  async function* resume(db: AgentDB): AsyncGenerator<LoopEvent> {
    const last = getLastEvent(db);
    if (last?.type === "turn.completed") return;
    yield* step(db);
  }

  return { run, step, resume };
}
