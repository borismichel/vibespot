# vibeSpot provider comparison — module generation (VIB-1768)

**Status:** harness complete and validated end-to-end in offline mock mode.
**Real provider numbers are pending API keys** — see "Producing the real
comparison" below. This environment has no Anthropic/OpenAI/Gemini/Langdock
keys, so the figures in the sample table are *simulated* and exist only to
demonstrate the harness; they are **not** a real provider ranking.

This is Phase 2 of the Langfuse work (parent
[VIB-1764](../../CHANGELOG.md)), building on the shipped instrumentation
(VIB-1765 / VIB-1766 / VIB-1767). It is internal dev/CI tooling and is **not**
gated on the platform-deployment decision.

## What this answers

The "eval using datasets to compare providers" question Boris raised: given the
same set of reference landing-page briefs, **which provider produces the most
accurate HubSpot modules, at what cost, and how fast?** The harness turns that
into a reproducible, one-command measurement and (optionally) a Langfuse
experiment.

## Methodology

A dataset of **6 reference landing-page briefs** (`dataset.ts` — SaaS,
design agency, restaurant, webinar, mobile app, B2B consulting) drives the real
production pipeline (`runAgentPipeline`) once per provider. Each generated page
is scored on three accuracy axes plus cost and latency:

| Axis | How | Source reused |
|------|-----|---------------|
| Validator pass-rate | raw modules with no *unfixable* issue | `stages/validator.ts` |
| Clean first-pass | raw modules with *zero* issues (stricter) | `stages/validator.ts` |
| Coverage | brief's expected sections present | `scoring.ts` |
| Fidelity (judge) | LLM-as-judge, 4×(1–5) on the shipped page | `judge.ts` + `callAgent` |
| Cost | Σ model-call USD (judge excluded) | `pricing.computeCost` + `onModelUsage` |
| Latency | end-to-end pipeline wall-clock | pipeline `stats.durationMs` |

`Accuracy = 0.40·validator + 0.20·coverage + 0.40·judge` (`0.65 / 0.35` without a
judge). Full detail in [`README.md`](./README.md).

**Why briefs + rubrics, not golden HTML:** there is no single correct module for
a brief, so exact-match scoring would be brittle and reward memorisation. The
validator measures *correctness*; the judge measures *fidelity*. Those are the
two axes that actually decide provider routing.

**Caveat the metrics expose honestly:** for page content the rule-based
auto-fixer resolves nearly every issue, so validator pass-rate saturates near
100% across providers. The discriminating rule-based signal is therefore
**clean first-pass rate**, not pass-rate. Cost and latency differ by ~5–10×
between frontier and cheap-fast models and are usually the deciding factors once
accuracy clears a quality bar.

## Sample run (MOCK — simulated, not real providers)

Produced by `npm run eval` with no keys configured. It exercises the full path
(generate → score → cost → latency → rank) so the report format is exactly what
a real run produces. **Do not cite these as provider results.**

| Rank | Provider | Model | Accuracy | Validator pass | Clean first-pass | Coverage | Judge | Cost/page | Latency/page |
|------|----------|-------|----------|----------------|------------------|----------|-------|-----------|--------------|
| 1 | anthropic | `claude-sonnet-4-20250514` | 94% | 100% | 100% | 100% | 85% | $0.3792 | 9.2s |
| 2 | openai | `gpt-4o` | 94% | 100% | 0% | 100% | 85% | $0.2814 | 7.1s |
| 3 | gemini | `gemini-2.5-flash` | 88% | 100% | 0% | 87% | 76% | $0.0458 | 5.3s |

The mock tiers are wired to show the shape of real trade-offs: a frontier model
(clean first-pass, higher cost, higher latency), a mid model (ships fine but
needs auto-fixes), and a cheap-fast model (much cheaper and faster, but drops a
section and scores lower on fidelity). A real run replaces these with measured
values — the cost figures in particular will drop once prompt caching is in play
(the mock does not simulate cache reads).

## Producing the real comparison

On a machine with provider keys (config or env), one command meets the
acceptance criterion (≥2 providers × ≥5 pages, accuracy + cost + latency,
reproducible):

```bash
npm run eval -- --providers=anthropic,openai,gemini --judge=anthropic --langfuse
```

Then paste `test/eval/output/latest.md`'s summary table here under a "Real run"
heading (with date, models, and dataset size), and the Langfuse dataset
`vibespot-module-eval` will hold the per-run traces + scores for drill-down.

Rough cost expectation per full run: ~6 pages × ~9 model calls × N providers,
plus one judge call per page. With the dataset at 6 pages and 3 providers that
is on the order of a few US dollars of API spend (model-dependent), dominated by
the frontier provider.

## Real run

**Date:** 2026-05-27 · **Mode:** real · **Provider:** Anthropic (3 models) +
OpenAI GPT-5 (3 models, [VIB-1832](/VIB/issues/VIB-1832)) ·
**Langfuse:** self-hosted instance, project **vibespot**, dataset
`vibespot-module-eval`.

