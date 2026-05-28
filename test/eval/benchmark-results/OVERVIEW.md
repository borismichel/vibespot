# vibeSpot — model generation overview

Same brief, five models, every theme saved. Each model below generated the same landing-page brief through the vibeSpot pipeline. We kept the themes so you can open them and judge the build yourself, and we tracked the Langfuse KPIs — accuracy, cost, and latency — so the trade-offs are on the table.

_Generated 2026-05-27T22:38:54.598Z · run `combined` · mode: **real** · 2 page(s) × 5 model(s) · judge: `anthropic-api:claude-sonnet-4-6`._

## Langfuse KPIs (ranked by accuracy)

| Rank | Model | Engine | Accuracy | Validator | Coverage | Judge | Cost/page | Latency/page | Total cost |
|------|-------|--------|----------|-----------|----------|-------|-----------|--------------|------------|
| 1 | **Sonnet 4.6** | `anthropic-api:claude-sonnet-4-6` | 99% | 100% | 100% | 98% | $1.3881 | 367.9s | $2.7762 |
| 2 | **Opus 4.7** | `anthropic-api:claude-opus-4-7` | 98% | 100% | 100% | 95% | $7.7580 | 284.4s | $15.5161 |
| 3 | **GPT 5.4** | `openai-api:gpt-5.4` | 97% | 100% | 100% | 93% | $0.8317 | 269.1s | $1.6634 |
| 4 | **GPT 5.5** | `openai-api:gpt-5.5` | 96% | 100% | 100% | 90% | $3.9053 | 529.4s | $7.8105 |
| 5 | **Haiku 4.5** | `anthropic-api:claude-haiku-4-5` | 92% | 100% | 100% | 80% | $0.3894 | 115.1s | $0.7789 |

## Fidelity — saved themes

Every generation is saved under `combined/<model>/<page>/`: the importable theme (`theme/`), a standalone full-page render (`page.html`), plus per-page KPIs (`metrics.json`). Open them side by side to compare fidelity.

### SaaS analytics product landing page

**Prompt** (`saas-analytics`):

> Create a landing page for 'Pulse', a SaaS product analytics platform that helps product teams understand user behaviour without writing SQL. Include a hero with a headline, subhead and a 'Start free trial' CTA, a logo/trust bar of customer logos, a 3-up feature grid (autocapture, funnels, retention), a section with a product screenshot and supporting copy, a pricing teaser with 3 tiers, a testimonial, and a footer with newsletter signup.

_Screenshots not captured this run — open the saved render instead:_

- **Sonnet 4.6** — [`page.html`](./sonnet-4-6/saas-analytics/page.html) · [`theme/`](./sonnet-4-6/saas-analytics/theme/)
- **Opus 4.7** — [`page.html`](./opus-4-7/saas-analytics/page.html) · [`theme/`](./opus-4-7/saas-analytics/theme/)
- **GPT 5.4** — [`page.html`](./gpt-5-4/saas-analytics/page.html) · [`theme/`](./gpt-5-4/saas-analytics/theme/)
- **GPT 5.5** — [`page.html`](./gpt-5-5/saas-analytics/page.html) · [`theme/`](./gpt-5-5/saas-analytics/theme/)
- **Haiku 4.5** — [`page.html`](./haiku-4-5/saas-analytics/page.html) · [`theme/`](./haiku-4-5/saas-analytics/theme/)

| Model | Accuracy | Validator | Coverage | Judge | Cost | Latency | Modules | Langfuse trace |
|-------|----------|-----------|----------|-------|------|---------|---------|----------------|
| Sonnet 4.6 | 98% | 100% | 100% | 95% | $1.5551 | 420.4s | 7 | `553c0246-e5e8-4096-8417-09c85043fab3` |
| Opus 4.7 | 98% | 100% | 100% | 95% | $8.3817 | 323.7s | 7 | `a0a42b7d-3274-4598-85af-b3ab372bdeaa` |
| GPT 5.4 | 96% | 100% | 100% | 90% | $0.8638 | 307.1s | 7 | `8df37c9e-ad20-4170-a82c-ac700fed8cb5` |
| GPT 5.5 | 100% | 100% | 100% | 100% | $3.6724 | 510.4s | 11 | `b00595e9-bef2-452a-a31b-f21d79f2e32c` |
| Haiku 4.5 | 92% | 100% | 100% | 80% | $0.4491 | 149.7s | 7 | `61781fbd-4440-4a8e-b0b1-efe7662c269c` |

