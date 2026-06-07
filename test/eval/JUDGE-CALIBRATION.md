# Eval judge calibration — committed sample (VIB-1863)

This is a committed snapshot of `npm run eval:calibrate -- --judge=anthropic`
(the live artifact lands in the gitignored `test/eval/output/calibration-*.md`).
It validates the eval LLM-as-judge (`judge.ts`) against the human-labeled
ground-truth set in `calibration-set.ts`, following the langfuse skill's
`judge-calibration` reference in **simple mode** (exact-match accuracy vs a
human PASS/FAIL label, no held-out split).

See [`README.md` → Judge calibration](./README.md#judge-calibration-vib-1863)
for how to run it and what the flags mean.

## Headline

**The judge discriminates well, but the default decision threshold is set too
high.** Sonnet 4.6 scores every clearly-broken page ≤40% `overall` and every
shippable page 55–70% — a clean separation — yet the default `overall ≥ 0.70 →
PASS` rule mis-classifies three good pages as FAIL, giving **70%** exact-match
accuracy. Re-binarising at `overall ≥ 0.50` recovers **90%**.

**Recommendation: RETUNE THRESHOLD.** The judge's *ranking* is sound; the
binarisation cut-point was set too high (the 4-dim average clusters good pages
around 3/5 per dimension). Adopt the swept threshold (≈0.5), or normalise the
judge's 4-dim scale, before leaning further on judge-based benchmarks. The
underlying benchmark (VIB-1833) uses the judge's continuous `overall` (not a
PASS/FAIL cut), so this is a calibration finding for any *thresholded* use of the
judge, not a retraction of the published numbers.

---

_Generated 2026-06-07 · mode: **real** · judge: anthropic claude-sonnet-4-6 ·
decision rule: judge `overall` ≥ 0.7 → PASS · dataset: `vibespot-judge-calibration`
(10 human-labeled pages)_

## Result

| Metric | Value |
| --- | --- |
| Valid rows | 10 / 10 |
| Invalid-label rows | 0 |
| **Accuracy (exact match) @ 0.70** | **70%** |
| Best achievable | **90%** at `overall ≥ 0.50` |

## Threshold sweep

Accuracy as the PASS cut-point moves — separates whether the judge
*discriminates* from whether the binarisation point is right.

| overall ≥ | accuracy | matches |
| --- | --- | --- |
| 0.40 | 90% | 9/10 |
| 0.45 | 90% | 9/10 |
| 0.50 ◀ best | 90% | 9/10 |
| 0.55 | 90% | 9/10 |
| 0.60 | 80% | 8/10 |
| 0.65 | 80% | 8/10 |
| 0.70 (current) | 70% | 7/10 |
| 0.75 | 60% | 6/10 |
| 0.80 | 60% | 6/10 |

## Per-fixture

| Fixture | Brief | Human | Judge | Overall | Match |
| --- | --- | --- | --- | --- | --- |
| `saas-good` | saas-analytics | PASS | FAIL | 65% | ✗ |
| `restaurant-good` | restaurant | PASS | FAIL | 55% | ✗ |
| `webinar-good` | webinar-event | PASS | PASS | 70% | ✓ |
| `empty-page` | saas-analytics | FAIL | FAIL | 20% | ✓ |
| `saas-no-fields` | saas-analytics | FAIL | FAIL | 20% | ✓ |
| `restaurant-broken-hubl` | restaurant | FAIL | FAIL | 20% | ✓ |
| `webinar-generic` | webinar-event | FAIL | FAIL | 20% | ✓ |
| `consulting-shell` | consulting | FAIL | FAIL | 20% | ✓ |
| `saas-thin-copy` | saas-analytics | PASS | FAIL | 40% | ✗ |
| `restaurant-incomplete` | restaurant | FAIL | FAIL | 40% | ✓ |

### Disagreements (all three are good pages scored too low)

- **`saas-good`** (human PASS, judge FAIL @ 65%) — the judge agreed all seven
  sections are present and the copy is "genuinely punchy and benefit-led," but
  docked HubSpot-correctness for a few fields referenced in HTML yet not declared
  in `fields.json`. A fair nitpick, but a human ships this (the auto-fixer / a
  one-line edit closes the gap); the judge's strict 4-dim average pulls it under
  0.70.
- **`restaurant-good`** (human PASS, judge FAIL @ 55%) — same pattern: menu
  correctly grouped, real address, but the judge penalised undeclared
  field tokens and a "skeletal" single-dish-per-course default.
- **`saas-thin-copy`** (human PASS, judge FAIL @ 40%) — the honest borderline:
  complete and editable (would ship) but the copy is deliberately generic. The
  judge is arguably *right* to be harsh here; this is the one disagreement where
  the human label is the debatable one.

The judge made **zero false positives** — it never passed a broken page. Its
error is one-directional (too strict on good pages), which is exactly what a
threshold drop corrects.

---

_Simple-mode calibration (langfuse skill `judge-calibration`): exact-match
accuracy on a bootstrap label set, not a held-out test split. Re-run with a
larger / more borderline set (ideally real reviewed benchmark pages) before
treating any single number as a final quality claim. LLM judge scores carry
run-to-run variance of a few points; the threshold conclusion is stable across
runs._
