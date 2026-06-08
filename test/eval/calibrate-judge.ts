/**
 * Eval LLM-judge calibration harness (VIB-1863).
 *
 *   npm run eval:calibrate                     # offline mock judge (no keys)
 *   npm run eval:calibrate -- --judge=anthropic
 *   npm run eval:calibrate -- --judge=anthropic --langfuse
 *   npm run eval:calibrate -- --threshold=0.65
 *
 * Validates the eval LLM-judge (`judge.ts`) against a human-labeled ground-truth
 * set (`calibration-set.ts`), following the langfuse skill's `judge-calibration`
 * reference in **simple mode**:
 *
 *   1. Run the judge over each labeled page (the judge never sees the label).
 *   2. Reduce the judge's 4-dim score to a binary PASS/FAIL via a threshold on
 *      `overall` (default 0.70).
 *   3. exact_match each row against the human label; report valid rows /
 *      invalid-label count / accuracy + a ship-or-iterate recommendation.
 *
 * With `--langfuse` it registers the run as a Langfuse experiment over the
 * `vibespot-judge-calibration` dataset and pushes `judge-exact-match` (per row)
 * and `judge-accuracy` (run aggregate) scores via the direct-REST path in
 * `langfuse-dataset.ts`.
 *
 * This is a bootstrap calibration set, not a held-out test split — accuracy here
 * is an alignment sanity check, not a final quality guarantee (skill §6).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EVAL_DATASET } from "./dataset.js";
import { CALIBRATION_SET, type HumanLabel } from "./calibration-set.js";
import { resolveProviders } from "./providers.js";
import { judgePage, mockJudge, type JudgeConfig } from "./judge.js";
import type { JudgeScore } from "./scoring.js";
import { runWithTrace, currentTraceId } from "../../src/server/langfuse.js";
import {
  syncCalibrationDataset,
  linkRunItem,
  pushScore,
  isLangfuseDatasetEnabled,
  CALIBRATION_DATASET_NAME,
} from "./langfuse-dataset.js";

interface Flags {
  judge?: string;
  langfuse: boolean;
  threshold: number;
  sweep: boolean;
  out: string;
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = { langfuse: false, threshold: 0.7, sweep: false, out: resolve("test/eval/output") };
  for (const arg of argv) {
    if (arg === "--langfuse") f.langfuse = true;
    else if (arg === "--sweep") f.sweep = true;
    else if (arg.startsWith("--judge=")) f.judge = arg.slice(8).trim();
    else if (arg.startsWith("--threshold=")) {
      const t = parseFloat(arg.slice(12));
      if (Number.isFinite(t) && t > 0 && t < 1) f.threshold = t;
    } else if (arg.startsWith("--out=")) f.out = resolve(arg.slice(6));
  }
  return f;
}

/** Accuracy at a given PASS threshold over already-scored fixtures. */
function accuracyAt(
  scored: { overall: number | null; humanLabel: HumanLabel }[],
  threshold: number,
): { accuracy: number | null; valid: number; matches: number } {
  const valid = scored.filter((s) => s.overall != null);
  if (valid.length === 0) return { accuracy: null, valid: 0, matches: 0 };
  let matches = 0;
  for (const s of valid) {
    const lbl: HumanLabel = (s.overall as number) >= threshold ? "PASS" : "FAIL";
    if (lbl === s.humanLabel) matches++;
  }
  return { accuracy: matches / valid.length, valid: valid.length, matches };
}

/**
 * Sweep candidate thresholds (the achievable cut-points are the midpoints
 * between adjacent observed `overall` values) and pick the one with the highest
 * accuracy, breaking ties toward the most central threshold (widest margin).
 */
function bestThreshold(
  scored: { overall: number | null; humanLabel: HumanLabel }[],
): { threshold: number; accuracy: number } | null {
  const vals = scored.map((s) => s.overall).filter((v): v is number => v != null).sort((a, b) => a - b);
  if (vals.length === 0) return null;
  const candidates = new Set<number>([0.5]);
  for (let i = 0; i < vals.length - 1; i++) candidates.add((vals[i] + vals[i + 1]) / 2);
  let best: { threshold: number; accuracy: number } | null = null;
  for (const t of [...candidates].sort((a, b) => a - b)) {
    const { accuracy } = accuracyAt(scored, t);
    if (accuracy == null) continue;
    if (!best || accuracy > best.accuracy || (accuracy === best.accuracy && Math.abs(t - 0.5) < Math.abs(best.threshold - 0.5))) {
      best = { threshold: t, accuracy };
    }
  }
  return best;
}

