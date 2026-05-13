import type { TokenUsage } from "./types";

interface ModelRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok: number;
}

const TABLE: Record<string, ModelRates> = {
  "claude-sonnet-4-20250514": { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  "claude-haiku-3-5-20241022": { inputPerMTok: 0.8, outputPerMTok: 4, cachedInputPerMTok: 0.08 },
  // Alias for Anthropic model id
  "claude-3-5-haiku-20241022": { inputPerMTok: 0.8, outputPerMTok: 4, cachedInputPerMTok: 0.08 },
};

const DEFAULT_RATES: ModelRates = { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 };

function ratesFor(model: string): ModelRates {
  return TABLE[model] ?? DEFAULT_RATES;
}

/** Estimate USD cost from token usage using published list prices (per million tokens). */
export function calculateCost(model: string, usage: TokenUsage): number {
  const r = ratesFor(model);
  const cached = usage.cacheReadInputTokens ?? 0;
  return (
    (usage.inputTokens * r.inputPerMTok + usage.outputTokens * r.outputPerMTok + cached * r.cachedInputPerMTok) /
    1_000_000
  );
}