> **Within-Anthropic model comparison.** Sonnet 4.6 and Haiku 4.5 were run over
> the full 6-page dataset; Opus 4.7 over a 2-page subset (`saas-analytics`,
> `design-agency`) to cap its cost. Each run used `--judge=anthropic`, so **the
> judge model equals the generation model** — the validator / coverage /
> clean-first-pass axes are objective and directly comparable across rows, but
> **the judge (and therefore the blended accuracy) axis is _not_ strictly
> comparable across rows** (a different judge per row). The OpenAI GPT-5 backfill
> ([VIB-1832](/VIB/issues/VIB-1832)) is in its own section below; Gemini remains
> a follow-up (no API key configured). Commands:
>
> ```bash
> # config.anthropicApiModel selects the model (harness has no per-run flag)
> npm run eval -- --providers=anthropic --judge=anthropic --langfuse            # Sonnet 4.6, Haiku 4.5 (6 pages)
> npm run eval -- --providers=anthropic --judge=anthropic --langfuse --limit=2  # Opus 4.7 (2 pages)
> ```

### Full dataset (6 pages) — Sonnet 4.6 vs Haiku 4.5

| Model | Accuracy | Validator pass | Clean first-pass | Coverage | Judge | Cost/page | Total (6pg) | Latency/page |
|-------|----------|----------------|------------------|----------|-------|-----------|-------------|--------------|
| `claude-sonnet-4-6` | 98% | 100% | 89% | 100% | 94% | $1.5516 | $9.3094 | 358.5s |
| `claude-haiku-4-5-20251001` | 95% | 100% | **98%** | 100% | 88% | **$0.3755** | **$2.2533** | **105.2s** |

### 2-page subset (`saas-analytics`, `design-agency`) — all three models, apples-to-apples

| Model | Accuracy | Validator | Clean | Coverage | Judge | Cost/page | Total (2pg) | Latency/page |
|-------|----------|-----------|-------|----------|-------|-----------|-------------|--------------|
| `claude-sonnet-4-6` | 98% | 100% | 100% | 100% | 95% | $1.5481 | $3.0962 | 372.4s |
| `claude-haiku-4-5-20251001` | 94% | 100% | 92% | 100% | 85% | $0.3630 | $0.7259 | 99.4s |
| `claude-opus-4-7` | 84% | 100% | 100% | 100% | 60% | $7.8013 | $15.6027 | 290.0s |

### Per-page detail

**`claude-sonnet-4-6` (6 pages)**

| Page | Accuracy | Validator | Coverage | Judge | Cost | Latency | Modules |
|------|----------|-----------|----------|-------|------|---------|---------|
| saas-analytics | 98% | 100% (7/7 clean) | 100% | 95% | $1.5608 | 422.4s | 7 |
| design-agency | 98% | 100% (6/6 clean) | 100% | 95% | $1.5354 | 322.4s | 6 |
| restaurant | 98% | 100% (6/6 clean) | 100% | 95% | $1.6036 | 341.1s | 6 |
| webinar-event | 96% | 100% (6/6 clean) | 100% | 90% | $1.6766 | 374.6s | 6 |
| mobile-app | 98% | 100% (3/6 clean) | 100% | 95% | $1.3888 | 345.4s | 6 |
| consulting | 98% | 100% (5/6 clean) | 100% | 95% | $1.5444 | 344.9s | 6 |

**`claude-haiku-4-5-20251001` (6 pages)**

| Page | Accuracy | Validator | Coverage | Judge | Cost | Latency | Modules |
|------|----------|-----------|----------|-------|------|---------|---------|
| saas-analytics | 92% | 100% (6/7 clean) | 100% | 80% | $0.3949 | 120.9s | 7 |
| design-agency | 96% | 100% (6/6 clean) | 100% | 90% | $0.3310 | 77.9s | 6 |
| restaurant | 92% | 100% (7/7 clean) | 100% | 80% | $0.3926 | 112.7s | 7 |
| webinar-event | 100% | 100% (6/6 clean) | 100% | 100% | $0.3673 | 99.3s | 6 |
| mobile-app | 98% | 100% (7/7 clean) | 100% | 95% | $0.3986 | 111.5s | 7 |
| consulting | 92% | 100% (6/6 clean) | 100% | 80% | $0.3689 | 109.1s | 6 |

**`claude-opus-4-7` (2 pages)**

| Page | Accuracy | Validator | Coverage | Judge | Cost | Latency | Modules |
|------|----------|-----------|----------|-------|------|---------|---------|
| saas-analytics | 68% | 100% (7/7 clean) | 100% | 20% | $8.6862 | 343.6s | 7 |
| design-agency | 100% | 100% (6/6 clean) | 100% | 100% | $6.9164 | 236.4s | 6 |

### Read of the numbers

- **All three models clear the objective bar.** Validator pass-rate and section
  coverage are **100% across every model and page** — the pipeline + rules
  produce structurally valid, complete HubSpot modules regardless of tier.
