/**
 * Provider-comparison eval harness — entry point (VIB-1768).
 *
 *   npm run eval                          # offline mock demo (no keys needed)
 *   npm run eval -- --providers=anthropic,openai,gemini
 *   npm run eval -- --providers=anthropic,openai --judge=anthropic --langfuse
 *   npm run eval -- --limit=2 --concurrency=8
 *
 * Compares model providers on vibeSpot module generation across a dataset of
 * reference landing-page briefs, scoring accuracy (rule-based validator pass-
 * rate + structural coverage + LLM-as-judge), cost (shipped `computeCost`), and
 * latency. Writes a markdown comparison + JSON artifact and, with `--langfuse`,
 * registers the run as a Langfuse experiment (dataset + run items + scores).
 *
 * Runs sequentially per (provider, page): the usage hook is process-global, so
 * concurrent pages would cross-attribute cost. Within a page the pipeline still
 * parallelises module development.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EVAL_DATASET } from "./dataset.js";
import { resolveProviders, resolveJudge, type Provider } from "./providers.js";
import {
  makeRealGenerator,
  mockGenerator,
  type PageGenerator,
} from "./generate.js";
import { scoreValidity, scoreCoverage, combineAccuracy } from "./scoring.js";
import { judgePage, mockJudge, type JudgeConfig } from "./judge.js";
import { UsageCollector } from "./usage-collector.js";
import {
  aggregate,
  renderMarkdown,
  type RunRecord,
  type EvalReport,
} from "./report.js";
import {
  syncDataset,
  linkRunItem,
  pushScore,
  isLangfuseDatasetEnabled,
} from "./langfuse-dataset.js";

interface Flags {
  mock: boolean;
  noJudge: boolean;
  langfuse: boolean;
  providers: string[];
  judge?: string;
  out: string;
  limit?: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = {
    mock: false,
    noJudge: false,
    langfuse: false,
    providers: (process.env.EVAL_PROVIDERS || "anthropic,openai,gemini")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    out: resolve("test/eval/output"),
    concurrency: 6,
  };
  for (const arg of argv) {
    if (arg === "--mock") f.mock = true;
    else if (arg === "--no-judge") f.noJudge = true;
    else if (arg === "--langfuse") f.langfuse = true;
    else if (arg.startsWith("--providers=")) f.providers = arg.slice(12).split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith("--judge=")) f.judge = arg.slice(8).trim();
    else if (arg.startsWith("--out=")) f.out = resolve(arg.slice(6));
    else if (arg.startsWith("--limit=")) f.limit = Math.max(1, parseInt(arg.slice(8), 10) || 0);
    else if (arg.startsWith("--concurrency=")) f.concurrency = Math.max(1, parseInt(arg.slice(14), 10) || 6);
  }
  return f;
}

const MOCK_PROVIDERS: Record<string, Provider> = {
  anthropic: { id: "anthropic", engine: "anthropic-api", model: "claude-sonnet-4-20250514", apiKey: "mock" },
  openai: { id: "openai", engine: "openai-api", model: "gpt-4o", apiKey: "mock" },
  gemini: { id: "gemini", engine: "gemini-api", model: "gemini-2.5-flash", apiKey: "mock" },
};

type JudgeFn = (item: (typeof EVAL_DATASET)[number], modules: Parameters<typeof scoreCoverage>[0]) => Promise<ReturnType<typeof mockJudge> | null>;

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  // Langfuse is off by default in the product; `--langfuse` is the operator's
  // explicit opt-in for this run, so enable it for the gated paths.
  if (flags.langfuse) process.env.LANGFUSE_ENABLED = "true";
  const notes: string[] = [];

  // --- Resolve mode + providers -------------------------------------------
  let mode: "real" | "mock";
  let providers: Provider[];
  let generator: PageGenerator;
  let judgeFn: JudgeFn;
  let judgeMeta: EvalReport["judge"] = { enabled: false };

  if (!flags.mock) {
    const { resolved, skipped } = resolveProviders(flags.providers);
    for (const s of skipped) notes.push(`Skipped provider "${s.id}": ${s.reason}.`);
    if (resolved.length >= 1) {
      mode = "real";
      providers = resolved;
      generator = makeRealGenerator(flags.concurrency);
      const judge = flags.noJudge ? null : resolveJudge(flags.judge, resolved);
      if (judge) {
        const jc: JudgeConfig = { engine: judge.engine, apiKey: judge.apiKey, model: judge.model };
        judgeFn = (item, modules) => judgePage(item, modules, jc);
        judgeMeta = { enabled: true, provider: judge.id, model: judge.model };
      } else {
        judgeFn = async () => null;
        notes.push("Judge disabled — accuracy uses rule-based axes only.");
      }
    } else {
      notes.push("No providers had API keys — falling back to offline mock mode.");
      mode = "mock";
      providers = mockProviders(flags.providers);
      generator = mockGenerator;
      judgeFn = async (item, modules) => mockJudge(item, modules);
      judgeMeta = { enabled: true, provider: "mock-heuristic", model: "n/a" };
    }
  } else {
    mode = "mock";
    providers = mockProviders(flags.providers);
    generator = mockGenerator;
    judgeFn = async (item, modules) => mockJudge(item, modules);
    judgeMeta = { enabled: true, provider: "mock-heuristic", model: "n/a" };
  }

  const items = flags.limit ? EVAL_DATASET.slice(0, flags.limit) : EVAL_DATASET;

  console.log(`\n=== vibeSpot provider eval (${mode}) ===`);
  console.log(`Providers: ${providers.map((p) => `${p.id}:${p.model}`).join(", ")}`);
  console.log(`Dataset:   ${items.length} reference pages`);
  console.log(`Judge:     ${judgeMeta.enabled ? `${judgeMeta.provider} ${judgeMeta.model}` : "disabled"}\n`);

  // --- Langfuse experiment setup ------------------------------------------
  const runName = `eval-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const langfuseOn = flags.langfuse && isLangfuseDatasetEnabled();
  if (flags.langfuse && !langfuseOn) {
    notes.push("`--langfuse` requested but Langfuse keys are not configured — dataset sync skipped.");
  }
  if (langfuseOn) {
    const ok = await syncDataset(items);
    console.log(`Langfuse: dataset sync ${ok ? "ok" : "failed (continuing)"} · run "${runName}"`);
  }

  // --- Run ----------------------------------------------------------------
  const records: RunRecord[] = [];
  for (const provider of providers) {
    for (const item of items) {
      process.stdout.write(`• ${provider.id} / ${item.id} … `);
      const collector = new UsageCollector();
      try {
        const page = await collector.collect(() => generator(item, provider));
        const usage = collector.totals();

        const validity = scoreValidity(page.rawModules, `eval-${provider.id}-${item.id}`, item.contentType);
        const coverage = scoreCoverage(page.finalModules, item.expectedModules);
        const judge = await judgeFn(item, page.finalModules);
        const accuracy = combineAccuracy(validity, coverage, judge);

        const record: RunRecord = {
          provider: provider.id,
          engine: provider.engine,
          model: provider.model,
          itemId: item.id,
          itemTitle: item.title,
          validity,
          coverage,
          judge,
          accuracy,
          costUsd: usage.costUsd,
          hasUnpricedCalls: usage.hasUnpricedCalls,
          latencyMs: page.durationMs,
          moduleCount: page.finalModules.length,
          failed: page.failed,
        };
        records.push(record);
        console.log(`acc ${(accuracy * 100).toFixed(0)}% · $${usage.costUsd.toFixed(4)} · ${(page.durationMs / 1000).toFixed(1)}s`);

        if (langfuseOn && page.traceId) {
          await linkRunItem({ runName, itemId: item.id, traceId: page.traceId, metadata: { provider: provider.id } });
          await pushScore({ traceId: page.traceId, name: "accuracy", value: accuracy });
          await pushScore({ traceId: page.traceId, name: "validator_pass_rate", value: validity.passRate });
          await pushScore({ traceId: page.traceId, name: "invalid_css_modules", value: validity.invalidCssModules });
          await pushScore({ traceId: page.traceId, name: "coverage", value: coverage.coverage });
          if (judge) await pushScore({ traceId: page.traceId, name: "judge", value: judge.overall });
          await pushScore({ traceId: page.traceId, name: "cost_usd", value: usage.costUsd });
          await pushScore({ traceId: page.traceId, name: "latency_ms", value: page.durationMs });
        }
      } catch (err) {
        const message = (err as Error).message?.slice(0, 200) ?? String(err);
        console.log(`FAILED: ${message}`);
        records.push({
          provider: provider.id,
          engine: provider.engine,
          model: provider.model,
          itemId: item.id,
          itemTitle: item.title,
          validity: scoreValidity([], "", item.contentType),
          coverage: scoreCoverage([], item.expectedModules),
          judge: null,
          accuracy: 0,
          costUsd: collector.totals().costUsd,
          hasUnpricedCalls: collector.totals().hasUnpricedCalls,
          latencyMs: 0,
          moduleCount: 0,
          failed: 0,
          error: message,
        });
      } finally {
        collector.stop();
      }
    }
  }

  // --- Report -------------------------------------------------------------
  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    mode,
    datasetSize: items.length,
    judge: judgeMeta,
    providers: aggregate(records),
    records,
    notes,
  };

  mkdirSync(flags.out, { recursive: true });
  const md = renderMarkdown(report);
  writeFileSync(join(flags.out, "latest.md"), md);
  writeFileSync(join(flags.out, "latest.json"), JSON.stringify(report, null, 2));
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  writeFileSync(join(flags.out, `eval-${stamp}.md`), md);
  writeFileSync(join(flags.out, `eval-${stamp}.json`), JSON.stringify(report, null, 2));

  console.log(`\n${"-".repeat(60)}`);
  console.log(renderSummaryTable(report));
  console.log(`\nArtifacts: ${join(flags.out, "latest.md")} (+ JSON, timestamped copies)`);
  if (mode === "mock") {
    console.log("NOTE: mock mode — numbers are simulated. Re-run with provider keys for real figures.");
  }
}

function mockProviders(requested: string[]): Provider[] {
  const ids = requested.filter((id) => MOCK_PROVIDERS[id]);
  const chosen = ids.length ? ids : Object.keys(MOCK_PROVIDERS);
  return chosen.map((id) => MOCK_PROVIDERS[id]);
}

function renderSummaryTable(report: EvalReport): string {
  const rows = report.providers.map(
    (p, i) =>
      `${i + 1}. ${p.provider.padEnd(10)} acc ${(p.meanAccuracy * 100).toFixed(0).padStart(3)}%  ` +
      `valid ${(p.meanValidatorPassRate * 100).toFixed(0).padStart(3)}%  ` +
      `clean ${(p.meanCleanRate * 100).toFixed(0).padStart(3)}%  ` +
      `cov ${(p.meanCoverage * 100).toFixed(0).padStart(3)}%  ` +
      `judge ${p.meanJudge == null ? " — " : (p.meanJudge * 100).toFixed(0).padStart(3) + "%"}  ` +
      `$${p.meanCostPerPageUsd.toFixed(4)}/pg  ${(p.meanLatencyMs / 1000).toFixed(1)}s/pg`,
  );
  return ["Ranking (by accuracy):", ...rows].join("\n");
}

main().catch((err) => {
  console.error("eval failed:", err);
  process.exit(1);
});
