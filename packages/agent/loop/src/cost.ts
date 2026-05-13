import type { TokenUsage } from "./types";

interface ModelRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok: number;
}

const TABLE: Record<string, ModelRates> = {
  // Claude 4 family
  "claude-sonnet-4-20250514": { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  "claude-opus-4-20250514": { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 },
  // Claude 3.5 family
  "claude-3-5-sonnet-20241022": { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  "claude-3-5-haiku-20241022": { inputPerMTok: 0.8, outputPerMTok: 4, cachedInputPerMTok: 0.08 },
  "claude-haiku-3-5-20241022": { inputPerMTok: 0.8, outputPerMTok: 4, cachedInputPerMTok: 0.08 },
  // Claude 3 family
  "claude-3-opus-20240229": { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 },
  "claude-3-sonnet-20240229": { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  "claude-3-haiku-20240307": { inputPerMTok: 0.25, outputPerMTok: 1.25, cachedInputPerMTok: 0.03 },
};

const PREFIX_RATES: [string, ModelRates][] = [
  ["claude-opus-4", { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 }],
  ["claude-sonnet-4", { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }],
  ["claude-3-5-sonnet", { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }],
  ["claude-3-5-haiku", { inputPerMTok: 0.8, outputPerMTok: 4, cachedInputPerMTok: 0.08 }],
  ["claude-3-opus", { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 }],
  ["claude-3-sonnet", { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }],
  ["claude-3-haiku", { inputPerMTok: 0.25, outputPerMTok: 1.25, cachedInputPerMTok: 0.03 }],
];

const DEFAULT_RATES: ModelRates = { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 };

const warnedModels = new Set<string>();

function ratesFor(model: string): ModelRates {
  const exact = TABLE[model];
  if (exact) return exact;

  for (const [prefix, rates] of PREFIX_RATES) {
    if (model.startsWith(prefix)) return rates;
  }

  if (!warnedModels.has(model)) {
    warnedModels.add(model);
    console.warn(`[agent-loop] Unknown model "${model}" for cost calculation, using default Sonnet rates`);
  }
  return DEFAULT_RATES;
}

/**
 * Estimate USD cost from token usage using published list prices (per million tokens).
 *
 * Anthropic's `input_tokens` includes cache-read tokens in the total count,
 * so we subtract cached tokens from the input total before applying the full
 * input rate, then add them back at the discounted cached rate.
 */
export function calculateCost(model: string, usage: TokenUsage): number {
  const r = ratesFor(model);
  const cached = usage.cacheReadInputTokens ?? 0;
  const nonCachedInput = usage.inputTokens - cached;
  return (
    (nonCachedInput * r.inputPerMTok + usage.outputTokens * r.outputPerMTok + cached * r.cachedInputPerMTok) /
    1_000_000
  );
}
