/**
 * Persistent-theme benchmark — entry point (VIB-1833).
 *
 *   npm run benchmark                       # offline mock demo (no keys needed)
 *   npm run benchmark -- --models=anthropic-api:claude-haiku-4-5:Haiku 4.5,anthropic-api:claude-sonnet-4-6:Sonnet 4.6,anthropic-api:claude-opus-4-7:Opus 4.7,openai-api:gpt-5.4:GPT 5.4,openai-api:gpt-5.5:GPT 5.5
 *   npm run benchmark -- --models=… --pages=saas-analytics --langfuse
 *   npm run benchmark -- --models=… --no-screenshots
 *
 * Unlike the provider-comparison harness (`run-eval.ts`, VIB-1768) which keeps
 * pages in memory and only emits KPI numbers, this benchmark **persists every
 * generated theme to disk** plus a standalone full-page render — so the same
 * brief can be compared across models on *fidelity* (the saved themes /
 * screenshots) as well as on Langfuse KPIs (accuracy / cost / latency / judge).
 * Output is a `benchmark.json` artifact and a brand-compliant `OVERVIEW.md`
 * ready to drop into the README / docs as a generation overview.
 *
 * A "model" under test is an explicit `engine:model[:label]` triple, so two
 * models from the same provider (e.g. Haiku + Sonnet + Opus, all Anthropic) are
 * first-class — the provider-keyed `--providers` flag in run-eval.ts can't
 * express that.
 *
 * Sequential per (model, page): the usage hook is process-global, so concurrent
 * pages would cross-attribute cost. Within a page the pipeline parallelises.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EVAL_DATASET, type EvalItem } from "./dataset.js";
import { loadConfig, getApiKeyForEngine } from "../../src/utils/config.js";
import type { AgentEngine } from "../../src/server/agent/engine-adapter.js";
import type { Provider } from "./providers.js";
import { makeRealGenerator, mockGenerator, themeNameFor, type PageGenerator } from "./generate.js";
import { scoreValidity, scoreCoverage, combineAccuracy } from "./scoring.js";
import { judgePage, mockJudge, type JudgeConfig } from "./judge.js";
import { UsageCollector } from "./usage-collector.js";
import { persistTheme, slug } from "./persist.js";
import { captureScreenshots, type ShotJob } from "./screenshot.js";
import {
  syncDataset,
  linkRunItem,
  pushScore,
  isLangfuseDatasetEnabled,
} from "./langfuse-dataset.js";
import { renderOverview, type BenchmarkReport, type BenchRecord } from "./benchmark-report.js";

interface BenchModel extends Provider {
  /** Human-readable display name for tables / galleries. */
  label: string;
  /** Filesystem-safe directory name. */
  slug: string;
}

interface Flags {
  mock: boolean;
  noJudge: boolean;
  noScreenshots: boolean;
  langfuse: boolean;
  models: string[];
  pages?: string[];
  judge?: string;
  out: string;
  concurrency: number;
}

/** Map an engine to the key-lookup engine + a mock quality tier id. */
const ENGINE_KEY: Record<string, Parameters<typeof getApiKeyForEngine>[0]> = {
  "anthropic-api": "anthropic-api",
  "openai-api": "openai-api",
  "gemini-api": "gemini-api",
  "langdock-api": "langdock-api",
};

function parseArgs(argv: string[]): Flags {
  const f: Flags = {
    mock: false,
    noJudge: false,
    noScreenshots: false,
    langfuse: false,
    models: [],
    out: resolve("test/eval/benchmark-output"),
    concurrency: 6,
  };
  for (const arg of argv) {
    if (arg === "--mock") f.mock = true;
    else if (arg === "--no-judge") f.noJudge = true;
    else if (arg === "--no-screenshots") f.noScreenshots = true;
    else if (arg === "--langfuse") f.langfuse = true;
    else if (arg.startsWith("--models=")) f.models = arg.slice(9).split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith("--pages=")) f.pages = arg.slice(8).split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith("--judge=")) f.judge = arg.slice(8).trim();
    else if (arg.startsWith("--out=")) f.out = resolve(arg.slice(6));
    else if (arg.startsWith("--concurrency=")) f.concurrency = Math.max(1, parseInt(arg.slice(14), 10) || 6);
  }
  return f;
}

