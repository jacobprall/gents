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
import { recordCost, recordTokenUsage } from "@gents/agent-otel";
import type { ToolContext } from "@gents/agent-tools";
import { streamCompletion } from "./anthropic";
import { calculateCost } from "./cost";
import {
  executeToolsParallel,
  executeToolsSequential,
  type ToolExecutorConfig,
} from "./tool-executor";
import {
  CostLimitError,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOOL_OUTPUT_BYTES,
  HookRejectionError,
  LoopError,
  type AgentLoop,
  type AssistantMessage,
  type LoopConfig,
  type LoopEvent,
  type ToolCallInfo,
} from "./types";

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

function makeHookCtx(base: {
  sessionCostUsd: number;
  turnCostUsd: number;
  turn: number;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
}): HookContext {
  return {
    sessionCostUsd: base.sessionCostUsd,
    turnCostUsd: base.turnCostUsd,
    turnNumber: base.turn,
    model: base.model,
    tokensIn: base.tokensIn ?? 0,
    tokensOut: base.tokensOut ?? 0,
  };
}

function extractTransformed(result: { action: string; transformed?: unknown }): string | undefined {
  if (result.action === "continue" && "transformed" in result && typeof result.transformed === "string") {
    return result.transformed;
  }
  return undefined;
}

export function createAgentLoop(config: LoopConfig): AgentLoop {
  const workingDir = config.workingDir ?? config.repoPath;
  const maxIter = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxToolOutput = config.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES;

  const client = new Anthropic({ apiKey: config.apiKey });

  const notify = (e: LoopEvent): LoopEvent => {
    config.onEvent?.(e);
    return e;
  };

  const toolExecConfig: ToolExecutorConfig = {
    hooks: config.hooks,
    tools: config.tools,
    maxToolOutputBytes: maxToolOutput,
    signal: config.signal,
    onEvent: notify,
  };

  async function* runAfterUserMessage(db: AgentDB, turn: number): AsyncGenerator<LoopEvent> {
    let sessionCostUsd = getSessionMetrics(db).totalCostUsd;
    let turnCostUsd = 0;
    let iteration = 0;

    while (iteration < maxIter) {
      iteration++;

      if (config.signal?.aborted) {
        yield notify({ type: "error", error: new LoopError("Aborted", "aborted") });
        return;
      }

      let assembled;
      try {
        assembled = await config.ctx.assemble(db, { currentTurn: turn });
      } catch (e) {
        yield notify({
          type: "error",
          error: new LoopError(
            `Context assembly failed: ${e instanceof Error ? e.message : String(e)}`,
            "context_assembly_error",
          ),
        });
        return;
      }

      if (config.maxCostPerSession != null && sessionCostUsd >= config.maxCostPerSession) {
        const err = new CostLimitError(
          `Session cost $${sessionCostUsd.toFixed(6)} already at/above maxCostPerSession ($${config.maxCostPerSession})`,
          "session",
          sessionCostUsd,
          config.maxCostPerSession,
        );
        yield notify({ type: "paused", reason: err.message });
        appendEvent(db, { type: "turn.paused", payload: { reason: err.message }, turn });
        return;
      }

      const preHookCtx = makeHookCtx({ sessionCostUsd, turnCostUsd, turn, model: config.model });
      const preResult = await config.hooks.runPreLLM(preHookCtx);
      if (preResult.action === "reject") {
        yield notify({
          type: "error",
          error: new HookRejectionError(`Pre-LLM hook rejected: ${preResult.reason}`, "pre_llm", preResult.reason),
        });
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
          maxTokens: config.maxTokens,
          signal: config.signal,
        })) {
          if (event.type === "text_delta") {
            yield notify({ type: "llm.streaming", delta: event.text });
          } else if (event.type === "complete") {
            assistantMsg = event.message;
            usage = event.usage;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        yield notify({ type: "error", error: new LoopError(`LLM API error: ${msg}`, "llm_api_error") });
        return;
      }

      if (!assistantMsg || !usage) {
        yield notify({ type: "error", error: new LoopError("LLM returned no response", "llm_empty_response") });
        return;
      }

      const iterationCost = calculateCost(config.model, usage);
      turnCostUsd += iterationCost;
      sessionCostUsd += iterationCost;

      if (config.maxCostPerTurn != null && turnCostUsd >= config.maxCostPerTurn) {
        const err = new CostLimitError(
          `Turn cost $${turnCostUsd.toFixed(6)} exceeds maxCostPerTurn ($${config.maxCostPerTurn})`,
          "turn",
          turnCostUsd,
          config.maxCostPerTurn,
        );
        yield notify({ type: "paused", reason: err.message });
        appendEvent(db, { type: "turn.paused", payload: { reason: err.message }, turn });
        return;
      }
      if (config.maxCostPerSession != null && sessionCostUsd >= config.maxCostPerSession) {
        const err = new CostLimitError(
          `Session cost $${sessionCostUsd.toFixed(6)} exceeds maxCostPerSession ($${config.maxCostPerSession})`,
          "session",
          sessionCostUsd,
          config.maxCostPerSession,
        );
        yield notify({ type: "paused", reason: err.message });
        appendEvent(db, { type: "turn.paused", payload: { reason: err.message }, turn });
        return;
      }

      recordTurnMetrics(db, {
        turn,
        model: config.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cacheReadInputTokens ?? 0,
        costUsd: iterationCost,
        toolCalls: assistantMsg.toolCalls.length,
      });

      appendEvent(db, {
        type: "cost.recorded",
        payload: {
          model: config.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: iterationCost,
        },
        turn,
      });

      yield notify({ type: "llm.complete", message: assistantMsg, usage });

      recordTokenUsage(config.model, usage.inputTokens, usage.outputTokens);
      recordCost(config.model, iterationCost);

      const postHookCtx = makeHookCtx({
        sessionCostUsd,
        turnCostUsd,
        turn,
        model: config.model,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
      });

      const postResult = await config.hooks.runPostLLM(postHookCtx, assistantMsg.content ?? "");
      if (postResult.action === "reject") {
        yield notify({
          type: "error",
          error: new HookRejectionError(`Post-LLM hook rejected: ${postResult.reason}`, "post_llm", postResult.reason),
        });
        return;
      }
      if (postResult.action === "pause") {
        yield notify({ type: "paused", reason: postResult.reason });
        appendEvent(db, { type: "turn.paused", payload: { reason: postResult.reason }, turn });
        return;
      }

      const assistantText = extractTransformed(postResult) ?? assistantMsg.content;

      if (assistantMsg.toolCalls.length > 0) {
        appendMessage(db, {
          turn,
          role: "assistant",
          content: assistantText ?? undefined,
          toolCalls: serializeToolCalls(assistantMsg.toolCalls),
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          costUsd: iterationCost,
        });

        const toolContext: ToolContext = {
          db,
          repoPath: config.repoPath,
          workingDir,
          signal: config.signal,
        };

        if (config.parallelToolExecution && assistantMsg.toolCalls.length > 1) {
          yield* executeToolsParallel(toolExecConfig, db, turn, assistantMsg.toolCalls, toolContext, postHookCtx);
        } else {
          yield* executeToolsSequential(toolExecConfig, db, turn, assistantMsg.toolCalls, toolContext, postHookCtx);
        }

        continue;
      }

      appendMessage(db, {
        turn,
        role: "assistant",
        content: assistantText ?? undefined,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costUsd: iterationCost,
      });

      appendEvent(db, { type: "turn.complete", payload: { costUsd: turnCostUsd }, turn });

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
      error: new LoopError(`Max iterations (${maxIter}) reached`, "max_iterations"),
    });
  }

  async function* run(db: AgentDB, userMessage: string): AsyncGenerator<LoopEvent> {
    try {
      const turn = getCurrentTurn(db) + 1;
      appendMessage(db, { turn, role: "user", content: userMessage });
      appendEvent(db, { type: "turn.started", payload: {}, turn });
      yield notify({ type: "turn.started", turn });

      yield* runAfterUserMessage(db, turn);
    } catch (e) {
      yield notify({
        type: "error",
        error: e instanceof LoopError ? e : new LoopError(e instanceof Error ? e.message : String(e), "llm_api_error"),
      });
    }
  }

  async function* step(db: AgentDB): AsyncGenerator<LoopEvent> {
    try {
      const turn = getCurrentTurn(db);
      if (turn === 0) {
        yield notify({ type: "error", error: new LoopError("No conversation to step", "no_conversation") });
        return;
      }
      yield* runAfterUserMessage(db, turn);
    } catch (e) {
      yield notify({
        type: "error",
        error: e instanceof LoopError ? e : new LoopError(e instanceof Error ? e.message : String(e), "llm_api_error"),
      });
    }
  }

  async function* resume(db: AgentDB): AsyncGenerator<LoopEvent> {
    try {
      const last = getLastEvent(db);
      if (last?.type === "turn.complete") return;
      yield* step(db);
    } catch (e) {
      yield notify({
        type: "error",
        error: e instanceof LoopError ? e : new LoopError(e instanceof Error ? e.message : String(e), "llm_api_error"),
      });
    }
  }

  return { run, step, resume };
}
