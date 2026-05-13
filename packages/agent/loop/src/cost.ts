import type { TokenUsage } from "./types";

interface ModelRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok: number;
}

const TABLE: Record<string, ModelRates> = {
  // ── Anthropic Claude 4 ─────────────────────────────────────────────
  "claude-sonnet-4-20250514": { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  "claude-opus-4-20250514": { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 },
  // ── Anthropic Claude 3.5 ───────────────────────────────────────────
  "claude-3-5-sonnet-20241022": { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  "claude-3-5-haiku-20241022": { inputPerMTok: 0.8, outputPerMTok: 4, cachedInputPerMTok: 0.08 },
  "claude-haiku-3-5-20241022": { inputPerMTok: 0.8, outputPerMTok: 4, cachedInputPerMTok: 0.08 },
  // ── Anthropic Claude 3 ─────────────────────────────────────────────
  "claude-3-opus-20240229": { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 },
  "claude-3-sonnet-20240229": { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  "claude-3-haiku-20240307": { inputPerMTok: 0.25, outputPerMTok: 1.25, cachedInputPerMTok: 0.03 },

  // ── OpenAI GPT-4o ──────────────────────────────────────────────────
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10, cachedInputPerMTok: 1.25 },
  "gpt-4o-2024-11-20": { inputPerMTok: 2.5, outputPerMTok: 10, cachedInputPerMTok: 1.25 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.075 },
  "gpt-4o-mini-2024-07-18": { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.075 },
  // ── OpenAI o-series reasoning ──────────────────────────────────────
  "o3": { inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 1 },
  "o3-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4, cachedInputPerMTok: 0.55 },
  "o4-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4, cachedInputPerMTok: 0.55 },
  "o1": { inputPerMTok: 15, outputPerMTok: 60, cachedInputPerMTok: 7.5 },
  "o1-mini": { inputPerMTok: 1.1, outputPerMTok: 4.4, cachedInputPerMTok: 0.55 },

  // ── Google Gemini 2.5 ──────────────────────────────────────────────
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.315 },
  "gemini-2.5-flash": { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.0375 },
  // ── Google Gemini 2.0 ──────────────────────────────────────────────
  "gemini-2.0-flash": { inputPerMTok: 0.1, outputPerMTok: 0.4, cachedInputPerMTok: 0.025 },
  "gemini-2.0-flash-lite": { inputPerMTok: 0.075, outputPerMTok: 0.3, cachedInputPerMTok: 0.018 },
  // ── Google Gemini 1.5 ──────────────────────────────────────────────
  "gemini-1.5-pro": { inputPerMTok: 1.25, outputPerMTok: 5, cachedInputPerMTok: 0.315 },
  "gemini-1.5-flash": { inputPerMTok: 0.075, outputPerMTok: 0.3, cachedInputPerMTok: 0.018 },
};

const PREFIX_RATES: [string, ModelRates][] = [
  // Anthropic
  ["claude-opus-4", { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 }],
  ["claude-sonnet-4", { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }],
  ["claude-3-5-sonnet", { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }],
  ["claude-3-5-haiku", { inputPerMTok: 0.8, outputPerMTok: 4, cachedInputPerMTok: 0.08 }],
  ["claude-3-opus", { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 }],
  ["claude-3-sonnet", { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }],
  ["claude-3-haiku", { inputPerMTok: 0.25, outputPerMTok: 1.25, cachedInputPerMTok: 0.03 }],
  // OpenAI
  ["gpt-4o-mini", { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.075 }],
  ["gpt-4o", { inputPerMTok: 2.5, outputPerMTok: 10, cachedInputPerMTok: 1.25 }],
  ["gpt-4-turbo", { inputPerMTok: 10, outputPerMTok: 30, cachedInputPerMTok: 5 }],
  ["o4-mini", { inputPerMTok: 1.1, outputPerMTok: 4.4, cachedInputPerMTok: 0.55 }],
  ["o3-mini", { inputPerMTok: 1.1, outputPerMTok: 4.4, cachedInputPerMTok: 0.55 }],
  ["o3", { inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 1 }],
  ["o1-mini", { inputPerMTok: 1.1, outputPerMTok: 4.4, cachedInputPerMTok: 0.55 }],
  ["o1", { inputPerMTok: 15, outputPerMTok: 60, cachedInputPerMTok: 7.5 }],
  // Google
  ["gemini-2.5-pro", { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.315 }],
  ["gemini-2.5-flash", { inputPerMTok: 0.15, outputPerMTok: 0.6, cachedInputPerMTok: 0.0375 }],
  ["gemini-2.0-flash", { inputPerMTok: 0.1, outputPerMTok: 0.4, cachedInputPerMTok: 0.025 }],
  ["gemini-1.5-pro", { inputPerMTok: 1.25, outputPerMTok: 5, cachedInputPerMTok: 0.315 }],
  ["gemini-1.5-flash", { inputPerMTok: 0.075, outputPerMTok: 0.3, cachedInputPerMTok: 0.018 }],
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
 * For Anthropic, `input_tokens` includes cache-read tokens in the total count,
 * so we subtract cached tokens from the input total before applying the full
 * input rate, then add them back at the discounted cached rate.
 * For other providers, cachedInputTokens is typically 0.
 */
export function calculateCost(model: string, usage: TokenUsage): number {
  const r = ratesFor(model);
  const cached = usage.cacheReadInputTokens ?? 0;
  const nonCachedInput = Math.max(0, usage.inputTokens - cached);
  return (
    (nonCachedInput * r.inputPerMTok + usage.outputTokens * r.outputPerMTok + cached * r.cachedInputPerMTok) /
    1_000_000
  );
}