/** Parse one `engine:model[:label]` spec. `model` may contain dots; label is optional. */
function parseModelSpec(spec: string): { engine: string; model: string; label?: string } | null {
  const parts = spec.split(":");
  if (parts.length < 2) return null;
  const engine = parts[0].trim();
  const model = parts[1].trim();
  const label = parts.slice(2).join(":").trim() || undefined;
  if (!engine || !model) return null;
  return { engine, model, label };
}

/** Resolve `--models` specs to runnable models, keying real-mode by config/env. */
function resolveModels(specs: string[], mock: boolean): { models: BenchModel[]; skipped: string[] } {
  const cfg = loadConfig();
  const models: BenchModel[] = [];
  const skipped: string[] = [];
  for (const spec of specs) {
    const parsed = parseModelSpec(spec);
    if (!parsed) { skipped.push(`"${spec}": expected engine:model[:label]`); continue; }
    const keyEngine = ENGINE_KEY[parsed.engine];
    if (!keyEngine) { skipped.push(`"${spec}": unknown engine "${parsed.engine}"`); continue; }
    const apiKey = mock ? "mock" : getApiKeyForEngine(keyEngine, cfg);
    if (!apiKey) { skipped.push(`"${spec}": no API key for ${parsed.engine}`); continue; }
    const label = parsed.label || parsed.model;
    models.push({
      id: slug(label),
      slug: slug(label),
      label,
      engine: parsed.engine as AgentEngine,
      model: parsed.model,
      apiKey,
    });
  }
  return { models, skipped };
}

