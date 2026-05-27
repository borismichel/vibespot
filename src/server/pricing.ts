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

  // `inputTokens` excludes cached tokens for every engine: Anthropic reports
  // them separately, and the OpenAI/Gemini adapters subtract them out of the
  // prompt count. So input and cache-read never overlap here.
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

// ---------------------------------------------------------------------------
// Provider usage mappers
//
// Each provider reports token usage in its own shape. These map into the
// provider-neutral `TokenUsage` and are the single source of truth reused by
// the agentic engine adapter AND the direct-SDK paths (streaming chat, design
// extraction). Cached-token handling matches VIB-1766: OpenAI/Gemini fold
// cached tokens into the prompt count, so we subtract them out to stop input
// and cache-read from overlapping (Anthropic already reports them separately).
// ---------------------------------------------------------------------------

/** Map an Anthropic SDK `usage` object to provider-neutral `TokenUsage`. */
export function mapAnthropicUsage(u: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
} | undefined | null): TokenUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? undefined,
    cacheCreationTokens: u.cache_creation_input_tokens ?? undefined,
  };
}

/** Map an OpenAI chat-completions `usage` object to provider-neutral `TokenUsage`. */
export function mapOpenAIUsage(u: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
} | undefined | null): TokenUsage | undefined {
  if (!u) return undefined;
  const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
  const promptTokens = u.prompt_tokens;
  return {
    inputTokens:
      promptTokens != null ? Math.max(0, promptTokens - cachedTokens) : undefined,
    outputTokens: u.completion_tokens,
    totalTokens: u.total_tokens,
    cacheReadTokens: cachedTokens || undefined,
  };
}

/** Map a Gemini `usageMetadata` object to provider-neutral `TokenUsage`. */
export function mapGeminiUsage(um: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
} | undefined | null): TokenUsage | undefined {
  if (!um) return undefined;
  const cachedTokens = um.cachedContentTokenCount ?? 0;
  const promptTokens = um.promptTokenCount;
  return {
    inputTokens:
      promptTokens != null ? Math.max(0, promptTokens - cachedTokens) : undefined,
    outputTokens: um.candidatesTokenCount,
    totalTokens: um.totalTokenCount,
    cacheReadTokens: cachedTokens || undefined,
  };
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
