/**
 * Report + overview rendering for the persistent-theme benchmark (VIB-1833).
 *
 * Aggregates per-(model, page) records into per-model KPI rollups and renders
 * `OVERVIEW.md` — a brand-compliant generation overview built to drop into the
 * README / docs. Prose follows the vibeSpot brand cheatsheet: direct, verbs
 * lead, honest about limits, no buzzwords. The screenshots / saved themes carry
 * the fidelity comparison; the tables carry the Langfuse KPIs.
 */

export interface BenchRecord {
  modelLabel: string;
  engine: string;
  model: string;
  modelSlug: string;
  itemId: string;
  itemTitle: string;
  accuracy: number;
  validatorPassRate: number;
  cleanRate: number;
  coverage: number;
  judge: number | null;
  costUsd: number;
  hasUnpricedCalls: boolean;
  latencyMs: number;
  moduleCount: number;
  failed: number;
  artifactDir: string;
  /** Langfuse trace id for this generation (look it up in the Langfuse UI). */
  traceId?: string;
  /** Langfuse session id for this generation (groups the trace's spans). */
  sessionId?: string;
  error?: string;
}

export interface BenchmarkReport {
  generatedAt: string;
  runStamp: string;
  mode: "real" | "mock";
  judge: { enabled: boolean; model?: string };
  pages: { id: string; title: string; brief?: string }[];
  models: { label: string; engine: string; model: string; slug: string }[];
  records: BenchRecord[];
  notes: string[];
  /** True only if PNGs were actually captured this run. */
  screenshotsAvailable: boolean;
}

