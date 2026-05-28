# Persistent-theme benchmark (VIB-1833)

A model comparison that **keeps the themes**. Where the provider-comparison harness
(`run-eval.ts`, VIB-1768) holds pages in memory and emits KPI numbers only, this
benchmark also writes every generated theme to disk plus a standalone full-page
render — so the same brief can be compared across models on **visual fidelity**
(the saved themes / screenshots) and on **Langfuse KPIs** (accuracy, cost, latency,
judge) in one run. Output is built to drop into the README / docs as a generation
overview.

## Run it

```bash
# Offline mock — proves the pipeline end to end, no keys, no spend
LANGFUSE_ENABLED=false npm run benchmark -- --mock

# Real — the five models from the issue (default lineup), all six dataset pages
npm run benchmark -- --models=anthropic-api:claude-haiku-4-5:Haiku 4.5,anthropic-api:claude-sonnet-4-6:Sonnet 4.6,anthropic-api:claude-opus-4-7:Opus 4.7,openai-api:gpt-5.4:GPT 5.4,openai-api:gpt-5.5:GPT 5.5 --langfuse

# A single representative page (cheaper headline comparison)
npm run benchmark -- --pages=saas-analytics --langfuse
```

A "model" under test is an explicit `engine:model[:label]` triple, so two models
from the same provider (Haiku + Sonnet + Opus, all Anthropic) are first-class —
the provider-keyed `--providers` flag in `run-eval.ts` can't express that. With no
keys it falls back to offline mock mode. Flags: `--pages=`, `--judge=engine:model`,
`--no-judge`, `--no-screenshots`, `--concurrency=`, `--out=`, `--langfuse`.

## Output layout

```
test/eval/benchmark-output/<runStamp>/
  OVERVIEW.md        brand-compliant generation overview (README/docs)
  benchmark.json     machine-readable report (per-model rollups + per-page records)
  <model>/<page>/
    theme/           importable HubSpot module layout (modules/*.module + shared.css/js)
    page.html        standalone full-page render (the screenshot input)
    page.png         full-page screenshot — iff a browser was available
    metrics.json     per-(model, page) KPIs
```

## Screenshots

Screenshots are decoupled from generation and **best-effort**. `page.html` is always
written; the PNG is captured only if a headless browser is usable. Playwright is
imported dynamically (no `package.json` dependency, stays out of the shipped bundle).

To capture PNGs, run the benchmark where a browser works, or backfill an existing
run afterwards (no regeneration, no model spend) with `screenshot-dir.ts`:

```bash
npm i -D playwright-core && npx playwright install --with-deps chromium
npx tsx test/eval/screenshot-dir.ts --dir=test/eval/benchmark-output/<runStamp>
```

`screenshot-dir.ts` walks the saved `page.html` files, writes `page.png` next to
each, then re-renders `OVERVIEW.md` with the screenshot gallery.

> In a sandbox without browser system libraries (and no sudo to install them),
> the screenshot step skips with a clear reason and the OVERVIEW falls back to
> linking the saved `page.html` / `theme/`. Generation and KPIs are unaffected.

## What's measured

Reuses the shipped scoring verbatim (see `report.ts` / `PROVIDER-COMPARISON.md`):
accuracy = 0.40·validator + 0.20·coverage + 0.40·judge; cost via the shipped
`computeCost` through the `onModelUsage` hook; latency = end-to-end pipeline
wall-clock. Fidelity is the saved themes — numbers rank correctness and cost, not
taste.