### Creative design agency / portfolio site

**Prompt** (`design-agency`):

> Build a landing page for 'Atelier Nord', a Berlin design studio specialising in brand identity and packaging. Include a bold hero with the studio name and a one-line positioning statement, an 'about' section describing the studio's approach, a portfolio grid showcasing 6 projects with images and client names, a services list (branding, packaging, art direction), a short founder bio, and a contact section with an email CTA.

_Screenshots not captured this run — open the saved render instead:_

- **Sonnet 4.6** — [`page.html`](./sonnet-4-6/design-agency/page.html) · [`theme/`](./sonnet-4-6/design-agency/theme/)
- **Opus 4.7** — [`page.html`](./opus-4-7/design-agency/page.html) · [`theme/`](./opus-4-7/design-agency/theme/)
- **GPT 5.4** — [`page.html`](./gpt-5-4/design-agency/page.html) · [`theme/`](./gpt-5-4/design-agency/theme/)
- **GPT 5.5** — [`page.html`](./gpt-5-5/design-agency/page.html) · [`theme/`](./gpt-5-5/design-agency/theme/)
- **Haiku 4.5** — [`page.html`](./haiku-4-5/design-agency/page.html) · [`theme/`](./haiku-4-5/design-agency/theme/)

| Model | Accuracy | Validator | Coverage | Judge | Cost | Latency | Modules | Langfuse trace |
|-------|----------|-----------|----------|-------|------|---------|---------|----------------|
| Sonnet 4.6 | 100% | 100% | 100% | 100% | $1.2210 | 315.3s | 6 | `75b58794-448f-4e52-bbbd-74ee041916fa` |
| Opus 4.7 | 98% | 100% | 100% | 95% | $7.1344 | 245.1s | 6 | `2ac74dbd-62da-4731-9c31-0e5908fae7d7` |
| GPT 5.4 | 98% | 100% | 100% | 95% | $0.7995 | 231.1s | 6 | `a3e0eeb2-ddf8-43d6-83a2-d0dce5197dae` |
| GPT 5.5 | 92% | 100% | 100% | 80% | $4.1381 | 548.5s | 13 | `f9064519-14cb-47fc-a7e7-394a5b44eaa3` |
| Haiku 4.5 | 92% | 100% | 100% | 80% | $0.3298 | 80.4s | 6 | `e83ca61f-d5dd-402c-9636-6e2471e521ec` |

## How this was measured

- **Accuracy** = 0.40·validator-pass-rate + 0.20·coverage + 0.40·judge (0.65 / 0.35 without a judge).
- **Validator**: share of raw modules (pre auto-fix) with no unfixable issues, via the shipped `stages/validator.ts`.
- **Coverage**: share of the brief's expected sections present in the output.
- **Judge**: LLM-as-judge over brief-coverage / layout / content / HubSpot-correctness on the shipped page.
- **Cost**: every model call's estimated USD via the shipped `computeCost`, captured through the `onModelUsage` hook. Judge cost excluded.
- **Latency**: end-to-end pipeline wall-clock per page.
- **Fidelity**: judge it yourself from the saved themes and renders. Numbers rank correctness and cost; they do not rank taste.
- **Langfuse**: every generation is a trace (id in the per-page tables). Dataset `vibespot-module-eval`; each generation's session is `eval-<model>-<page>` — open it in Langfuse to see the per-stage spans, token usage, and cost roll-up.

## Notes

- Merged 6 record(s) from DIRTY-RUN-openai-quota-failed-2026-05-27T19-58.
- Merged 4 record(s) from 2026-05-27T21-57-01-829Z.