- **Haiku 4.5 is the value standout.** 95% blended accuracy (3 pts under Sonnet)
  at **$0.38/page — ~¼ Sonnet's cost, ~20× cheaper than Opus** — and the
  **highest clean-first-pass of all three (98%)**, i.e. it needed the auto-fixer
  least. It's also ~3.4× faster (105s vs 358s/page).
- **Opus 4.7 did _not_ win this task.** On the shared 2-page subset it scored
  84% blended accuracy vs Sonnet's 98% and Haiku's 94% — driven **entirely** by
  the judge rating `saas-analytics` 20% (the other page scored 100%). Its
  objective axes were all perfect (100% validator / coverage / clean). At
  **$7.80/page** (~5× Sonnet, ~20× Haiku) the premium isn't justified here.
- **Judge caveat (important).** Because the judge = the generation model, the
  judge axis is self-evaluation and is noisy on small samples — the Opus
  `saas-analytics` 20% is a single-page judge outlier, not a structural failure.
  Treat the validator/coverage/clean/cost/latency columns as the comparable
  signal; treat the judge/accuracy columns as within-row, not cross-row.
- **Takeaway:** for vibeSpot module generation, **Haiku 4.5 is the cost/quality
  pick**, **Sonnet 4.6 the balanced default**, and **Opus 4.7's premium buys no
  measurable quality on this task**.

### Langfuse

Three experiments registered in the self-hosted instance (project **vibespot**,
dataset `vibespot-module-eval`): `eval-2026-05-27T15-14-20-590Z` (Sonnet 4.6),
`eval-2026-05-27T17-07-53-818Z` (Haiku 4.5), and the Opus 4.7 run — each with
per-page accuracy / validator-pass-rate / coverage / judge / cost / latency
scores for drill-down. The OpenAI GPT-5 backfill registered 9 further runs (3
models × 3 runs).

## OpenAI GPT-5 backfill (VIB-1832)

**Date:** 2026-05-27 · **Mode:** real · three GPT-5 chat variants.

> **Different methodology — read before comparing to the Anthropic rows.** Each
> model was run **3× over the single `saas-analytics` page** (the runs capture
> variance; accuracy is shown as mean with lo/hi across the 3). Judge =
> **`claude-sonnet-4-6`**, i.e. a *fixed external* judge — so the judge axis is
> directly comparable *across the three OpenAI rows*, but it differs from the
> Anthropic rows' self-judge, and the page set differs (1 page vs 6/2). Treat
> validator / clean / coverage / cost / latency as the hard cross-provider
> signal and the judge/accuracy columns as directional. This run required two
> OpenAI-engine fixes shipped in this PR — `max_completion_tokens` (GPT-5 rejects
> the legacy `max_tokens`) and `strict: false` structured-output (our schemas use
> JSON-Schema keywords OpenAI strict mode rejects) — plus approximate GPT-5
> pricing in `pricing.ts`. Command:
>
> ```bash
> # openaiApiModel in config selects the variant (harness has no per-run flag);
> # set per model, then:
> npm run eval -- --providers=openai --judge=anthropic --langfuse --limit=1   # ×3 per model
> ```

### saas-analytics — GPT-5 family (mean of 3 runs each)

| Model | Accuracy | Validator | Clean first-pass | Coverage | Judge | Cost/page | Latency/page | Failed |
|-------|----------|-----------|------------------|----------|-------|-----------|--------------|--------|
| `gpt-5.3-chat-latest` | 93% (lo 90% / hi 98%) | 100% | 100% | 100% | 82% | **$0.4596** | **168.5s** | 0 |
| `gpt-5.4` | 96% (lo 94% / hi 98%) | 100% | 100% | 100% | 90% | $1.0161 | 387.2s | 0 |
| `gpt-5.5` | 98% (lo 98% / hi 98%) | 100% | 100% | 100% | 95% | $3.7279 | 556.7s | 0 |

### Read of the numbers

- **All three GPT-5 variants clear the objective bar** — 100% validator pass,
  100% clean first-pass, 100% coverage, **0 failures** across all 9 runs. The
  pipeline + rules produce structurally valid, complete HubSpot modules on
  OpenAI just as on Anthropic.
- **Quality scales with tier — and so does cost, faster.** Judge-blended
  accuracy climbs 93% → 96% → 98% across 5.3 → 5.4 → 5.5, but cost climbs
  **$0.46 → $1.02 → $3.73/page (~8×)** and latency 169s → 387s → 557s.
- **`gpt-5.5` matches Sonnet 4.6's 98%** on this page but at ~2.4× the cost
  ($3.73 vs $1.55/page) and ~1.5× the latency — on this task the frontier OpenAI
  tier buys no measurable quality over Sonnet 4.6 while costing more.
- **`gpt-5.3-chat-latest` is the OpenAI value tier** — $0.46/page, closest to
  Haiku 4.5's $0.38 — though Haiku edges it on judge score at lower cost/latency.
- **Caveat (as above):** single page, external judge ≠ generation model, so the
  cross-provider accuracy read is directional, not a verdict.
