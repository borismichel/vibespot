# Provider-comparison eval harness (VIB-1768)

Dataset-driven evaluation of model providers (Anthropic / OpenAI / Gemini /
Langdock) on **vibeSpot module generation** — scoring **accuracy**, **cost**, and
**latency** per provider over a shared set of reference landing-page briefs.

This is internal dev/CI tooling. It is **not** shipped to end users and is not
gated on the platform-deployment decision (parent
[VIB-1764](../../CHANGELOG.md)).

## One command

```bash
# Offline demo — no API keys needed. Runs the whole harness against deterministic
# mock providers and writes a (clearly-labelled) sample comparison.
npm run eval

# Real comparison — needs API keys in ~/.vibespot/config.json or env.
npm run eval -- --providers=anthropic,openai,gemini

# Pick a judge, cap the dataset, enable Langfuse experiment tracking.
npm run eval -- --providers=anthropic,openai --judge=anthropic --limit=3 --langfuse
```

Output lands in `test/eval/output/` (gitignored): `latest.md` + `latest.json`
plus timestamped copies. A committed sample lives in
[`PROVIDER-COMPARISON.md`](./PROVIDER-COMPARISON.md).

## Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--providers=a,b,c` | `anthropic,openai,gemini` | Which providers to compare. Also `EVAL_PROVIDERS` env. Unknown / unkeyed providers are skipped. |
| `--judge=<id>` | first keyed provider | Provider that runs the LLM-as-judge. |
| `--no-judge` | off | Skip the judge; accuracy uses rule-based axes only. |
| `--langfuse` | off | Sync the dataset + push per-run scores as a Langfuse experiment (needs Langfuse keys). |
| `--limit=N` | all | Only the first N dataset items (faster smoke runs). |
| `--concurrency=N` | 6 | Module-developer parallelism inside each page. |
| `--mock` | off | Force offline mock mode even if keys are present. |
| `--out=DIR` | `test/eval/output` | Where artifacts are written. |

Keys are resolved exactly as the app resolves them (`getApiKeyForEngine`): from
`~/.vibespot/config.json` or the matching env var (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_AI_API_KEY`, `LANGDOCK_API_KEY`). If
**no** requested provider has a key, the harness falls back to mock mode so the
command always produces something.

## What it measures

For each (provider, page) it runs the real production pipeline
(`runAgentPipeline`) and scores three accuracy axes plus cost and latency:

- **Validator pass-rate** — reuses the shipped `stages/validator.ts` on the
  **raw** module-developer output (captured from `module_progress` events,
  before the auto-fixer). A module "passes" if it has no *unfixable* issues.
  Because the auto-fixer resolves most page-module issues, this saturates near
  100%; **clean first-pass** (zero issues at all) is the stricter signal.
- **Coverage** — fraction of the brief's expected sections present.
- **LLM-as-judge** — fidelity to the brief on four 1–5 dimensions
  (brief-coverage / layout / content / HubSpot-correctness) over the shipped page.
- **Cost** — sum of every model call's USD via the shipped `computeCost`,
  captured through the `onModelUsage` hook in `src/server/langfuse.ts`. The
  judge's own cost is excluded (eval overhead).
- **Latency** — end-to-end pipeline wall-clock per page.

Accuracy blends the axes: `0.40·validator + 0.20·coverage + 0.40·judge`
(`0.65 / 0.35` without a judge).

Runs are **sequential per (provider, page)**: the usage hook is process-global,
so concurrent pages would cross-attribute cost. Module development still
parallelises within a page.

## Files

| File | Role |
|------|------|
| `dataset.ts` | The ≥5 reference page briefs + expected sections + judge rubrics. |
| `providers.ts` | Resolves requested provider ids → (engine, model, key). |
| `generate.ts` | Real pipeline runner (raw-output capture) + offline mock. |
| `scoring.ts` | Validator pass-rate + coverage; accuracy blend. |
| `judge.ts` | LLM-as-judge (+ deterministic mock judge). |
| `usage-collector.ts` | Aggregates cost/tokens via the `onModelUsage` hook. |
| `langfuse-dataset.ts` | Optional Langfuse dataset / run / score sync (eval **and** calibration). |
| `report.ts` | Aggregation + markdown/JSON rendering. |
| `run-eval.ts` | CLI entry point. |
| `calibration-set.ts` | Human-labeled (PASS/FAIL) ground-truth pages for judge calibration. |
| `calibrate-judge.ts` | Judge-calibration CLI entry point. |
| `scoring.test.ts` | Vitest unit tests for the rule-based scoring. |

## Extending the dataset

Add an `EvalItem` to `EVAL_DATASET` in `dataset.ts`: a `brief` (the user
message), `expectedModules` (sections + keywords for coverage), and a `rubric`
(handed verbatim to the judge). To use a `test/validate.ts`-style React/Lovable
fixture, make the `brief` the "convert this page" instruction and set
`expectedModules` to the source page's sections.

## Langfuse experiment view

With `--langfuse` the harness creates a `vibespot-module-eval` dataset, upserts
one item per page, and registers each provider as a **dataset run** whose traces
carry `accuracy` / `validator_pass_rate` / `coverage` / `judge` / `cost_usd` /
`latency_ms` scores — so providers can be compared run-over-run in the Langfuse
UI on top of the local markdown report.

## Judge calibration (VIB-1863)

The benchmark numbers lean on the LLM-as-judge — so the judge itself must be
validated against human labels before it's trusted for comparison decisions
(per the langfuse skill's `judge-calibration` reference, **simple mode**).

```bash
npm run eval:calibrate                         # offline mock judge (no keys, CI)
npm run eval:calibrate -- --judge=anthropic    # the real judge
npm run eval:calibrate -- --judge=anthropic --langfuse   # + Langfuse experiment
npm run eval:calibrate -- --judge=anthropic --threshold=0.55
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--judge=<id>` | mock judge | Provider that runs the judge under test. |
| `--threshold=N` | `0.7` | `overall ≥ N → PASS` decision rule (binarises the 4-dim score). |
| `--sweep` | always reported | Threshold sweep is always in the report; flag reserved. |
| `--langfuse` | off | Sync the `vibespot-judge-calibration` dataset + push scores. |
| `--out=DIR` | `test/eval/output` | Where `calibration-latest.{md,json}` are written. |

**How it works.** `calibration-set.ts` holds a small set of pages paired with a
**human PASS/FAIL label** — hand-authored so the correct label is unambiguous by
construction (clearly-shippable vs clearly-broken, plus two honest borderline
probes). The harness runs the judge over each page (never showing it the label),
binarises the judge's `overall` via `--threshold`, and reports **valid rows /
invalid-label count / exact-match accuracy** plus a **threshold sweep** — which
separates *does the judge discriminate good from bad* from *is the cut-point set
right*. With `--langfuse` it pushes `judge-exact-match` (per row) and
`judge-accuracy` (run aggregate) via the same direct-REST score path as the eval.

This is a **bootstrap label set, not a held-out test split** — the accuracy is
an alignment sanity check, not a final quality guarantee. Grow the set (ideally
with real reviewed benchmark pages) for a tighter estimate. A committed sample
result lives in [`JUDGE-CALIBRATION.md`](./JUDGE-CALIBRATION.md).
