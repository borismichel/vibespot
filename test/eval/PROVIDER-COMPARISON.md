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

**Date:** 2026-05-27 · **Mode:** real · **Dataset:** 6 reference pages ·
**Judge:** anthropic (`claude-sonnet-4-6`)

> **Single-provider baseline (Anthropic only).** This first real run was scoped
> to one provider — Anthropic `claude-sonnet-4-6` — because that was the only
> key available. It is a real-output baseline, not yet a cross-provider
> comparison; OpenAI and Gemini are backfilled in a follow-up once their keys
> are in place. Command run:
>
> ```bash
> npm run eval -- --providers=anthropic --judge=anthropic --langfuse
> ```

| Rank | Provider | Model | Accuracy | Validator pass | Clean first-pass | Coverage | Judge | Cost/page | Total cost | Latency/page |
|------|----------|-------|----------|----------------|------------------|----------|-------|-----------|------------|--------------|
| 1 | **anthropic** | `claude-sonnet-4-6` | 98% | 100% | 89% | 100% | 94% | $1.5516 | $9.3094 | 358.5s |

### Per-page detail — anthropic (`claude-sonnet-4-6`)

| Page | Accuracy | Validator | Coverage | Judge | Cost | Latency | Modules | Notes |
|------|----------|-----------|----------|-------|------|---------|---------|-------|
| saas-analytics | 98% | 100% (7/7 clean) | 100% | 95% | $1.5608 | 422.4s | 7 | — |
| design-agency | 98% | 100% (6/6 clean) | 100% | 95% | $1.5354 | 322.4s | 6 | — |
| restaurant | 98% | 100% (6/6 clean) | 100% | 95% | $1.6036 | 341.1s | 6 | — |
| webinar-event | 96% | 100% (6/6 clean) | 100% | 90% | $1.6766 | 374.6s | 6 | — |
| mobile-app | 98% | 100% (3/6 clean) | 100% | 95% | $1.3888 | 345.4s | 6 | — |
| consulting | 98% | 100% (5/6 clean) | 100% | 95% | $1.5444 | 344.9s | 6 | — |

**Read of the numbers.** Sonnet 4.6 ships near-flawless content: validator
pass-rate 100% (every raw module is fixable or clean) and full section coverage
on all 6 briefs, with the LLM-judge averaging 94%. The stricter **clean
first-pass** axis (89% overall) is the real discriminator — `mobile-app`
(3/6 clean) and `consulting` (5/6 clean) needed the auto-fixer on a couple of
modules, while the other four pages were 100% clean. Cost is the headline
trade-off: **~$1.55/page, $9.31 for the 6-page run** (~6 min/page wall-clock) —
frontier-model economics, materially pricier than the mid/cheap tiers the mock
projects. This baseline is the reference the OpenAI/Gemini backfill ranks
against.

**Langfuse.** Run registered as the experiment `eval-2026-05-27T15-14-20-590Z`
in the self-hosted instance (project **vibespot**), dataset
`vibespot-module-eval` — per-page traces carry accuracy / validator-pass-rate /
coverage / judge / cost / latency scores for drill-down.
