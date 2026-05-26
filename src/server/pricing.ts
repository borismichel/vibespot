/**
 * Token usage + cost estimation.
 *
 * The agentic pipeline makes ~3 + N model calls per page (intent → design →
 * planner → N parallel module developers). Every API response carries token
 * usage, but historically we discarded it. This module captures usage in a
 * provider-neutral shape and estimates USD cost from a small price table.
 *
 * The price table is intentionally approximate and best-effort — it powers
 * local cost logging and a per-page rollup. For Langfuse we always send the
 * raw `usageDetails`; we only attach `costDetails` when we have a price match,
 * since Langfuse can otherwise compute cost from its own model definitions.
 *
 * Prices are USD per 1,000,000 tokens. Update as providers change pricing.
 */

/** Provider-neutral token usage captured from a single model call. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Prompt-cache read tokens (Anthropic prompt caching). Billed cheaply. */
  cacheReadTokens?: number;
  /** Prompt-cache creation/write tokens (Anthropic prompt caching). */
  cacheCreationTokens?: number;
}

interface ModelPrice {
  /** Case-insensitive substring matched against the model id. */
  match: string;
  inputPerM: number;
  outputPerM: number;
  /** Defaults to 0.1× input (Anthropic prompt-cache read pricing). */
  cacheReadPerM?: number;
  /** Defaults to 1.25× input (Anthropic 5-minute cache write pricing). */
  cacheWritePerM?: number;
}

// Ordered most-specific-first; the first substring match wins.
const PRICES: ModelPrice[] = [
  // Anthropic
  { match: "claude-opus-4", inputPerM: 15, outputPerM: 75 },
  { match: "claude-sonnet-4", inputPerM: 3, outputPerM: 15 },
  { match: "claude-haiku-4", inputPerM: 1, outputPerM: 5 },
  { match: "claude-3-7-sonnet", inputPerM: 3, outputPerM: 15 },
  { match: "claude-3-5-sonnet", inputPerM: 3, outputPerM: 15 },
  { match: "claude-3-5-haiku", inputPerM: 0.8, outputPerM: 4 },
  { match: "claude-3-opus", inputPerM: 15, outputPerM: 75 },
  // OpenAI
  { match: "gpt-4o-mini", inputPerM: 0.15, outputPerM: 0.6 },
  { match: "gpt-4o", inputPerM: 2.5, outputPerM: 10 },
  { match: "gpt-4.1-nano", inputPerM: 0.1, outputPerM: 0.4 },
  { match: "gpt-4.1-mini", inputPerM: 0.4, outputPerM: 1.6 },
  { match: "gpt-4.1", inputPerM: 2, outputPerM: 8 },
  // Google Gemini
  { match: "gemini-2.5-pro", inputPerM: 1.25, outputPerM: 10 },
  { match: "gemini-2.5-flash", inputPerM: 0.3, outputPerM: 2.5 },
  { match: "gemini-2.0-flash", inputPerM: 0.1, outputPerM: 0.4 },
  { match: "gemini-1.5-pro", inputPerM: 1.25, outputPerM: 5 },
  { match: "gemini-1.5-flash", inputPerM: 0.075, outputPerM: 0.3 },
];

function findPrice(model: string): ModelPrice | undefined {
  const m = (model || "").toLowerCase();
  return PRICES.find((p) => m.includes(p.match));
}

/** USD cost breakdown for a single generation. */
export interface CostDetails {
  input?: number;
  output?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total: number;
}

/**
 * Estimate USD cost for a call. Returns `undefined` when the model is unknown,
 * so callers can omit `costDetails` and let Langfuse infer cost itself.
 */
export function computeCost(model: string, usage: TokenUsage): CostDetails | undefined {
  const price = findPrice(model);
  if (!price) return undefined;

  const cacheReadPerM = price.cacheReadPerM ?? price.inputPerM * 0.1;
  const cacheWritePerM = price.cacheWritePerM ?? price.inputPerM * 1.25;

  // Anthropic reports cache tokens separately from `inputTokens`; OpenAI/Gemini
  // fold everything into input. When cache fields are absent this is a no-op.
  const input = (usage.inputTokens ?? 0) * price.inputPerM;
  const output = (usage.outputTokens ?? 0) * price.outputPerM;
  const cacheRead = (usage.cacheReadTokens ?? 0) * cacheReadPerM;
  const cacheWrite = (usage.cacheCreationTokens ?? 0) * cacheWritePerM;

  const details: CostDetails = {
    total: (input + output + cacheRead + cacheWrite) / 1_000_000,
  };
  if (usage.inputTokens != null) details.input = input / 1_000_000;
  if (usage.outputTokens != null) details.output = output / 1_000_000;
  if (usage.cacheReadTokens) details.cache_read_input_tokens = cacheRead / 1_000_000;
  if (usage.cacheCreationTokens) details.cache_creation_input_tokens = cacheWrite / 1_000_000;
  return details;
}

/** Langfuse `usageDetails` map (token counts per usage type). */
export function toUsageDetails(usage: TokenUsage): Record<string, number> {
  const d: Record<string, number> = {};
  if (usage.inputTokens != null) d.input = usage.inputTokens;
  if (usage.outputTokens != null) d.output = usage.outputTokens;
  if (usage.cacheReadTokens) d.cache_read_input_tokens = usage.cacheReadTokens;
  if (usage.cacheCreationTokens) d.cache_creation_input_tokens = usage.cacheCreationTokens;
  if (usage.totalTokens != null) d.total = usage.totalTokens;
  return d;
}