/** Map the judge's 4-dim score onto the human PASS/FAIL vocabulary. */
function judgeLabel(score: JudgeScore, threshold: number): HumanLabel {
  return score.overall >= threshold ? "PASS" : "FAIL";
}

interface Row {
  id: string;
  brief: string;
  humanLabel: HumanLabel;
  judgeLabel: HumanLabel | null; // null = judge call failed → invalid row
  overall: number | null;
  exactMatch: 0 | 1 | null;
  note: string;
  rationale: string;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.langfuse) process.env.LANGFUSE_ENABLED = "true";
  const notes: string[] = [];

  // --- Resolve the judge under test ---------------------------------------
  let mode: "real" | "mock" = "mock";
  let judgeFn: (fixtureIdx: number) => Promise<JudgeScore | null>;
  let judgeMeta = { provider: "mock-heuristic", model: "n/a" };

  if (flags.judge) {
    const { resolved, skipped } = resolveProviders([flags.judge]);
    for (const s of skipped) notes.push(`Judge "${s.id}" unavailable: ${s.reason}.`);
    if (resolved[0]) {
      mode = "real";
      const j = resolved[0];
      const cfg: JudgeConfig = { engine: j.engine, apiKey: j.apiKey, model: j.model };
      judgeMeta = { provider: j.id, model: j.model };
      judgeFn = (i) => {
        const fx = CALIBRATION_SET[i];
        const item = EVAL_DATASET.find((d) => d.id === fx.datasetItemId)!;
        return judgePage(item, fx.modules, cfg);
      };
    } else {
      notes.push("Requested judge had no API key — falling back to the offline mock judge.");
      judgeFn = makeMockJudge();
    }
  } else {
    judgeFn = makeMockJudge();
  }

  function makeMockJudge() {
    return async (i: number): Promise<JudgeScore | null> => {
      const fx = CALIBRATION_SET[i];
      const item = EVAL_DATASET.find((d) => d.id === fx.datasetItemId)!;
      return mockJudge(item, fx.modules);
    };
  }

  console.log(`\n=== vibeSpot judge calibration (${mode}, simple mode) ===`);
  console.log(`Judge:     ${judgeMeta.provider} ${judgeMeta.model}`);
  console.log(`Fixtures:  ${CALIBRATION_SET.length} human-labeled pages`);
  console.log(`Threshold: overall ≥ ${flags.threshold} → PASS\n`);

  // --- Langfuse experiment setup ------------------------------------------
  const runName = `calibration-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const langfuseOn = flags.langfuse && isLangfuseDatasetEnabled();
  if (flags.langfuse && !langfuseOn) {
    notes.push("`--langfuse` requested but Langfuse keys are not configured — dataset sync skipped.");
  }
  if (langfuseOn) {
    const ok = await syncCalibrationDataset(CALIBRATION_SET);
    console.log(`Langfuse: dataset sync ${ok ? "ok" : "failed (continuing)"} · run "${runName}"`);
  }

  // --- Run ----------------------------------------------------------------
  const rows: Row[] = [];
  const traceIds: string[] = [];
  for (let i = 0; i < CALIBRATION_SET.length; i++) {
    const fx = CALIBRATION_SET[i];
    process.stdout.write(`• ${fx.id} (human=${fx.label}) … `);

    // Each fixture gets its own trace so item-level scores attach to something
    // inspectable in the Langfuse UI; the judge call records a generation under it.
    let traceId: string | undefined;
    const score = await runWithTrace(
      {
        name: "judge-calibration",
        sessionId: CALIBRATION_DATASET_NAME,
        input: { fixture: fx.id, brief: fx.datasetItemId },
        metadata: { humanLabel: fx.label, threshold: flags.threshold },
        tags: ["judge-calibration"],
      },
      async () => {
        traceId = currentTraceId();
        return judgeFn(i);
      },
    );

    const judgeLbl = score ? judgeLabel(score, flags.threshold) : null;
    const exactMatch: 0 | 1 | null = judgeLbl == null ? null : judgeLbl === fx.label ? 1 : 0;
    rows.push({
      id: fx.id,
      brief: fx.datasetItemId,
      humanLabel: fx.label,
      judgeLabel: judgeLbl,
      overall: score ? score.overall : null,
      exactMatch,
      note: fx.note,
      rationale: score?.rationale ?? "(judge call failed)",
    });

    console.log(
      judgeLbl == null
        ? "INVALID (judge call failed)"
        : `judge=${judgeLbl} (${(score!.overall * 100).toFixed(0)}%) ${exactMatch ? "✓" : "✗"}`,
    );

    if (langfuseOn && traceId) {
      traceIds.push(traceId);
      await linkRunItem({ runName, itemId: fx.id, traceId, metadata: { humanLabel: fx.label } });
      if (exactMatch != null) {
        await pushScore({
          traceId,
          name: "judge-exact-match",
          value: exactMatch,
          comment: `human=${fx.label} judge=${judgeLbl}`,
          metadata: { expected_label: fx.label, actual_label: judgeLbl, calibration_mode: "simple" },
        });
      }
    }
  }

  // --- Aggregate (simple-mode metrics) ------------------------------------
  const validRows = rows.filter((r) => r.exactMatch != null);
  const invalidCount = rows.length - validRows.length;
  const matches = validRows.reduce((s, r) => s + (r.exactMatch ?? 0), 0);
  const accuracy = validRows.length === 0 ? null : matches / validRows.length;

  // Run aggregate: the REST score path attaches to traces (not the dataset-run
  // object), so we stamp `judge-accuracy` on the run's first trace as the
  // inspectable aggregate read (skill §8 REST fallback).
  if (langfuseOn && accuracy != null && traceIds[0]) {
    await pushScore({
      traceId: traceIds[0],
      name: "judge-accuracy",
      value: accuracy,
      comment: `${matches}/${validRows.length} valid rows matched · run ${runName}`,
      metadata: { calibration_mode: "simple", run: runName, valid_rows: validRows.length },
    });
  }

  // Threshold sweep: separate "does the judge *discriminate*" from "is the
  // binarisation cut-point right". A judge can rank pages perfectly yet score
  // badly at a mis-set threshold — the sweep tells the two apart.
  const sweepGrid = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8].map((t) => ({
    threshold: t,
    ...accuracyAt(rows, t),
  }));
  const best = bestThreshold(rows);

  const retuneHelps =
    accuracy != null && accuracy < 0.8 && best != null && best.accuracy >= 0.8 && Math.abs(best.threshold - flags.threshold) > 1e-9;

  const recommendation =
    accuracy == null
      ? "UNDEFINED — no valid rows; supply pages the judge can score."
      : validRows.length < 8
        ? `COLLECT MORE LABELS — only ${validRows.length} valid rows; accuracy ${(accuracy * 100).toFixed(0)}% is too small a sample to trust.`
        : accuracy >= 0.8
          ? `SHIP — judge agrees with human labels on ${(accuracy * 100).toFixed(0)}% of ${validRows.length} rows (≥80%) at threshold ${flags.threshold}. Safe for benchmark comparisons; re-check on drift.`
          : retuneHelps
            ? `RETUNE THRESHOLD — at the default ${flags.threshold} the judge agrees on only ${(accuracy * 100).toFixed(0)}%, but it *discriminates* well: re-binarising at overall ≥ ${best!.threshold.toFixed(3)} reaches ${(best!.accuracy * 100).toFixed(0)}%. The judge's ranking is sound; the cut-point was set too high. Adopt the swept threshold (or normalise the judge's 4-dim scale) before leaning on judge-based benchmarks.`
            : `ITERATE — judge agrees on only ${(accuracy * 100).toFixed(0)}% of ${validRows.length} rows (<80%) and no threshold recovers ≥80% (best ${best ? (best.accuracy * 100).toFixed(0) + "% @ " + best.threshold.toFixed(3) : "n/a"}). Tune the judge prompt/rubric, not just the threshold.`;

  const report = {
    generatedAt: new Date().toISOString(),
    mode,
    calibrationMode: "simple" as const,
    judge: judgeMeta,
    threshold: flags.threshold,
    totalRows: rows.length,
    validRows: validRows.length,
    invalidLabelCount: invalidCount,
    accuracy,
    sweep: sweepGrid,
    bestThreshold: best,
    recommendation,
    rows,
    notes,
  };

  mkdirSync(flags.out, { recursive: true });
  const md = renderMarkdown(report);
  writeFileSync(join(flags.out, "calibration-latest.md"), md);
  writeFileSync(join(flags.out, "calibration-latest.json"), JSON.stringify(report, null, 2));
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  writeFileSync(join(flags.out, `calibration-${stamp}.md`), md);

  console.log(`\n${"-".repeat(60)}`);
  console.log(
    `Valid rows: ${validRows.length}/${rows.length}  ·  invalid: ${invalidCount}  ·  accuracy @ ${flags.threshold}: ${accuracy == null ? "undefined" : (accuracy * 100).toFixed(0) + "%"}`,
  );
  if (best) {
    console.log(`Best threshold: overall ≥ ${best.threshold.toFixed(3)} → ${(best.accuracy * 100).toFixed(0)}% accuracy`);
  }
  console.log(`\n${recommendation}\n`);
  console.log(`Artifact: ${join(flags.out, "calibration-latest.md")} (+ JSON)`);
  if (mode === "mock") {
    console.log("NOTE: mock-judge mode — re-run with --judge=<provider> for the real judge.");
  }
}

function renderMarkdown(r: {
  generatedAt: string;
  mode: string;
  judge: { provider: string; model: string };
  threshold: number;
  totalRows: number;
  validRows: number;
  invalidLabelCount: number;
  accuracy: number | null;
  sweep: { threshold: number; accuracy: number | null; valid: number; matches: number }[];
  bestThreshold: { threshold: number; accuracy: number } | null;
  recommendation: string;
  rows: Row[];
  notes: string[];
}): string {
  const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
  const lines: string[] = [];
  lines.push(`# Eval judge calibration (simple mode)`);
  lines.push("");
  lines.push(`_Generated ${r.generatedAt} · mode: **${r.mode}**_`);
  lines.push("");
  lines.push(`- **Judge:** ${r.judge.provider} ${r.judge.model}`);
  lines.push(`- **Decision rule:** judge \`overall\` ≥ ${r.threshold} → PASS`);
  lines.push(`- **Dataset:** \`${CALIBRATION_DATASET_NAME}\` (${r.totalRows} human-labeled pages)`);
  lines.push("");
  lines.push(`## Result`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Valid rows | ${r.validRows} / ${r.totalRows} |`);
  lines.push(`| Invalid-label rows | ${r.invalidLabelCount} |`);
  lines.push(`| **Accuracy (exact match)** | **${pct(r.accuracy)}** |`);
  lines.push("");
  lines.push(`> **Recommendation:** ${r.recommendation}`);
  lines.push("");
  lines.push(`## Threshold sweep`);
  lines.push("");
  lines.push(
    `Accuracy as the PASS cut-point moves — separates whether the judge *discriminates* from whether the binarisation point is right.`,
  );
  lines.push("");
  lines.push(`| overall ≥ | accuracy | matches |`);
  lines.push(`| --- | --- | --- |`);
  for (const s of r.sweep) {
    const star = r.bestThreshold && Math.abs(s.threshold - r.bestThreshold.threshold) < 0.026 ? " ◀ best" : "";
    const cur = Math.abs(s.threshold - r.threshold) < 1e-9 ? " (current)" : "";
    lines.push(`| ${s.threshold.toFixed(2)}${cur}${star} | ${pct(s.accuracy)} | ${s.matches}/${s.valid} |`);
  }
  if (r.bestThreshold) {
    lines.push("");
    lines.push(
      `Best achievable: **${pct(r.bestThreshold.accuracy)}** at overall ≥ **${r.bestThreshold.threshold.toFixed(3)}**.`,
    );
  }
  lines.push("");
  lines.push(`## Per-fixture`);
  lines.push("");
  lines.push(`| Fixture | Brief | Human | Judge | Overall | Match |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const row of r.rows) {
    lines.push(
      `| \`${row.id}\` | ${row.brief} | ${row.humanLabel} | ${row.judgeLabel ?? "INVALID"} | ${pct(row.overall)} | ${row.exactMatch == null ? "—" : row.exactMatch ? "✓" : "✗"} |`,
    );
  }
  lines.push("");
  lines.push(`### Disagreements`);
  const misses = r.rows.filter((x) => x.exactMatch === 0);
  if (misses.length === 0) {
    lines.push("");
    lines.push(`None — the judge matched the human label on every valid row.`);
  } else {
    lines.push("");
    for (const m of misses) {
      lines.push(`- **\`${m.id}\`** — human \`${m.humanLabel}\`, judge \`${m.judgeLabel}\` (${pct(m.overall)}). Human rationale: ${m.note} Judge said: ${m.rationale}`);
    }
  }
  if (r.notes.length) {
    lines.push("");
    lines.push(`## Notes`);
    lines.push("");
    for (const n of r.notes) lines.push(`- ${n}`);
  }
  lines.push("");
  lines.push(`---`);
  lines.push(
    `_Simple-mode calibration (langfuse skill \`judge-calibration\`): exact-match accuracy on a bootstrap label set, not a held-out test split. Re-run with a larger / more borderline set before treating any single number as a final quality claim._`,
  );
  lines.push("");
  return lines.join("\n");
}

main().catch((err) => {
  console.error("calibration failed:", err);
  process.exit(1);
});
