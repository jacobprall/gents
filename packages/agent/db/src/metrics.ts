import { sqlError } from "./errors";
import type { AgentDB, SessionMetrics, TurnMetrics } from "./types";

export function recordTurnMetrics(db: AgentDB, metrics: TurnMetrics): void {
  const createdAt = Date.now();
  const sid = db.activeSessionId ?? null;
  try {
    db.db
      .prepare(
        `INSERT OR REPLACE INTO metrics (turn, model, input_tokens, output_tokens, cached_input_tokens, cost_usd, tool_calls, elapsed_ms, session_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        metrics.turn,
        metrics.model ?? null,
        metrics.inputTokens,
        metrics.outputTokens,
        metrics.cachedInputTokens ?? 0,
        metrics.costUsd,
        metrics.toolCalls ?? 0,
        metrics.elapsedMs ?? null,
        sid,
        createdAt,
      );
  } catch (e) {
    throw sqlError("recordTurnMetrics", e);
  }
}

export function getSessionMetrics(db: AgentDB, sessionId?: string): SessionMetrics {
  const sid = sessionId ?? db.activeSessionId ?? null;
  try {
    let row: {
      total_turns: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost_usd: number;
      total_tool_calls: number;
    };
    if (sid) {
      row = db.db
        .prepare(
          `SELECT
             COUNT(*) AS total_turns,
             COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
             COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
             COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
             COALESCE(SUM(tool_calls), 0) AS total_tool_calls
           FROM metrics WHERE session_id = ?`,
        )
        .get(sid) as typeof row;
    } else {
      row = db.db
        .prepare(
          `SELECT
             COUNT(*) AS total_turns,
             COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
             COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
             COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
             COALESCE(SUM(tool_calls), 0) AS total_tool_calls
           FROM metrics`,
        )
        .get() as typeof row;
    }
    return {
      totalTurns: Number(row.total_turns),
      totalInputTokens: Number(row.total_input_tokens),
      totalOutputTokens: Number(row.total_output_tokens),
      totalCostUsd: Number(row.total_cost_usd),
      totalToolCalls: Number(row.total_tool_calls),
    };
  } catch (e) {
    throw sqlError("getSessionMetrics", e);
  }
}
