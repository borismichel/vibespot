/**
 * Usage collector (VIB-1768) — aggregates token cost over a scope of work by
 * subscribing to the `onModelUsage` hook in `src/server/langfuse.ts`. That hook
 * fires for every completed model call routed through `reportModelUsage`
 * (the shared chokepoint), with cost already computed via the shipped
 * `computeCost`. So this reuses production cost accounting verbatim rather than
 * re-deriving prices.
 *
 * Usage: `const c = new UsageCollector(); c.start(); …work…; c.stop();`
 * then read `c.totals()`. `collect()` wraps an async fn for convenience.
 */

import { onModelUsage, type ModelUsageReport } from "../../src/server/langfuse.js";

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Estimated USD; only includes calls whose model matched the price table. */
  costUsd: number;
  /** True if any call had usage but no price-table match (cost under-counts). */
  hasUnpricedCalls: boolean;
  /** Sum of per-call latency (ms). Not the same as wall-clock for parallel calls. */
  totalCallMs: number;
}

export class UsageCollector {
  private unsubscribe: (() => void) | null = null;
  private reports: ModelUsageReport[] = [];

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onModelUsage((r) => this.reports.push(r));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  reset(): void {
    this.reports = [];
  }

  async collect<T>(fn: () => Promise<T>): Promise<T> {
    this.start();
    try {
      return await fn();
    } finally {
      this.stop();
    }
  }

  totals(): UsageTotals {
    const t: UsageTotals = {
      calls: this.reports.length,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      hasUnpricedCalls: false,
      totalCallMs: 0,
    };
    for (const r of this.reports) {
      t.inputTokens += r.usage?.inputTokens ?? 0;
      t.outputTokens += r.usage?.outputTokens ?? 0;
      t.cacheReadTokens += r.usage?.cacheReadTokens ?? 0;
      t.totalCallMs += r.durationMs;
      if (r.cost) t.costUsd += r.cost.total;
      else if (r.usage) t.hasUnpricedCalls = true;
    }
    return t;
  }
}