/** Default lineup (VIB-1833): the five models requested on the issue. */
const DEFAULT_MODELS = [
  "anthropic-api:claude-haiku-4-5:Haiku 4.5",
  "anthropic-api:claude-sonnet-4-6:Sonnet 4.6",
  "anthropic-api:claude-opus-4-7:Opus 4.7",
  "openai-api:gpt-5.4:GPT 5.4",
  "openai-api:gpt-5.5:GPT 5.5",
];

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  // Langfuse is off by default in the product; `--langfuse` is the operator's
  // explicit opt-in for this run, so enable it for the gated paths.
  if (flags.langfuse) process.env.LANGFUSE_ENABLED = "true";
  const notes: string[] = [];
  const specs = flags.models.length ? flags.models : DEFAULT_MODELS;

  // --- Resolve mode + models ----------------------------------------------
  let mode: "real" | "mock" = flags.mock ? "mock" : "real";
  let { models, skipped } = resolveModels(specs, flags.mock);
  for (const s of skipped) notes.push(`Skipped model ${s}.`);
  if (!flags.mock && models.length === 0) {
    notes.push("No models had API keys — falling back to offline mock mode.");
    mode = "mock";
    ({ models } = resolveModels(specs, true));
  }
  const generator: PageGenerator = mode === "mock" ? mockGenerator : makeRealGenerator(flags.concurrency);

  // --- Judge ---------------------------------------------------------------
  let judgeFn: (item: EvalItem, modules: Parameters<typeof scoreCoverage>[0]) => Promise<ReturnType<typeof mockJudge> | null>;
  let judgeMeta: BenchmarkReport["judge"] = { enabled: false };
  if (mode === "mock") {
    judgeFn = async (item, modules) => mockJudge(item, modules);
    judgeMeta = { enabled: true, model: "mock-heuristic" };
  } else if (flags.noJudge) {
    judgeFn = async () => null;
    notes.push("Judge disabled — accuracy uses rule-based axes only.");
  } else {
    // Judge with the requested engine/model, else the first resolved model.
    const cfg = loadConfig();
    const judgeSpec = flags.judge ? parseModelSpec(flags.judge) : null;
    const jEngine = (judgeSpec?.engine as AgentEngine) ?? models[0].engine;
    const jModel = judgeSpec?.model ?? models[0].model;
    const jKey = getApiKeyForEngine(ENGINE_KEY[jEngine] ?? "anthropic-api", cfg) || models[0].apiKey;
    const jc: JudgeConfig = { engine: jEngine, apiKey: jKey, model: jModel };
    judgeFn = (item, modules) => judgePage(item, modules, jc);
    judgeMeta = { enabled: true, model: `${jEngine}:${jModel}` };
  }

  // --- Dataset -------------------------------------------------------------
  const items = flags.pages
    ? EVAL_DATASET.filter((i) => flags.pages!.includes(i.id))
    : EVAL_DATASET;
  if (items.length === 0) {
    console.error(`No dataset pages matched --pages=${flags.pages?.join(",")}. Known: ${EVAL_DATASET.map((i) => i.id).join(", ")}`);
    process.exit(1);
  }

  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outRoot = join(flags.out, runStamp);
  mkdirSync(outRoot, { recursive: true });

  console.log(`\n=== vibeSpot persistent-theme benchmark (${mode}) ===`);
  console.log(`Models: ${models.map((m) => `${m.label} [${m.engine}:${m.model}]`).join(", ")}`);
  console.log(`Pages:  ${items.map((i) => i.id).join(", ")} (${items.length})`);
  console.log(`Judge:  ${judgeMeta.enabled ? judgeMeta.model : "disabled"}`);
  console.log(`Out:    ${outRoot}\n`);

  // --- Langfuse experiment setup ------------------------------------------
  const runName = `benchmark-${runStamp}`;
  const langfuseOn = flags.langfuse && isLangfuseDatasetEnabled();
  if (flags.langfuse && !langfuseOn) notes.push("`--langfuse` requested but Langfuse keys are not configured — dataset sync skipped.");
  if (langfuseOn) {
    const ok = await syncDataset(items);
    console.log(`Langfuse: dataset sync ${ok ? "ok" : "failed (continuing)"} · run "${runName}"`);
  }

  // --- Run -----------------------------------------------------------------
  const records: BenchRecord[] = [];
  const shotJobs: ShotJob[] = [];
  for (const model of models) {
    for (const item of items) {
      process.stdout.write(`• ${model.label} / ${item.id} … `);
      const collector = new UsageCollector();
      try {
        const page = await collector.collect(() => generator(item, model));
        const usage = collector.totals();

        const validity = scoreValidity(page.rawModules, `bench-${model.slug}-${item.id}`, item.contentType);
        const coverage = scoreCoverage(page.finalModules, item.expectedModules);
        const judge = await judgeFn(item, page.finalModules);
        const accuracy = combineAccuracy(validity, coverage, judge);

        const metrics = {
          model: { label: model.label, engine: model.engine, model: model.model },
          page: { id: item.id, title: item.title },
          accuracy,
          validatorPassRate: validity.passRate,
          cleanRate: validity.cleanRate,
          invalidCssModules: validity.invalidCssModules,
          coverage: coverage.coverage,
          missing: coverage.missing,
          judge: judge?.overall ?? null,
          costUsd: usage.costUsd,
          hasUnpricedCalls: usage.hasUnpricedCalls,
          latencyMs: page.durationMs,
          moduleCount: page.finalModules.length,
          tokens: { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens },
          traceId: page.traceId,
          sessionId: themeNameFor(item, model),
        };

        const persisted = persistTheme({ outRoot, modelSlug: model.slug, pageId: item.id, page, metrics });
        if (!flags.noScreenshots) {
          shotJobs.push({ htmlPath: persisted.pageHtmlPath, pngPath: join(persisted.dir, "page.png") });
        }

        records.push({
          modelLabel: model.label,
          engine: model.engine,
          model: model.model,
          modelSlug: model.slug,
          itemId: item.id,
          itemTitle: item.title,
          accuracy,
          validatorPassRate: validity.passRate,
          cleanRate: validity.cleanRate,
          invalidCssModules: validity.invalidCssModules,
          coverage: coverage.coverage,
          judge: judge?.overall ?? null,
          costUsd: usage.costUsd,
          hasUnpricedCalls: usage.hasUnpricedCalls,
          latencyMs: page.durationMs,
          moduleCount: page.finalModules.length,
          failed: page.failed,
          artifactDir: persisted.dir,
          traceId: page.traceId,
          sessionId: themeNameFor(item, model),
        });
        console.log(`acc ${(accuracy * 100).toFixed(0)}% · $${usage.costUsd.toFixed(4)} · ${(page.durationMs / 1000).toFixed(1)}s · saved`);

        if (langfuseOn && page.traceId) {
          await linkRunItem({ runName, itemId: item.id, traceId: page.traceId, metadata: { model: model.label } });
          await pushScore({ traceId: page.traceId, name: "accuracy", value: accuracy });
          await pushScore({ traceId: page.traceId, name: "coverage", value: coverage.coverage });
          if (judge) await pushScore({ traceId: page.traceId, name: "judge", value: judge.overall });
          await pushScore({ traceId: page.traceId, name: "cost_usd", value: usage.costUsd });
          await pushScore({ traceId: page.traceId, name: "latency_ms", value: page.durationMs });
        }
      } catch (err) {
        const message = (err as Error).message?.slice(0, 200) ?? String(err);
        console.log(`FAILED: ${message}`);
        records.push({
          modelLabel: model.label, engine: model.engine, model: model.model, modelSlug: model.slug,
          itemId: item.id, itemTitle: item.title,
          accuracy: 0, validatorPassRate: 0, cleanRate: 0, coverage: 0, judge: null,
          costUsd: collector.totals().costUsd, hasUnpricedCalls: collector.totals().hasUnpricedCalls,
          latencyMs: 0, moduleCount: 0, failed: 0, artifactDir: "", error: message,
        });
      } finally {
        collector.stop();
      }
    }
  }

  // --- Screenshots (best-effort, after all generation) ---------------------
  let screenshotNote: string | undefined;
  if (!flags.noScreenshots && shotJobs.length) {
    process.stdout.write(`\nCapturing ${shotJobs.length} screenshot(s) … `);
    const shot = await captureScreenshots(shotJobs);
    console.log(`${shot.captured} captured, ${shot.skipped} skipped`);
    if (shot.unavailableReason) {
      screenshotNote = shot.unavailableReason;
      notes.push(`Screenshots skipped: ${shot.unavailableReason}`);
    }
  } else if (flags.noScreenshots) {
    notes.push("Screenshots disabled (`--no-screenshots`) — full-page HTML still saved as `page.html`.");
  }

  // --- Report --------------------------------------------------------------
  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    runStamp,
    mode,
    judge: judgeMeta,
    pages: items.map((i) => ({ id: i.id, title: i.title, brief: i.brief })),
    models: models.map((m) => ({ label: m.label, engine: m.engine, model: m.model, slug: m.slug })),
    records,
    notes,
    screenshotsAvailable: !screenshotNote && !flags.noScreenshots,
  };

  writeFileSync(join(outRoot, "benchmark.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outRoot, "OVERVIEW.md"), renderOverview(report));

  console.log(`\n${"-".repeat(60)}`);
  console.log(`Artifacts: ${outRoot}`);
  console.log(`  OVERVIEW.md     — generation overview (README/docs)`);
  console.log(`  benchmark.json  — machine-readable report`);
  console.log(`  <model>/<page>/ — persisted theme + page.html${report.screenshotsAvailable ? " + page.png" : ""} + metrics.json`);
  if (mode === "mock") console.log("NOTE: mock mode — numbers are simulated. Re-run with provider keys for real figures.");
}

main().catch((err) => {
  console.error("benchmark failed:", err);
  process.exit(1);
});
