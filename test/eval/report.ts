/**
 * Report aggregation + rendering for the eval harness (VIB-1768).
 *
 * Turns per-(provider, page) records into per-provider aggregates and a
 * human-readable markdown comparison (accuracy + cost + latency), plus a
 * machine-readable JSON artifact.
 */

import type { ValidityScore, CoverageScore, JudgeScore } from "./scoring.js";

export interface RunRecord {
  provider: string;
  engine: string;
  model: string;
  itemId: string;
  itemTitle: string;
  validity: ValidityScore;
  coverage: CoverageScore;
  judge: JudgeScore | null;
  accuracy: number;
  costUsd: number;
  hasUnpricedCalls: boolean;
  latencyMs: number;
  moduleCount: number;
  failed: number;
  error?: string;
}

export interface ProviderAggregate {
  provider: string;
  engine: string;
  model: string;
  pages: number;
  meanAccuracy: number;
  meanValidatorPassRate: number;
  meanCleanRate: number;
  meanCoverage: number;
  meanJudge: number | null;
  totalCostUsd: number;
  meanCostPerPageUsd: number;
  hasUnpricedCalls: boolean;
  meanLatencyMs: number;
  totalModules: number;
  totalFailed: number;
}

export interface EvalReport {
  generatedAt: string;
  mode: "real" | "mock";
  datasetSize: number;
  judge: { enabled: boolean; provider?: string; model?: string };
  providers: ProviderAggregate[];
  records: RunRecord[];
  notes: string[];
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export function aggregate(records: RunRecord[]): ProviderAggregate[] {
  const byProvider = new Map<string, RunRecord[]>();
  for (const r of records) {
    const arr = byProvider.get(r.provider) ?? [];
    arr.push(r);
    byProvider.set(r.provider, arr);
  }

  const out: ProviderAggregate[] = [];
  for (const [provider, recs] of byProvider) {
    const judged = recs.filter((r) => r.judge);
    out.push({
      provider,
      engine: recs[0].engine,
      model: recs[0].model,
      pages: recs.length,
      meanAccuracy: mean(recs.map((r) => r.accuracy)),
      meanValidatorPassRate: mean(recs.map((r) => r.validity.passRate)),
      meanCleanRate: mean(recs.map((r) => r.validity.cleanRate)),
      meanCoverage: mean(recs.map((r) => r.coverage.coverage)),
      meanJudge: judged.length ? mean(judged.map((r) => r.judge!.overall)) : null,
      totalCostUsd: recs.reduce((a, r) => a + r.costUsd, 0),
      meanCostPerPageUsd: mean(recs.map((r) => r.costUsd)),
      hasUnpricedCalls: recs.some((r) => r.hasUnpricedCalls),
      meanLatencyMs: mean(recs.map((r) => r.latencyMs)),
      totalModules: recs.reduce((a, r) => a + r.moduleCount, 0),
      totalFailed: recs.reduce((a, r) => a + r.failed, 0),
    });
  }
  // Rank by accuracy descending.
  out.sort((a, b) => b.meanAccuracy - a.meanAccuracy);
  return out;
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const usd = (n: number): string => `$${n.toFixed(4)}`;
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# vibeSpot provider comparison — module generation`);
  lines.push("");
  lines.push(`_Generated ${report.generatedAt} · mode: **${report.mode}** · dataset: ${report.datasetSize} reference pages · judge: ${report.judge.enabled ? `${report.judge.provider} (${report.judge.model})` : "disabled"}_`);
  lines.push("");
  if (report.mode === "mock") {
    lines.push("> ⚠️ **Mock run — numbers are simulated, not real provider output.** This artifact demonstrates the harness end-to-end (scoring → cost → latency → ranking) offline. Re-run with provider API keys for real figures (see `test/eval/README.md`).");
    lines.push("");
  }

  lines.push(`## Summary (ranked by accuracy)`);
  lines.push("");
  lines.push(`| Rank | Provider | Model | Accuracy | Validator pass | Clean first-pass | Coverage | Judge | Cost/page | Total cost | Latency/page |`);
  lines.push(`|------|----------|-------|----------|----------------|------------------|----------|-------|-----------|------------|--------------|`);
  report.providers.forEach((p, i) => {
    lines.push(
      `| ${i + 1} | **${p.provider}** | \`${p.model}\` | ${pct(p.meanAccuracy)} | ${pct(p.meanValidatorPassRate)} | ${pct(p.meanCleanRate)} | ${pct(p.meanCoverage)} | ${p.meanJudge == null ? "—" : pct(p.meanJudge)} | ${usd(p.meanCostPerPageUsd)}${p.hasUnpricedCalls ? "*" : ""} | ${usd(p.totalCostUsd)} | ${secs(p.meanLatencyMs)} |`,
    );
  });
  lines.push("");
  if (report.providers.some((p) => p.hasUnpricedCalls)) {
    lines.push(`\\* cost under-counts — at least one model is missing from the price table in \`src/server/pricing.ts\`.`);
    lines.push("");
  }

  lines.push(`## Methodology`);
  lines.push("");
  lines.push(`- **Accuracy** = 0.40·validator-pass-rate + 0.20·coverage + 0.40·judge (weights without judge: 0.65 / 0.35).`);
  lines.push(`- **Validator pass-rate**: fraction of *raw* generated modules (before the pipeline's auto-fixer) with no *unfixable* issues, via the shipped \`stages/validator.ts\`. For page content most issues are auto-fixable, so this saturates near 100% — **clean first-pass** (modules with zero issues at all) is the stricter discriminator.`);
  lines.push(`- **Coverage**: fraction of the brief's expected sections present in the output.`);
  lines.push(`- **Judge**: LLM-as-judge mean of brief-coverage / layout / content / HubSpot-correctness (1–5 → 0–1) on the shipped page.`);
  lines.push(`- **Cost**: sum of every model call's estimated USD via the shipped \`computeCost\`, captured through the \`onModelUsage\` hook. Judge cost is excluded (eval overhead).`);
  lines.push(`- **Latency**: end-to-end pipeline wall-clock per page.`);
  lines.push("");

  lines.push(`## Per-page detail`);
  lines.push("");
  for (const p of report.providers) {
    lines.push(`### ${p.provider} (\`${p.model}\`)`);
    lines.push("");
    lines.push(`| Page | Accuracy | Validator | Coverage | Judge | Cost | Latency | Modules | Notes |`);
    lines.push(`|------|----------|-----------|----------|-------|------|---------|---------|-------|`);
    for (const r of report.records.filter((r) => r.provider === p.provider)) {
      const note = r.error
        ? `error: ${r.error}`
        : r.validity.unfixableSamples[0] ?? (r.coverage.missing.length ? `missing: ${r.coverage.missing.join(", ")}` : "—");
      lines.push(
        `| ${r.itemId} | ${pct(r.accuracy)} | ${pct(r.validity.passRate)} (${r.validity.cleanModules}/${r.validity.moduleCount} clean) | ${pct(r.coverage.coverage)} | ${r.judge ? pct(r.judge.overall) : "—"} | ${usd(r.costUsd)} | ${secs(r.latencyMs)} | ${r.moduleCount} | ${note} |`,
      );
    }
    lines.push("");
  }

  if (report.notes.length) {
    lines.push(`## Notes`);
    lines.push("");
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push("");
  }

  return lines.join("\n");
}
