/**
 * Per-generation cost tracker (VIB-1770).
 *
 * The Langfuse instrumentation (VIB-1765..1767) already captures token usage
 * and estimated USD cost from every API model call through the single
 * `reportModelUsage` chokepoint. That data was previously only logged
 * (`agent-usage`) and shipped to Langfuse — never surfaced to the user.
 *
 * This module aggregates the per-call usage of one user action (= one page
 * generation) into a single `PageCost`, so the web UI can show "this page
 * cost ~$X / N tokens" after generation completes. It is deliberately
 * INDEPENDENT of Langfuse: cost visibility works in the local-CLI model with
 * no Langfuse keys configured, because `reportModelUsage` always knows usage.
 *
 * Mechanism mirrors `langfuse.ts`: an `AsyncLocalStorage` scope opened around
 * the pipeline run (`runWithCostTracking`) collects every `recordCostSample`
 * made while the pipeline executes — including the parallel module-developer
 * calls, whose ALS context propagates through the concurrency limiter the same
 * way Langfuse spans do. Outside such a scope, `recordCostSample` is a no-op,
 * so the legacy single-call paths that share the chokepoint never accumulate.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { computeCost, type TokenUsage } from "./pricing.js";

/** Aggregated token + USD cost for one page generation. */
export interface PageCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input + output + cacheRead + cacheCreation across all calls. */
  totalTokens: number;
  /** Estimated USD, summed from `computeCost()` over priced calls. */
  costUsd: number;
  /** Model calls with known token usage that contributed. */
  calls: number;
  /**
   * False when at least one usage-bearing call had no price-table match
   * (unknown model) — the USD figure then understates the true cost, so the
   * UI shows it as a lower bound. CLI engines report no usage and never count.
   */
  costComplete: boolean;
}

interface Accumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  calls: number;
  unpricedCalls: number;
}

const store = new AsyncLocalStorage<Accumulator>();

function newAccumulator(): Accumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    calls: 0,
    unpricedCalls: 0,
  };
}

function toPageCost(acc: Accumulator): PageCost {
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheCreationTokens: acc.cacheCreationTokens,
    totalTokens:
      acc.inputTokens +
      acc.outputTokens +
      acc.cacheReadTokens +
      acc.cacheCreationTokens,
    costUsd: acc.costUsd,
    calls: acc.calls,
    costComplete: acc.unpricedCalls === 0,
  };
}

/**
 * Run `fn` inside a cost-tracking scope and return its result plus the
 * aggregated cost of every model call made while it ran. The overhead is a
 * single ALS frame — negligible. Nested scopes are independent: the innermost
 * accumulator wins for samples made within it.
 */
export async function runWithCostTracking<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; cost: PageCost }> {
  const acc = newAccumulator();
  const result = await store.run(acc, fn);
  return { result, cost: toPageCost(acc) };
}

/**
 * Accumulate one model call's usage into the active cost-tracking scope.
 * No-op when called outside `runWithCostTracking` or when usage is unknown
 * (CLI engines). Called from the shared `reportModelUsage` chokepoint, so it
 * sees every API model call the pipeline makes. Never throws.
 */
export function recordCostSample(model: string, usage: TokenUsage | undefined): void {
  if (!usage) return;
  const acc = store.getStore();
  if (!acc) return;

  acc.inputTokens += usage.inputTokens ?? 0;
  acc.outputTokens += usage.outputTokens ?? 0;
  acc.cacheReadTokens += usage.cacheReadTokens ?? 0;
  acc.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
  acc.calls += 1;

  const cost = computeCost(model, usage);
  if (cost) {
    acc.costUsd += cost.total;
  } else {
    acc.unpricedCalls += 1;
  }
}

/** An empty `PageCost` (used as a persistence/default fallback). */
export function emptyPageCost(): PageCost {
  return toPageCost(newAccumulator());
}
