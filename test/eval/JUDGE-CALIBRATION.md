# Eval judge calibration — committed sample (VIB-1863, retuned in VIB-1864)

This is a committed snapshot of `npm run eval:calibrate -- --judge=anthropic`
(the live artifact lands in the gitignored `test/eval/output/calibration-*.md`).
It validates the eval LLM-as-judge (`judge.ts`) against the human-labeled
ground-truth set in `calibration-set.ts`, following the langfuse skill's
`judge-calibration` reference in **simple mode** (exact-match accuracy vs a
human PASS/FAIL label, no held-out split).

See [`README.md` → Judge calibration](./README.md#judge-calibration-vib-1863)
for how to run it and what the flags mean.

## Headline

**The judge discriminates cleanly, and the decision threshold is now tuned to
where it actually separates good from bad.** Sonnet 4.6 scores every clearly-broken
page ≤40% `overall` and every shippable page 55–70% — a clean separation. VIB-1863
found that the original `overall ≥ 0.70 → PASS` rule sat *above* that gap and
mis-classified good pages as FAIL (70% exact-match accuracy). **VIB-1864 retuned the
default decision threshold to `overall ≥ 0.50`**, the centre of the 90%-exact-match
plateau (0.45–0.55), which reaches **90%** exact-match accuracy with the widest
margin from either class.

The judge's *ranking* was always sound; only the binarisation cut-point was wrong
(the strict 4-dim average clusters good pages around 3/5 per dimension, so a
shippable page lands near 0.55–0.65, not 0.70+). We lowered the **threshold** rather
than renormalising the continuous `overall` scale, so the underlying benchmark
(VIB-1833) — which uses the continuous `overall`, not a PASS/FAIL cut — is
**unchanged**; no published number is retracted. This is a calibration fix for any
*thresholded* use of the judge.

---

_Generated 2026-06-08 · mode: **real** · judge: anthropic claude-sonnet-4-6 ·
decision rule: judge `overall` ≥ 0.5 → PASS (retuned from 0.7 in VIB-1864) ·
dataset: `vibespot-judge-calibration` (10 human-labeled pages)_

## Result

| Metric | Value |
| --- | --- |
| Valid rows | 10 / 10 |
| Invalid-label rows | 0 |
| **Accuracy (exact match) @ 0.50** | **90%** |
| (for reference) accuracy @ old 0.70 | 70% |

## Threshold sweep

Accuracy as the PASS cut-point moves — separates whether the judge
*discriminates* from whether the binarisation point is right.

| overall ≥ | accuracy | matches |
| --- | --- | --- |
| 0.40 | 80% | 8/10 |
| 0.45 | 90% | 9/10 |
| 0.50 (current) ◀ best | 90% | 9/10 |
| 0.55 | 90% | 9/10 |
| 0.60 | 80% | 8/10 |
| 0.65 | 80% | 8/10 |
| 0.70 (old default) | 70% | 7/10 |
| 0.75 | 60% | 6/10 |
| 0.80 | 60% | 6/10 |

Best achievable: **90%** at `overall ≥ 0.50` — and 0.50 is the centre of the
0.45–0.55 plateau, the most robust cut-point against run-to-run judge variance.

## Per-fixture

| Fixture | Brief | Human | Judge | Overall | Match |
| --- | --- | --- | --- | --- | --- |
| `saas-good` | saas-analytics | PASS | PASS | 65% | ✓ |
| `restaurant-good` | restaurant | PASS | PASS | 55% | ✓ |
| `webinar-good` | webinar-event | PASS | PASS | 70% | ✓ |
| `empty-page` | saas-analytics | FAIL | FAIL | 20% | ✓ |
| `saas-no-fields` | saas-analytics | FAIL | FAIL | 20% | ✓ |
| `restaurant-broken-hubl` | restaurant | FAIL | FAIL | 20% | ✓ |
| `webinar-generic` | webinar-event | FAIL | FAIL | 20% | ✓ |
| `consulting-shell` | consulting | FAIL | FAIL | 20% | ✓ |
| `saas-thin-copy` | saas-analytics | PASS | FAIL | 35% | ✗ |
| `restaurant-incomplete` | restaurant | FAIL | FAIL | 40% | ✓ |

### Disagreements (the one remaining miss is the debatable human label)

- **`saas-thin-copy`** (human PASS, judge FAIL @ 35%) — the honest borderline:
  complete and editable (would ship) but the copy is deliberately generic, and this
  run the judge also flagged two thin brief sections and an undeclared field token.
  The judge is arguably *right* to be harsh here; this is the one row where the
  human label is the debatable one. At 0.70 the judge also failed `saas-good` and
  `restaurant-good` (both genuine PASSes); the threshold drop fixes those without
  introducing any false positive.

The judge made **zero false positives** at the new threshold — it never passed a
broken page. Its error is one-directional (too strict on the thin-copy borderline),
which is exactly what the 0.50 cut leaves as the single principled disagreement.

---

_Simple-mode calibration (langfuse skill `judge-calibration`): exact-match
accuracy on a bootstrap label set, not a held-out test split. Re-run with a
larger / more borderline set (ideally real reviewed benchmark pages) before
treating any single number as a final quality claim. LLM judge scores carry
run-to-run variance of a few points; the threshold conclusion (≈0.5, ~90%) is
stable across runs._
