/**
 * Merge benchmark runs into one combined overview (VIB-1833).
 *
 * Provider quota failures can leave a run "dirty" — e.g. the Anthropic half
 * succeeds but the OpenAI half fails on a billing cap. Rather than re-spend the
 * valid half, complete only the failed models in a second run, then merge:
 *
 *   npx tsx test/eval/merge-runs.ts \
 *     --dirs=/tmp/vib1833/DIRTY-RUN-...,/tmp/vib1833/bench-output/<openai-stamp> \
 *     --out=/tmp/vib1833/bench-output/combined
 *
 * For each input run it keeps only the **successful** records (drops errored
 * ones), takes the model entries those records reference, copies their persisted
 * theme dirs into `--out`, and writes a merged `benchmark.json` + `OVERVIEW.md`.
 * Records are deduped by (modelSlug, itemId), preferring a successful one — so
 * re-running a failed model supersedes its error record. No model spend.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { renderOverview, type BenchmarkReport, type BenchRecord } from "./benchmark-report.js";

function parse(argv: string[]): { dirs: string[]; out: string } {
  let dirs: string[] = [];
  let out = "";
  for (const a of argv) {
    if (a.startsWith("--dirs=")) dirs = a.slice(7).split(",").map((s) => resolve(s.trim())).filter(Boolean);
    else if (a.startsWith("--out=")) out = resolve(a.slice(6));
  }
  return { dirs, out };
}

function main(): void {
  const { dirs, out } = parse(process.argv.slice(2));
  if (dirs.length < 2 || !out) {
    console.error("usage: tsx test/eval/merge-runs.ts --dirs=<runA>,<runB>[,...] --out=<combined dir>");
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });

  const modelsBySlug = new Map<string, BenchmarkReport["models"][number]>();
  const pagesById = new Map<string, { id: string; title: string }>();
  const recByKey = new Map<string, BenchRecord>(); // `${modelSlug}::${itemId}`
  let judge: BenchmarkReport["judge"] = { enabled: false };
  let screenshotsAvailable = true;
  const notes: string[] = [];

  for (const dir of dirs) {
    const reportPath = join(dir, "benchmark.json");
    if (!existsSync(reportPath)) {
      console.error(`skip ${dir}: no benchmark.json`);
      continue;
    }
    const rep = JSON.parse(readFileSync(reportPath, "utf8")) as BenchmarkReport;
    if (rep.judge?.enabled) judge = rep.judge;
    screenshotsAvailable = screenshotsAvailable && !!rep.screenshotsAvailable;

    const good = rep.records.filter((r) => !r.error);
    const keptSlugs = new Set(good.map((r) => r.modelSlug));

    for (const m of rep.models) if (keptSlugs.has(m.slug)) modelsBySlug.set(m.slug, m);
    for (const p of rep.pages) pagesById.set(p.id, p);

    for (const r of good) {
      const key = `${r.modelSlug}::${r.itemId}`;
      const existing = recByKey.get(key);
      if (!existing || existing.error) recByKey.set(key, r); // prefer success
      // Copy this (model,page)'s persisted theme + render into the combined dir.
      const src = join(dir, r.modelSlug, r.itemId);
      if (existsSync(src)) cpSync(src, join(out, r.modelSlug, r.itemId), { recursive: true });
    }
    notes.push(`Merged ${good.length} record(s) from ${basename(dir)}.`);
  }

  const merged: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    runStamp: basename(out),
    mode: "real",
    judge,
    pages: [...pagesById.values()],
    models: [...modelsBySlug.values()],
    records: [...recByKey.values()],
    notes,
    screenshotsAvailable,
  };

  writeFileSync(join(out, "benchmark.json"), JSON.stringify(merged, null, 2));
  writeFileSync(join(out, "OVERVIEW.md"), renderOverview(merged));
  console.log(`Merged ${merged.models.length} model(s), ${merged.records.length} record(s) → ${out}`);
  console.log(`  OVERVIEW.md + benchmark.json + per-(model,page) themes copied.`);
}

main();