interface ModelAggregate {
  label: string;
  engine: string;
  model: string;
  slug: string;
  pages: number;
  meanAccuracy: number;
  meanValidatorPassRate: number;
  meanCoverage: number;
  meanJudge: number | null;
  totalCostUsd: number;
  meanCostPerPageUsd: number;
  meanLatencyMs: number;
  hasUnpricedCalls: boolean;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const usd = (n: number): string => `$${n.toFixed(4)}`;
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function aggregateByModel(report: BenchmarkReport): ModelAggregate[] {
  const out: ModelAggregate[] = [];
  for (const m of report.models) {
    const recs = report.records.filter((r) => r.modelSlug === m.slug && !r.error);
    const judged = recs.filter((r) => r.judge != null);
    out.push({
      label: m.label,
      engine: m.engine,
      model: m.model,
      slug: m.slug,
      pages: recs.length,
      meanAccuracy: mean(recs.map((r) => r.accuracy)),
      meanValidatorPassRate: mean(recs.map((r) => r.validatorPassRate)),
      meanCoverage: mean(recs.map((r) => r.coverage)),
      meanJudge: judged.length ? mean(judged.map((r) => r.judge!)) : null,
      totalCostUsd: recs.reduce((a, r) => a + r.costUsd, 0),
      meanCostPerPageUsd: mean(recs.map((r) => r.costUsd)),
      meanLatencyMs: mean(recs.map((r) => r.latencyMs)),
      hasUnpricedCalls: recs.some((r) => r.hasUnpricedCalls),
    });
  }
  out.sort((a, b) => b.meanAccuracy - a.meanAccuracy);
  return out;
}

export function renderOverview(report: BenchmarkReport): string {
  const agg = aggregateByModel(report);
  const lines: string[] = [];

  lines.push(`# vibeSpot — model generation overview`);
  lines.push("");
  lines.push(
    `Same brief, five models, every theme saved. Each model below generated the same landing-page brief through the vibeSpot pipeline. We kept the themes so you can open them and judge the build yourself, and we tracked the Langfuse KPIs — accuracy, cost, and latency — so the trade-offs are on the table.`,
  );
  lines.push("");
  lines.push(
    `_Generated ${report.generatedAt} · run \`${report.runStamp}\` · mode: **${report.mode}** · ${report.pages.length} page(s) × ${report.models.length} model(s) · judge: ${report.judge.enabled ? `\`${report.judge.model}\`` : "disabled"}._`,
  );
  lines.push("");
  if (report.mode === "mock") {
    lines.push(
      `> **Mock run — numbers are simulated, not real model output.** This proves the benchmark end to end (generate → persist theme → render → screenshot → KPIs) offline. Re-run with provider keys for real figures.`,
    );
    lines.push("");
  }

  // --- KPI summary --------------------------------------------------------
  lines.push(`## Langfuse KPIs (ranked by accuracy)`);
  lines.push("");
  lines.push(`| Rank | Model | Engine | Accuracy | Validator | Coverage | Judge | Cost/page | Latency/page | Total cost |`);
  lines.push(`|------|-------|--------|----------|-----------|----------|-------|-----------|--------------|------------|`);
  agg.forEach((m, i) => {
    lines.push(
      `| ${i + 1} | **${m.label}** | \`${m.engine}:${m.model}\` | ${pct(m.meanAccuracy)} | ${pct(m.meanValidatorPassRate)} | ${pct(m.meanCoverage)} | ${m.meanJudge == null ? "—" : pct(m.meanJudge)} | ${usd(m.meanCostPerPageUsd)}${m.hasUnpricedCalls ? "*" : ""} | ${secs(m.meanLatencyMs)} | ${usd(m.totalCostUsd)} |`,
    );
  });
  lines.push("");
  if (agg.some((m) => m.hasUnpricedCalls)) {
    lines.push(`\\* cost under-counts — a model is missing from the price table in \`src/server/pricing.ts\`.`);
    lines.push("");
  }

  // --- Fidelity gallery ----------------------------------------------------
  lines.push(`## Fidelity — saved themes`);
  lines.push("");
  lines.push(
    `Every generation is saved under \`${report.runStamp}/<model>/<page>/\`: the importable theme (\`theme/\`), a standalone full-page render (\`page.html\`)${report.screenshotsAvailable ? ", and a full-page screenshot (`page.png`)" : ""}, plus per-page KPIs (\`metrics.json\`). Open them side by side to compare fidelity.`,
  );
  lines.push("");
  for (const page of report.pages) {
    lines.push(`### ${page.title}`);
    lines.push("");
    lines.push(`**Prompt** (\`${page.id}\`):`);
    lines.push("");
    lines.push(`> ${page.brief ?? page.id}`);
    lines.push("");
    if (report.screenshotsAvailable) {
      // Thumbnail row of screenshots.
      const cols = agg.map((m) => `[![${m.label}](./${m.slug}/${page.id}/page.png)](./${m.slug}/${page.id}/page.html)`);
      lines.push(`| ${agg.map((m) => m.label).join(" | ")} |`);
      lines.push(`|${agg.map(() => "---").join("|")}|`);
      lines.push(`| ${cols.join(" | ")} |`);
    } else {
      lines.push(`_Screenshots not captured this run — open the saved render instead:_`);
      lines.push("");
      for (const m of agg) lines.push(`- **${m.label}** — [\`page.html\`](./${m.slug}/${page.id}/page.html) · [\`theme/\`](./${m.slug}/${page.id}/theme/)`);
    }
    lines.push("");
    // Per-page KPI rows so fidelity + numbers sit together.
    lines.push(`| Model | Accuracy | Validator | Coverage | Judge | Cost | Latency | Modules | Langfuse trace |`);
    lines.push(`|-------|----------|-----------|----------|-------|------|---------|---------|----------------|`);
    for (const m of agg) {
      const r = report.records.find((x) => x.modelSlug === m.slug && x.itemId === page.id);
      if (!r) continue;
      const note = r.error ? ` (error: ${r.error})` : "";
      const trace = r.traceId ? `\`${r.traceId}\`` : "—";
      lines.push(
        `| ${m.label}${note} | ${pct(r.accuracy)} | ${pct(r.validatorPassRate)} | ${pct(r.coverage)} | ${r.judge == null ? "—" : pct(r.judge)} | ${usd(r.costUsd)} | ${secs(r.latencyMs)} | ${r.moduleCount} | ${trace} |`,
      );
    }
    lines.push("");
  }

  // --- Method + limits (honest) -------------------------------------------
  lines.push(`## How this was measured`);
  lines.push("");
  lines.push(`- **Accuracy** = 0.40·validator-pass-rate + 0.20·coverage + 0.40·judge (0.65 / 0.35 without a judge).`);
  lines.push(`- **Validator**: share of raw modules (pre auto-fix) with no unfixable issues, via the shipped \`stages/validator.ts\`.`);
  lines.push(`- **Coverage**: share of the brief's expected sections present in the output.`);
  lines.push(`- **Judge**: LLM-as-judge over brief-coverage / layout / content / HubSpot-correctness on the shipped page.`);
  lines.push(`- **Cost**: every model call's estimated USD via the shipped \`computeCost\`, captured through the \`onModelUsage\` hook. Judge cost excluded.`);
  lines.push(`- **Latency**: end-to-end pipeline wall-clock per page.`);
  lines.push(`- **Fidelity**: judge it yourself from the saved themes and renders. Numbers rank correctness and cost; they do not rank taste.`);
  lines.push(`- **Langfuse**: every generation is a trace (id in the per-page tables). Dataset \`vibespot-module-eval\`; each generation's session is \`eval-<model>-<page>\` — open it in Langfuse to see the per-stage spans, token usage, and cost roll-up.`);
  lines.push("");

  if (report.notes.length) {
    lines.push(`## Notes`);
    lines.push("");
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push("");
  }

  return lines.join("\n");
}
