# Changelog

All notable changes to vibeSpot are documented here.

---

## Unreleased

### Added

- **Azure Entra (Entra ID) SSO gate for hosted deployments** ([VIB-1871](/VIB/issues/VIB-1871)) — the compose bundle already shipped a disabled `oauth2-proxy` placeholder ([VIB-450](/VIB/issues/VIB-450)) but enabling the `auth` profile alone never gated traffic, because Caddy's `VIBESPOT_UPSTREAM` still defaulted straight to `vibespot:4200`. Made the gate real for Entra and put it in the request path: a new `docker-compose.auth.yml` overlay re-points Caddy at `oauth2-proxy:4180` (request path becomes **Caddy → oauth2-proxy (Entra OIDC) → vibespot**), and the `oauth2-proxy` service is configured for Entra — `provider=oidc`, tenant-scoped issuer (`https://login.microsoftonline.com/<TENANT_ID>/v2.0`), client id/secret, redirect URL, cookie secret, and `OAUTH2_PROXY_REVERSE_PROXY` so the login redirect is built with the public https scheme behind TLS-terminating Caddy. The chat **WebSocket** upgrade (and its auth cookie) is proxied through (`OAUTH2_PROXY_PROXY_WEBSOCKETS=true`) so vibe coding works end-to-end behind the gate, and `/healthz` is left unauthenticated (`OAUTH2_PROXY_SKIP_AUTH_ROUTES`) so external monitors get `200`, not a 302. `OAUTH2_PROXY_EMAIL_DOMAINS` now **defaults empty (fail closed)** instead of `*` — set it to your org domain to filter which tenant users get in. Enable with `docker compose --profile auth -f docker-compose.yml -f docker-compose.auth.yml up -d`; every Entra var is documented in `.env.example` and `docs/docker-deployment.md`. **Opt-in only** — the default `docker compose up` behaviour is unchanged and ungated. Gate only; no per-theme isolation yet (a later, prepared-for step under [VIB-1870](/VIB/issues/VIB-1870)).

---

## 1.6.5 — 2026-06-08

### Added

- **Eval LLM-judge is now calibrated against human ground truth** ([VIB-1863](/VIB/issues/VIB-1863)) — the benchmark numbers ([VIB-1833](/VIB/issues/VIB-1833)) lean on the eval LLM-as-judge (`test/eval/judge.ts`), but the judge had never been validated against human labels (the langfuse-skill `judge-calibration` reference's main critique, found on [VIB-1860](/VIB/issues/VIB-1860)). Added a **simple-mode calibration harness**: `test/eval/calibration-set.ts` holds a small set of pages with **human PASS/FAIL labels** (hand-authored so the correct label is unambiguous — clearly-shippable vs clearly-broken, plus two borderline probes), and `npm run eval:calibrate` (`test/eval/calibrate-judge.ts`) runs the judge over each page (never showing it the label), binarises the judge's `overall` via a `--threshold` (default 0.70), and reports **valid rows / invalid-label count / exact-match accuracy** + a **threshold sweep** + a ship/retune/iterate recommendation. With `--langfuse` it registers a `vibespot-judge-calibration` dataset experiment and pushes `judge-exact-match` (per row) + `judge-accuracy` (run aggregate) via the existing direct-REST score path (`langfuse-dataset.ts`). **First result (Sonnet 4.6 judge):** 70% exact-match at the default 0.70 threshold — the judge *discriminates* cleanly (every FAIL page scores ≤40%, every shippable page 55–70%) but the cut-point is set too high, flipping good pages to FAIL; re-binarising at `overall ≥ 0.5` recovers **90%**. Recommendation: lower the judge PASS threshold (or normalise its 4-dim scale) before leaning further on judge-based benchmarks. Committed sample: `test/eval/JUDGE-CALIBRATION.md`.

### Fixes

- **Cleared all 28 pre-existing `tsc --noEmit` type errors + restored PDF brand-asset upload** ([VIB-1865](/VIB/issues/VIB-1865)) — QA found that `npx tsc --noEmit` reported 28 errors on `main`: `tsup` only transpiles (it never type-checks) and CI is off, so the type drift had accumulated unnoticed. Triaged and fixed across four areas — Figma-import route ([VIB-1866](/VIB/issues/VIB-1866), 12), agent site/multi-page pipeline ([VIB-1867](/VIB/issues/VIB-1867), 6), storage `SessionIndexEntry` ([VIB-1868](/VIB/issues/VIB-1868), 3), and misc dependency drift ([VIB-1869](/VIB/issues/VIB-1869), 7). Most were annotation/type-shape corrections, but two were **real runtime bugs**: (1) `pdf-parse` had been upgraded to v2.4.5, which dropped the `default` function export in favour of a `PDFParse` class — the PDF text-extraction path (brand-asset upload) would have thrown at runtime; rewritten to the new `new PDFParse({ data }).getText()` API. (2) the wizard's `createEngine` switch was non-exhaustive over `AIEngineType` and silently returned `undefined` for the migrated `anthropic-api` config value — now handles it (plus `claude-oauth`) and throws a clear error for unsupported engines. Other fixes: `execSync` results are `toString()`-ed before `trim()` (return type is `string | Buffer`), `@clack/prompts` `validate`/`Option<T>` signatures adapted to the upgraded types, and `listDirectory` filters bare-string children to honour its `FileMetadata[]` contract. The project now type-checks clean (`0` errors); build and runtime spot-checks pass.
- **Eval judge PASS threshold retuned to where the judge actually separates good from bad** ([VIB-1864](/VIB/issues/VIB-1864)) — the calibration shipped in [VIB-1863](/VIB/issues/VIB-1863) found the eval LLM-judge (Sonnet 4.6) discriminates cleanly (every FAIL page ≤40% `overall`, every shippable page 55–70%) but the default `overall ≥ 0.70 → PASS` cut-point sat *above* that gap, flipping good pages to FAIL — 70% exact-match accuracy vs human labels. Lowered the default decision threshold in `test/eval/calibrate-judge.ts` to `overall ≥ 0.50`, the centre of the 90%-exact-match plateau (0.45–0.55), which recovers **90%** exact-match accuracy with the widest margin from either class (confirmed by a fresh `npm run eval:calibrate -- --judge=anthropic` run). We retuned the **threshold**, not the continuous `overall` scale, so the benchmark ([VIB-1833](/VIB/issues/VIB-1833)) — which uses the continuous `overall`, not a PASS/FAIL cut — is unchanged and no published number is retracted. Updated `test/eval/JUDGE-CALIBRATION.md` + `test/eval/README.md`.
- **Langfuse traces now show a result preview, and generations carry full model I/O** ([VIB-1862](/VIB/issues/VIB-1862)) — `runWithTrace` set the trace *input* but never an *output*, so every `agent_pipeline` / `figma_import` trace showed an empty result in the Langfuse Traces list (found by the langfuse-skill evaluation on [VIB-1860]). Added `setTraceOutput()` in `src/server/langfuse.ts` — it reads the active trace from the ALS scope and emits a second `trace-create` for the same trace id carrying only the output (traces are id-keyed and upserted by the ingestion API, so Langfuse merges it onto the existing trace), truncated like every other field and a no-op when Langfuse is disabled or there's no active trace. The pipeline handlers (`ai-handler.ts`) call it at the end of each run with a compact `summarizePipelineOutput()` — module names + count, module order, stats, page ids (multi-page), and the assistant message — instead of dumping the full generated code. A trace now reads `input → stage spans → N generations → output`. Separately, **API-engine generations now record the full SDK input and output**: they always carried the real system prompt + messages and the real completion, but the shared 24 KB field cap clipped guide-laden prompts and large module JSON. Generation payloads now use a much larger `MAX_GENERATION_FIELD_CHARS` (200 KB), so each API call's prompt and response are captured effectively in full in Langfuse, while the trace/span summaries keep the tight 24 KB cap. (CLI engines still report no usage, so no generation I/O — tracked by [VIB-1850](/VIB/issues/VIB-1850).)
- **Generations now link to their managed prompt** ([VIB-1861](/VIB/issues/VIB-1861)) — every generation in production traces showed `prompt: -` (unlinked) even though we ship managed stage prompts (`vibespot-stage-*`, [VIB-1853]) and full generation tracing — `recordGeneration` never set `promptName`/`promptVersion` on the generation body (found by the langfuse-skill evaluation on [VIB-1860]). Added `stagePromptLink(id)` to the stage-prompt registry, which surfaces the active prompt's Langfuse name (`vibespot-stage-{id}`) + pinned version (valid whether the bundle or the local fallback is active, since the bundle is only accepted at the matching version). The five registry-managed stages (intent-analyzer, design-system, module-planner, site-module-planner, module-developer) thread that link through `AgentCallOptions.prompt` → `reportModelUsage` → `recordGeneration`, which now emits `promptName`/`promptVersion` (and `promptSource` in metadata) on the generation. Linkage is attached only on the registry-managed page path — the email/blog variants use non-registry builders and stay unlinked. Unlocks per-prompt-version cost/latency/quality breakdowns in the Langfuse UI.

## 1.6.4 — 2026-06-03

### Fixes

- **Claude Opus 4.8 missing from the model dropdown** ([VIB-1859](/VIB/issues/VIB-1859)) — the model picker is seeded from a curated static list, and that list had never been updated past Opus 4.7, so `claude-opus-4-8` (a released model — the one the benchmark already covers) couldn't be selected. Added Opus 4.8 to the curated lists for the Claude Code, Anthropic API, Claude OAuth, and Langdock (Anthropic provider) engines, in both the server catalog (`src/server/routes/settings.ts`) and the client fallback (`ui/settings.js`). The reporter also noticed that **Refresh** appeared to do nothing for the Claude Code engine — that was real: `getModelCatalog` only fetched live model lists for the API engines (Anthropic / OpenAI / Gemini, each gated on an API key) and **never** for `claude-code`, which was always served from the static list. Claude Code runs the same Claude model family, so it now inherits the live Anthropic `/v1/models` catalog whenever an Anthropic API key is configured — so a future model release shows up on **Refresh** without a code change. (Cost tracking already prefix-matches `claude-opus-4`, so no pricing-table change was needed.)

## 1.6.3 — 2026-06-03

### Fixes

- **Isolate the spawned Claude Code CLI context — fix recurring "Prompt is too long"** ([VIB-1855](/VIB/issues/VIB-1855)) — when the Claude Code engine is selected, vibeSpot spawns `claude --print` for each generation. It did so with **zero isolation**, so the CLI loaded the user's own MCP servers (unbounded tool schemas) and any ambient project `CLAUDE.md` on top of our ~30–40k-token payload — overflowing the 200k context window and surfacing the raw API string `Error: claude exited with code 1. Output: Prompt is too long` on every generation, even for short requests (root cause analysed in [VIB-1854](/VIB/issues/VIB-1854)). Three changes: (1) **context isolation** — every `claude` spawn now passes `--strict-mcp-config` (use zero MCP servers, ignoring the user's configs) and runs in a dedicated empty temp `cwd` (`getIsolatedClaudeCwd`) so the CLI can't discover an ambient project `CLAUDE.md` / `.mcp.json`; vibeSpot now owns the whole window. Applied on both the agentic pipeline (`engine-adapter.ts` → `resolveCLIBinary`) and the legacy single-call path (`ai-engines.ts` → `generateWithClaudeCode`). (2) **Page-state token budget** — `buildStateContext` now clamps each injected module source and degrades to a name-only summary once the assembled state crosses a ~50k-token budget, so a large imported theme can't overflow the window on its own. (3) **Friendly error** — the raw "Prompt is too long" string is mapped (`mapClaudeCliError`) to an actionable message pointing to fixes (trim large modules, fresh theme, or switch to the isolated Anthropic API engine). New unit tests in `test/cli-isolation.test.ts`, plus a live-CLI integration test (`test/cli-isolation.integration.mts`, manual) that plants a poison project `CLAUDE.md` and proves plain `claude --print` reads it while our isolated spawn does not.

## 1.6.2 — 2026-06-01

### Features

- **Download theme as a HubSpot-ready .zip** ([VIB-1851](/VIB/issues/VIB-1851)) — the editor topbar gains a **Download** button (next to **Deploy**) that saves the active theme as a `.zip` you can import straight into HubSpot Design Manager, share with a colleague, or back up outside git. It's disabled until the theme has at least one module. The download route (`GET /api/download-zip`) now builds the archive in-process with `jszip` instead of shelling out to the system `zip` binary, so it works on environments without `zip` installed (notably Windows `npx` users) — `.git`, `.vibespot`, and `node_modules` are excluded as before.

### Changed

- **Stage prompts v2 — quality lift across the pipeline** ([VIB-1853](/VIB/issues/VIB-1853)) — bumped all five managed stage-instruction prompts from v1 → v2 (pinned version, re-seeded bundle, regenerated golden snapshot, pushed to Langfuse). The structural contract (placeholders, output schemas, reserved-field / module-name-verbatim rules) is unchanged; v2 raises the quality bar on top. Highlights: **design-system** now commits to a deliberate visual direction with WCAG-AA-contrast palettes, a modular type scale, an 8pt spacing system, layered shadows, motion + `prefers-reduced-motion`, and `:focus-visible` a11y; **module-developer** demands real benefit-led default copy (no lorem), accessible semantic markup, hover/focus states, and — tying into [VIB-1842](/VIB/issues/VIB-1842) — **complete defaults on every style/color field** so rendered CSS can't collapse to invalid `rgba(…, )`; **module-planner / site-module-planner** push a persuasive narrative arc (attention → value → proof → objection → CTA), specific conversion-led briefs, and cross-page coherence; **intent-analyzer** surfaces the inferred brief (audience / goal / tone), plans conversion-complete pages, and drops a duplicate section. Validated hands-on on the dev deployment before shipping; v1 is preserved in Langfuse (version 1) and git history for rollback.

- **Benchmark: added an Opus 4.8 pass** ([VIB-1833](/VIB/issues/VIB-1833)) — the model generation overview now covers six models. Opus 4.8 (`claude-opus-4-8`) scores 97% mean accuracy at ~$6.50/page with zero invalid-CSS modules — matching Opus 4.7's quality a bit cheaper and faster. Refreshed `test/eval/benchmark-results/` and the README "How the models compare" table; full themes + screenshots + Langfuse trace ids are attached to the issue.

### Docs

- **Document Langfuse setup in the in-app docs** ([VIB-1846](/VIB/issues/VIB-1846)) — `ui/docs` gains an **Observability & Cost** section covering the always-on per-page cost line and the opt-in Langfuse tracing flow: what a trace captures, the `trace → stage spans → generations` data model (session = theme name), how to **stand up a Langfuse instance** (Langfuse Cloud EU/US sign-up, or a local self-host via `docker compose up` on `http://localhost:3000`, with a pointer to the production self-hosting guide), how to **connect vibeSpot** (Settings → AI tab → Observability, plus the config-file and `LANGFUSE_*` env equivalents), the both-keys-and-explicit-opt-in rule, and what is/isn't sent (API engines only, truncated payloads, fail-safe on outage). Adds the `langfuse*` config fields and `LANGFUSE_*` env vars to the reference tables and a cross-reference from the AI Settings tab.

### Fixes

- **Publish stage prompts to Langfuse (`prompts:push`)** ([VIB-1853](/VIB/issues/VIB-1853)) — the managed-prompt flow bakes prompts into the shipped bundle *from* Langfuse at build, but it only ever **read** from Langfuse; nothing published the prompts up, so a project's **Prompts** tab stayed empty even with tracing on ("we bake prompts at deploy, but I can't see them in Langfuse"). Added `npm run prompts:push` (`scripts/sync-prompts.ts --push`): it creates each `vibespot-stage-{id}` in Langfuse Prompt Management from the in-code local fallback at its pinned version (`production` label) via `POST /api/public/v2/prompts`, and is idempotent (skips a stage already at that version; `--dry-run` supported). This completes the round-trip — **push once → edit in the Langfuse UI → `prompts:pull` bakes the edits into the bundle at build**. Seeds all five stage prompts (intent-analyzer, design-system, module-planner, site-module-planner, module-developer). Clarified the one-directional design in `CLAUDE.md`.
- **Catch invalid-CSS / unstyled-section defects** ([VIB-1842](/VIB/issues/VIB-1842)) — the benchmark scored GPT-5.4/5.5 pages high (96–97% accuracy, judge 90–93%) while they shipped visibly broken: those models build section colors from style fields with no defaults via `rgba({{ module.styles.X.color|convert_rgb }}, {{ module.styles.X.opacity/100 }})`, which renders to invalid CSS like `rgba(15, 17, 21, )` (missing opacity) so the browser drops the declaration and the section loses its background/borders. Tag-balance validation and the code-reading judge both missed it because neither inspected the *rendered* output. Two changes: (1) the HubL preview renderer now implements the `convert_rgb` filter (hex / color-field object → `r, g, b`) and the `opacity/100` arithmetic idiom, so defaulted colors render faithfully (matching HubSpot) and undefaulted ones collapse to empty; (2) the quality-check validator (`stages/validator.ts`) now renders each module with its field defaults and flags any color function with an empty component as an `invalid-css` issue. This is surfaced as a `⚠` warning in the quality check and as a distinct eval axis (`scoring.ts` → `invalidCssModules`, shown in the provider-comparison report) that docks pass-rate — models that hard-code or fall back their colors score `0`. Under `--langfuse` both eval harnesses also push it as a dedicated `invalid_css_modules` Langfuse score (alongside accuracy / validator-pass-rate / coverage / judge / cost / latency), so it's visible per-run in the Langfuse experiment. Follow-ups (separate issues): an optional quality-check auto-fix that injects sensible style-field defaults, and an optional vision judge over the captured screenshots.

### Dependencies

- Bumped `@anthropic-ai/sdk` 0.96 → 0.99, plus `marked` and `ws` (production), and `@types/node` / `tsx` / `vitest` (dev), via Dependabot. CI workflow `docker/metadata-action` 5 → 6.

## 1.6.0 — 2026-05-28

### Changed

- **Langfuse is off by default** ([VIB-1833](/VIB/issues/VIB-1833)) — tracing is now an explicit opt-in rather than auto-on when keys are present. Traces are sent only when `langfuseEnabled` is true (in `~/.vibespot/config.json`, via the AI Settings **Observability** toggle, or `LANGFUSE_ENABLED=true`) **and** both keys are set. A stray `LANGFUSE_*` in a user's environment no longer silently sends traces on `npx vibespot`. The eval harness's `--langfuse` flag sets `LANGFUSE_ENABLED=true` for that run, so `npm run eval`/`npm run benchmark` are unaffected.

### Features

- **Persistent-theme benchmark + model generation overview** ([VIB-1833](/VIB/issues/VIB-1833)) — `npm run benchmark` compares models on the same brief, **keeps every generated theme** for fidelity comparison, and tracks Langfuse KPIs (accuracy / cost / latency / judge) plus the per-generation trace id and session id. Unlike the in-memory provider-comparison harness, it persists each theme (importable HubSpot layout + standalone `page.html` + `metrics.json`) and writes a brand-compliant `OVERVIEW.md` (KPI table + fidelity gallery + the generating prompt per page). Models are explicit `engine:model[:label]` triples, so several models from one provider are first-class. Screenshots are best-effort via a dynamically-imported headless browser (`screenshot-dir.ts` backfills PNGs; `VIBESPOT_SHOT_CHROMIUM` points at an existing Chromium when the pinned build can't be downloaded); a partial run can be completed and combined with `merge-runs.ts` without re-spending the valid half. The first 5-model run (Haiku 4.5 / Sonnet 4.6 / Opus 4.7 / GPT 5.4 / GPT 5.5 across two pages) ships its lightweight overview under `test/eval/benchmark-results/`, with the README gaining a "How the models compare" section. Internal dev/CI tooling — not shipped to end users.
- **Langfuse instrumentation (opt-in)** ([VIB-1764](/VIB/issues/VIB-1764)) — the agentic pipeline now captures token usage and estimated USD cost from every API model call (Anthropic, OpenAI, Gemini, Langdock), which were previously discarded. Usage/cost is logged locally (`agent-usage`) regardless of configuration. When Langfuse keys are configured (`langfusePublicKey` / `langfuseSecretKey` in `~/.vibespot/config.json`, or `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` env), each user message is traced as one Langfuse trace with a child generation per pipeline stage — so a full page shows up as a single trace with its total token cost. Implemented as a dependency-free client against Langfuse's ingestion API (no SDK added to the bundle); fully opt-in and fail-safe (a Langfuse outage never blocks or fails a generation). CLI engines (Claude Code / Gemini / Codex) report no token usage, so cost is captured only for API-key engines.
- **Langfuse config in AI Settings UI** ([VIB-1771](/VIB/issues/VIB-1771)) — Langfuse can now be configured from the AI Settings panel's new Observability section instead of hand-editing `~/.vibespot/config.json` or setting `LANGFUSE_*` env vars. Adds masked public/secret key fields (using the same save/clear flow as other provider keys), a base-URL field with EU/US/self-host guidance, and an enable toggle. Existing config-file and env-var behavior is unchanged — env still folds into config on load. (The enable rule later changed to explicit opt-in — see "Langfuse is off by default" above.)
- **Full instrumentation coverage + nested traces** ([VIB-1767](/VIB/issues/VIB-1767)) — extends Phase 1 in two ways. **Coverage:** the AI paths that bypassed the agentic-pipeline chokepoint now report token usage too — the single-call streaming chat engines (`streamWith{Anthropic,OpenAI,Gemini,ClaudeOAuth}`), AI design/styleguide extraction (`extractDesignContext`), and the legacy React→HubSpot converter — via a single shared `reportModelUsage` helper plus provider usage mappers (`mapAnthropicUsage` / `mapOpenAIUsage` / `mapGeminiUsage`) reused everywhere. **Nesting:** a new `runWithSpan()` adds a Langfuse span per pipeline stage (intent → design → planner → module-development), and every model call nests under its stage span via `parentObservationId`. The parallel module-development stage's N calls (plus retries) roll up under one span, so a page trace reads `trace → stages → N module generations` with cost rolling up at each level. Brand-asset extraction (styleguide / brand voice / theme context) and Figma import now open their own traces grouped by theme (`sessionId = themeName`) instead of emitting orphan traces. Still opt-in and fail-safe; CLI engines still report no usage.
- **Per-page generation cost in the UI** ([VIB-1770](/VIB/issues/VIB-1770)) — after each generation the chat shows an estimated cost line (e.g. `Est. $0.04 · 48.2K tokens`) on that message, and a running per-project total chip (`Σ $0.21`) in the chat header. The figure aggregates the token usage already captured by the instrumentation through the shared `reportModelUsage` chokepoint, priced with the same `computeCost()` table — so it works with **no Langfuse keys configured**, in the plain local-CLI model. A new `cost-tracker.ts` opens an `AsyncLocalStorage` scope per generation (one user action) that sums every model call, including the parallel module-development calls. The per-page cost persists on the chat message (re-rendered from history) and the project total persists on the session. Costs that include an unpriced model (unknown to the price table) are shown as a lower bound (`≥`). CLI engines report no usage, so no cost is shown for them. This is cost **visibility** only — billing, credits, and quotas remain out of scope (they depend on a hosted-platform decision).
- **Langfuse-managed stage prompts (bundle-at-build)** ([VIB-1769](/VIB/issues/VIB-1769)) — Langfuse Phase 3. The editable stage *instruction* prompts (intent-analyzer, design-system, module-planner, site-module-planner, module-developer) are now sourced through a version-pinned registry (`src/server/agent/prompts/registry.ts`) instead of inline template literals. Prompts can be authored/versioned in Langfuse and compiled into the shipped package at **build time** (`npm run prompts:pull` → `assets/prompts.bundle.json`); at runtime the registry reads that bundle and otherwise renders a guaranteed in-code local fallback (`managed/local-prompts.ts`). Nothing fetches Langfuse at runtime, so a Langfuse outage can never change generation behavior — it only affects the next build's bundle. A bundle entry is used only when its version matches the pin and it references no placeholder outside the stage's allow-list; substitution of the controlled `{{placeholder}}` values is single-pass (no untrusted interpolation, no re-expansion). The large static `.md` guides are deliberately left as cached file blocks. The externalization is byte-identical to the previous prompts, guarded by a golden snapshot test (`test/prompt-registry.test.ts`).

### Tooling

- **Provider-comparison eval harness** ([VIB-1768](/VIB/issues/VIB-1768)) — Langfuse Phase 2. A dataset-driven harness (`npm run eval`, `test/eval/`) that compares model providers (Anthropic / OpenAI / Gemini / Langdock) on vibeSpot module generation across a dataset of reference landing-page briefs, scoring **accuracy** (rule-based `validator.ts` pass-rate on raw output + structural coverage + an LLM-as-judge), **cost** (the shipped `computeCost`, captured via a new `onModelUsage` hook), and **latency** per provider, ranked into a markdown + JSON comparison. With `--langfuse` it registers the run as a Langfuse experiment (dataset + dataset-run-items + scores). Internal dev/CI tooling — not shipped to end users and not gated on the deployment-model decision. Runs offline in a deterministic mock mode (no API keys needed) so it works in CI; `--providers=…` runs the real comparison. Adds a small, production-safe `onModelUsage` observer to `src/server/langfuse.ts` (no listener = no-op).

### Fixes

- **OpenAI GPT-5 support in the agentic engine** ([VIB-1832](/VIB/issues/VIB-1832)) — the OpenAI adapter (`callOpenAI`) now sends `max_completion_tokens` instead of the legacy `max_tokens` (GPT-5 models reject `max_tokens` with a 400; the new key is also accepted by gpt-4o / gpt-4.1, so it is safe for all OpenAI chat models) and requests structured output with `strict: false` (our JSON schemas are authored for Anthropic tool_use and use keywords — `pattern`, `format`, `minimum`, `default`, partial `required` — that OpenAI's strict mode rejects; non-strict mode still does schema-guided generation and the pipeline parses defensively). Adds approximate GPT-5 family pricing (`gpt-5.3` / `gpt-5.4` / `gpt-5.5`) to `pricing.ts` so cost capture works. Without these, every OpenAI GPT-5 generation failed. Surfaced while backfilling the provider-comparison eval (numbers in `test/eval/PROVIDER-COMPARISON.md`).
- **Settings panel no longer times out on open** ([VIB-1834](/VIB/issues/VIB-1834), [VIB-1835](/VIB/issues/VIB-1835)) — the AI Settings panel could fail with "Settings took too long to load" because `GET /api/settings/status` did everything synchronously on every open: ~7+ detection subprocesses (including the networked `gh auth status` / `hs accounts list` probes) plus live model-catalog HTTP calls to each configured provider, while the client aborted at 3s. `/status` is now config-only and side-effect-free — no subprocess, no network — so it returns in single-digit ms with the static model list inline (dropdowns populate instantly) and tool/auth state marked "not scanned". The expensive work moved to two on-demand routes: `GET /api/settings/models?refresh=1` (live provider catalog, 10-min cache) and `GET /api/settings/tools?group=ai|platform|all&refresh=1` (CLI/auth detection, ~4s per-probe timeout, ~60s cache). The panel shows per-tab **Refresh models** / **Scan AI tools** / **Check** buttons and runs one non-blocking background scan on first open to fill in tool status without making you click. Supersedes the interim timeout hardening in PR #170, which is folded in here — provider fetches and auth probes are still individually bounded so the on-demand routes can't hang either.
- **OpenAI/Gemini cache-token double-count** ([VIB-1766](/VIB/issues/VIB-1766)) — OpenAI and Gemini fold cached tokens into their prompt count (`prompt_tokens` / `promptTokenCount`), but the engine adapter also reported them separately as `cacheReadTokens`. This made `computeCost()` bill cached tokens twice (full input rate *plus* cache-read rate) and emit overlapping `input` + `cache_read_input_tokens` to Langfuse. The OpenAI/Gemini adapters now subtract cached tokens out of the reported input count, matching Anthropic's already-correct separated semantics; `totalTokens` is unchanged. Small cost over-estimate only; the default Anthropic engine was never affected.

---

## v1.5.1 — 2026-05-20

### Features

- **Langdock multi-provider support** ([VIB-1756](/VIB/issues/VIB-1756)) — Langdock now supports all four upstream providers: Anthropic (Claude), OpenAI (GPT), Google (Gemini), and Mistral. A new provider dropdown in AI Settings lets users switch providers; the model dropdown updates per-provider with the correct model list. AI Capabilities (extended thinking, prompt caching, web search) adapt to the selected provider. Also fixed streaming chat support for Langdock which was missing entirely.

### Documentation

- **Self-contained Docker deployment guides** — rewrote `docs/docker-deployment.md`, `docs/docker-langdock-deployment.md`, and the Docker Deployment section of the in-app docs (`ui/docs/index.html`) to work from the public GHCR image alone (repo is private, package is public). Removed `git clone` / `cp .env.example` steps in favour of copy-paste `docker run`, `docker-compose.yml`, `Caddyfile`, and `.env` blocks. Corrected inaccuracies that affected users: themes persist at `/home/vibespot/vibespot-themes` (not the unused `/workspace` mount); `VIBESPOT_STORAGE=postgres` is a no-op (the Postgres adapter is not wired into the container startup path) so persistence is filesystem-only; the in-app `docker compose --profile https` step referenced a non-existent profile; and the "Full guide" link pointed at a private-repo blob (404 for end users). Added image tag table, upgrade steps, version-pinning guidance, and GHCR to the firewall allowlist.

---

## v1.5.0 — 2026-05-19

### Features

- **Langdock in AI Settings UI** ([VIB-1742](/VIB/issues/VIB-1742)) — Langdock is now selectable directly from the AI Settings panel in the web UI, making it easy to switch to the EU-hosted engine without editing config files.

### Removed

- **Single-file binary distribution** ([VIB-451](/VIB/issues/VIB-451)) — the `bun --compile` binaries (macOS arm64/x64, Linux x64/arm64, Windows x64) and the macOS `.app` bundle introduced in v1.4.0–v1.4.2 are withdrawn. vibespot is a long-running local server backing a browser-based UI, not a Finder/Explorer-clickable desktop app, so packaging it as a bare executable or a `.app` didn't actually improve the experience over Docker. **Docker is now the only no-Node distribution path** — see [docs/docker.md](docs/docker.md). The `binaries.yml` workflow, `scripts/build-binaries.ts`, `scripts/build-macos-app.ts`, `scripts/install.sh`, the `bin/vibespot-bun-entry.ts` runtime entry, the `assets/icon/` set, and the related runtime-root resolver are all removed. The v1.4.0–v1.4.2 git tags still exist (Docker images at `ghcr.io/borismichel/vibespot:1.4.{0,1,2}` continue to work); the binary GitHub Release assets may be deleted separately on request.

### Documentation

- **Docker + Langdock deployment guide** ([VIB-1747](/VIB/issues/VIB-1747)) — New one-page technical reference at `docs/docker-langdock-deployment.md` covering Docker deployment with Langdock as the AI engine: architecture diagram, how Langdock is consumed (Anthropic-compatible proxy, Frankfurt), minimal network requirements (outbound HTTPS to `api.langdock.com` + `api.hubapi.com` only), env var reference, compose services, firewall rules, and troubleshooting. Also added `LANGDOCK_API_KEY`, `LANGDOCK_BASE_URL`, `VIBESPOT_AI_ENGINE`, and `HUBSPOT_PERSONAL_ACCESS_KEY` to `docker-compose.yml` environment block.
- **Langdock support in docs** ([VIB-1744](/VIB/issues/VIB-1744)) — Added Langdock to the AI engines comparison table, setup tabs, and config reference in `ui/docs/index.html`. Updated README AI engines table, config section, and aiEngine enum. Langdock setup instructions cover API key configuration, model selection, and self-hosted `langdockBaseUrl` override.
- **Docker deployment docs** ([VIB-1739](/VIB/issues/VIB-1739)) — Added Docker Deployment section to README with quick-start commands. Added Docker Deployment section to `ui/docs/index.html` with quick start, HTTPS, env vars, persistence, and reverse proxy guidance. Expanded environment variables table in docs with all Docker and integration variables. Added comprehensive deployment guide at `docs/docker-deployment.md` covering LAN, HTTPS, nginx, Kubernetes, backup/restore, and security.

---

## v1.4.2 — 2026-05-13

### Packaging

- **macOS `.app` bundle** ([VIB-451](/VIB/issues/VIB-451)) — every release now also publishes `vibeSpot-macos.app.zip`, a Finder-friendly universal `.app` bundle with the vibeSpot icon. The binary inside is a **fat Mach-O fused with `lipo`** (arm64 + x86_64), so the same `.app` runs natively on Apple Silicon and Intel Macs. Double-clicking the `.app` launches vibespot in the background (`LSUIElement=true`) and opens the browser; stop it via Activity Monitor. The bundle is ad-hoc signed only — proper Developer ID signing + notarization remains deferred per [VIB-446](/VIB/issues/VIB-446). New `scripts/build-macos-app.ts` orchestrates `lipo` + Info.plist + `ditto` zipping; new `assets/icon/vibespot.icns` (multi-resolution ICNS generated from the source PNG) provides the macOS icon. The `binaries.yml` workflow gains a `package-macos-app` job that runs on `macos-14` after the matrix, smoke-tests the bundled binary against `/healthz`, and uploads the asset to the GitHub Release on tag.

---

## v1.4.1 — 2026-05-13

### Packaging

- **Windows binary now carries the vibeSpot icon and PE metadata** ([VIB-451](/VIB/issues/VIB-451)) — `vibespot-windows-x64.exe` is built with `--windows-icon` plus product / publisher / version / description / copyright resources, so the executable shows the brand mark in Explorer and the taskbar and exposes proper metadata in the file Properties dialog. Source asset: `assets/icon/vibespot.png` (512×512); compiled multi-resolution container: `assets/icon/vibespot.ico` (16/32/48/64/128/256). macOS Mach-O and Linux ELF binaries can't carry icons natively — those still need `.app` / `.desktop` wrappers, deferred per [VIB-446](/VIB/issues/VIB-446).
- **CI runner fix** ([VIB-451](/VIB/issues/VIB-451)) — `binaries.yml` builds `darwin-x64` on `macos-14` (Apple Silicon, cross-compile) instead of the starved `macos-13` hosted pool. The native smoke check is skipped for the cross-compiled target.

---

## v1.4.0 — 2026-05-13

### Features

- **Cross-platform single-file binaries** ([VIB-451](/VIB/issues/VIB-451)) — vibespot now publishes standalone executables for macOS (arm64/x64), Linux (x64/arm64), and Windows (x64) on every tagged release, built with `bun build --compile`. Binaries embed the Bun runtime plus all packaged assets (UI, starters, plan templates, guides, CHANGELOG) and self-extract to `~/.vibespot/runtime-assets/<version>/` on first run. A `curl | bash` install script (`scripts/install.sh`) detects the host platform and drops the binary into `/usr/local/bin`. New `binaries.yml` workflow matrix-builds on each tag, runs a `--version` + `/healthz` smoke test, and uploads each binary as a Release asset. See [docs/install.md](docs/install.md). Parent: [VIB-446](/VIB/issues/VIB-446).
- **Docker image + compose bundle** ([VIB-450](/VIB/issues/VIB-450)) — vibespot now ships as a multi-stage `node:22-alpine` Docker image published to GHCR (`ghcr.io/borismichel/vibespot`) for `linux/amd64` and `linux/arm64`. A `docker-compose.yml` bundles the app with Caddy (TLS + reverse proxy), Postgres (for the hosted storage adapter), and an `oauth2-proxy` slot for the upcoming auth gate. New `/healthz` endpoint backs the container `HEALTHCHECK` and the CI smoke test. `.env.example` documents every supported env var. See [docs/docker.md](docs/docker.md) for the full guide. Parent: [VIB-446](/VIB/issues/VIB-446).
- **Langdock EU-hosted AI adapter** ([VIB-446](/VIB/issues/VIB-446)) — Adds Langdock as a first-class engine option, a German-hosted (Frankfurt) AI gateway with a GDPR-native AVV/DPA covering OpenAI, Anthropic, Mistral, and Google models behind a single contract. Routes Claude through Langdock's Anthropic-compatible endpoint so prompt caching, tool-use structured output, and extended thinking work unchanged. Configurable `langdockBaseUrl` for self-hosted / private-cloud installs. Useful for EU customers who need data residency without negotiating one DPA per model provider.

---

## v1.3.1 — 2026-05-07

### Features

- **Project overview table** ([VIB-326](/VIB/issues/VIB-326)) — Project Home now shows a sortable table with columns for Name, Pages, Emails, Modules, and Brand Assets. Replaces the card-based "View All" list with a scannable overview that surfaces project health at a glance.
- **Bulk operations** ([VIB-326](/VIB/issues/VIB-326)) — Select multiple projects via checkboxes and apply bulk actions: Duplicate or Delete. A floating toolbar shows the selection count and action buttons. Bulk delete includes a file-deletion confirmation dialog.
- **Email client preview** — Preview email templates as they render in Gmail, Outlook Desktop, and Apple Mail. Tab-based overlay applies client-specific heuristics and shows rendering notes per client.

### Fixes

- **Pipeline robustness** ([VIB-325](/VIB/issues/VIB-325)) — Modules with broken `fieldsJson` are now auto-regenerated instead of silently carried forward. Module similarity check tightened to prevent false reuse. Email templates gain a `dnd_area_stylesheet` reference for HubSpot drag-and-drop editor compatibility. `annotateFieldRefs` guards against non-array fields to prevent preview crashes.
- **Email template `dnd_area` naming** ([VIB-313](/VIB/issues/VIB-313)) — Email templates now use `"main"` as the `dnd_area` name, matching HubSpot's expected default. Includes an auto-fix for existing email templates created before this change.
- **Email module references** ([VIB-312](/VIB/issues/VIB-312)) — Email templates now generate with module references so modules appear in HubSpot's drag-and-drop email editor.
- **Email deploy UX** ([VIB-310](/VIB/issues/VIB-310)) — Deploy button disables while the upload panel shows post-upload actions (preventing double-upload). Server binds to `0.0.0.0` for remote access. Fixed double-overlay during upload.
- **Email asset library wiring** ([VIB-309](/VIB/issues/VIB-309)) — Email asset type now flows through the full setup path: asset-type card → content mode → email starters and pipeline. Library tab buttons wired for email projects.
- **HubL keyword prefix protection** ([VIB-311](/VIB/issues/VIB-311)) — CSS class prefixer no longer corrupts HubL keywords like `module_asset_url` or `get_asset_url` when adding theme-scoped prefixes.
- **Delete theme button** ([VIB-317](/VIB/issues/VIB-317)) — Restored the delete button on the Project Home screen after it was lost during a UI restructure.
- **Asset creation navigation** ([VIB-327](/VIB/issues/VIB-327)) — Creating an asset in the Library tab now switches to the editor panel and focuses the chat input, instead of leaving the user on the Library view.
- **Shell injection in git operations** ([VIB-300](/VIB/issues/VIB-300)) — Eliminated shell injection vectors in git commit and tag operations by switching from string interpolation to argument arrays.
- **Path traversal in theme routes** — Theme create and delete routes now guard against path-traversal payloads.
- **Row checkbox listeners** ([VIB-333](/VIB/issues/VIB-333)) — Project table checkboxes and bulk toolbar now survive table re-renders after bulk operations complete.

### Documentation

- Updated CHANGELOG, README, and `ui/docs/index.html` with all v1.3.1 features and fixes.
- Added "Your First Generation" walkthrough section for both page and email workflows.
- Added project overview table and bulk operations documentation.
- Expanded HubSpot publishing workflow with email-specific deploy guidance.

---

## v1.3.0 — 2026-05-03

### Multi-page sites ([VIB-159](/VIB/issues/VIB-159))

Create full multi-page HubSpot sites from a single prompt. The intent analyzer detects site requests (`create_site` intent) and plans shared modules (header/footer) plus per-page layouts with unique slugs. Page tabs in the editor let you switch between templates — each tab shows the page label, type badge, and module count. Cross-page navigation link validation (`validateNavLinks`) catches broken inter-page links in nav/header/footer modules. Page-scoped chat context tells the AI which page you're editing, enabling cross-page references like "same header as the home page."

- **Intent analyzer** — `create_site` intent with `pages` array (id, label, pageType, purpose, slug) and `sharedModules` field
- **Site module planner** — plans shared + per-page modules in a single architect pass
- **Page tabs UI** — template switching with auto-reload of modules, chat, and preview
- **Page-scoped chat** — `activePageLabel` and `sitePages` in session snapshot for cross-page AI context
- **Nav link validation** — post-pipeline check for href links that don't match any page slug

### Inline WYSIWYG editing ([VIB-162](/VIB/issues/VIB-162))

Click text, images, and links directly in the live preview to edit them inline. Changes persist via `/api/field` and refresh the preview. Edit mode toggles from the preview topbar — mutually exclusive with Select mode, both disabled during AI generation. Server-side field annotations (`annotateFieldRefs`) provide deterministic click-to-field mapping.

### Per-section visual controls ([VIB-164](/VIB/issues/VIB-164))

Hover-activated toolbar over module sections in the preview pane. When hovering a `[data-module]` element, a floating toolbar appears with controls mapped to the module's fields: color picker for color fields, padding/margin sliders for spacing fields, image URL swap for image fields, and font size selector for text-size number fields. All changes persist via `/api/field` with debounced saves and preview refresh on popover close.

### Features

- **Guided entry with asset type cards** ([VIB-255](/VIB/issues/VIB-255)) — Replaces the static Project Home header with a warm time-of-day greeting ("Good morning / afternoon / evening") and 6 asset-type cards: Landing Page, Email, Website, Blog Post, From Template, and Import. Each non-template card reveals a scoped describe prompt with an asset-type eyebrow and per-type placeholder. The Import card shows a source picker (HubSpot, Figma, React). From Template opens the existing starter grid. Stashes the selected type on `window.__pendingAssetType` for downstream consumers.
- **Page tree context actions** ([VIB-232](/VIB/issues/VIB-232)) — page tree items get type icons, drag-to-reorder, and right-click context menu (Rename, Duplicate, Move, Delete) with server-side routes for page operations.
- **First-visit onboarding walkthrough** ([VIB-235](/VIB/issues/VIB-235)) — 3-step product intro shown on the project home for fresh installs (no projects, no local themes). Steps: (1) what vibeSpot is, (2) how it maps to HubSpot (sections → modules, tokens → `:root` vars, project → CMS theme), (3) try it with a pre-filled sample prompt. Adds back/next/skip controls, progress dots, and persists a `vibespot:introSeen` localStorage flag. Force-show with `?intro` in the URL.
- **Blog template generation** ([VIB-160](/VIB/issues/VIB-160)) — blog as a content type alongside page and email. Blog-specific prompts with HubSpot blog variables (`content.post_body`, `content.author`, `blog_recent_posts`), blog validator auto-fix, and a pre-built Blog Content Hub starter template (8 modules).
- **Split-pane view** ([VIB-163](/VIB/issues/VIB-163)) — "Split" button in the view toggle shows live preview and code editor in a 50/50 CSS grid layout. Fully coordinated with Preview, Plan, and Code view switching.
- **Brand kit enforcement** ([VIB-166](/VIB/issues/VIB-166)) — structured brand kit (colors, fonts, logo URL) persisted as `brand-kit.json` in `.vibespot/`. Values injected as mandatory design constraints into email architect, email module developer, and page architect prompts. Validator warns on off-brand colors and fonts.
- **Workspace tab navigation** ([VIB-173](/VIB/issues/VIB-173)) — dashboard restructured into workspace tabs: Pages, Brand, Library, Marketplace, Settings. Unified Interact mode replaces separate Select + Edit modes — editable elements get inline editing, module containers prefill the chat input.
- **Page tree sidebar** ([VIB-174](/VIB/issues/VIB-174)) — replaces horizontal page tabs with a vertical tree showing all templates with type badges (LP, Blog, Web, Sec), labels, and module counts. Always visible; includes inline page creation form with type selector.
- **Editor mode simplification** ([VIB-175](/VIB/issues/VIB-175)) — unified Interact mode, Plan as a resizable sidebar (coexists with preview), per-module code viewer tabs (Fields/Code) in the field editor, and Version History as a collapsible bottom panel.
- **Email option in page type dropdown** ([VIB-199](/VIB/issues/VIB-199)) — email generation is now reachable from the web UI page type dropdown (not just the `vibespot email` CLI), setting `contentMode` to `"email"` and scaffolding the email template.
- **Project assets browser** ([VIB-288](/VIB/issues/VIB-288)) — Library tab now shows project asset files (images, fonts, scripts) instead of starter templates. Browse, preview, and reference assets directly from the workspace.
- **Material Design SVG icons** ([VIB-289](/VIB/issues/VIB-289)) — replaced all UI emoji glyphs with crisp Material Design SVG icons for consistent cross-platform rendering.
- **Brand kit font picker with styleguide sync** ([VIB-292](/VIB/issues/VIB-292)) — font picker dropdowns now sync available fonts from the design styleguide. Custom font option inserts correctly before optgroups.

### Enhancements

- **Status bar information density** ([VIB-236](/VIB/issues/VIB-236)) — enhanced statusbar with module count, page type badge, uptime, and memory usage indicators.
- **Code quality indicators** ([VIB-234](/VIB/issues/VIB-234)) — HubL validity badge in browser-chrome bar, browser-chrome dots, URL bar. Badge shows valid/warning/error states with counts.
- **HubSpot visual language** ([VIB-219](/VIB/issues/VIB-219)) — always-visible HubSpot portal indicator in topbar, polled from `/api/settings/status`. Connected state shows portal name + ID with green dot; disconnected links to Settings. Resource links in project rail sidebar.
- **Project Home visual hierarchy** ([VIB-221](/VIB/issues/VIB-221)) — hero prompt section with "Start building" heading, enlarged prompt card with accent-glow border, promoted Build button to `btn--lg`, demoted template entry under "Or start from a template" label, standardised vertical rhythm.
- **CSS token system** ([VIB-185](/VIB/issues/VIB-185)) — comprehensive design token system: spacing scale (`--space-0..10`), typography (`--text-xs..display`, `--weight-*`, `--leading-*`), z-index (`--z-base..confirm`), transitions (`--duration-fast/normal/slow`, `--ease-*`), icons, layout, and status/badge colors. 270 font-size, 48 border-radius, and 109 transition declarations migrated to tokens.
- **Component CSS library** ([VIB-186](/VIB/issues/VIB-186)) — spec-compliant base classes for Button, IconButton, Input, Textarea, Card, Badge, Toggle, Tabs, Toast, Modal, ChatBubble, EmptyState, Spinner, ProgressBar — all referencing design tokens. Existing BEM classes aliased for compatibility.
- **Brand tab visual preview** ([VIB-226](/VIB/issues/VIB-226)) — live brand preview card above the brand kit form: color swatches for primary/secondary/accent, sample heading + body text rendered with configured fonts, and a logo thumbnail. Form fields grouped into Colors / Fonts / Logo cards with `max-width: 480px`.
- **Workspace tab visual weight** ([VIB-230](/VIB/issues/VIB-230)) — increased visual weight of the active workspace tab for clearer navigation affordance.
- **Slim preview browser-chrome bar** ([VIB-225](/VIB/issues/VIB-225)) — slimmed down the preview pane's browser-chrome bar to reduce visual noise and reclaim vertical space.
- **Light mode polish** ([VIB-228](/VIB/issues/VIB-228)) — light mode as default for new visitors, tighter light-mode borders, `--shadow-card` token for subtle card lift.

### Changes

- **Context-aware project rail** ([VIB-222](/VIB/issues/VIB-222)) — rail shows footer-only on Project Home (center area owns the project browser) and session context in Editor (back button, current project bubble, project switcher popover).
- **Surface all entry points on Project Home** ([VIB-224](/VIB/issues/VIB-224)) — replaced hidden "More ways to start" disclosure with a visible 5-card grid (Template, Blank, HubSpot Import, Figma Import, React Convert).
- **Two-mode architecture** ([VIB-187](/VIB/issues/VIB-187)) — restructured the UI into two distinct modes: Project Home (project selection, templates, settings) and Editor (chat, preview, modules), controlled by `data-mode` attribute on `.app-body`. Cleaner state boundaries between browsing and editing.
- **Deduplicate template surfaces** ([VIB-231](/VIB/issues/VIB-231)) — chat welcome no longer shows the page-template grid; it now offers three conversation starters ("Describe your page", "Upload a Figma design", "Import from HubSpot"). Page templates live on the Library tab and are reachable via the templates icon in the chat input area.
- **Align UI terminology with HubSpot vocabulary** ([VIB-233](/VIB/issues/VIB-233)) — user-facing copy now uses HubSpot's canonical terms (Module, Module Library, Brand Kit) instead of the legacy "section" phrasing. Where vibeSpot keeps a different concept (e.g. Project ↔ Theme), the HubSpot equivalent is shown in tooltips. Adds a "HubSpot Terminology" reference section to `ui/docs/index.html`.

### Fixes

- **Settings tab permanent spinner** ([VIB-212](/VIB/issues/VIB-212)) — switching to the editor's Settings workspace tab now triggers the environment fetch instead of leaving the default "Loading environment..." spinner in place. Added a 3 s fetch timeout with a retry-able fallback message so a hung backend can no longer wedge the panel.
- **Mobile responsive layout** ([VIB-211](/VIB/issues/VIB-211)) — responsive gate dialog shown at viewports < 768px; tablet breakpoint (768–1024px) collapses the project rail to icon-only width, tightens chat panel, and hides topbar text to prevent clipping.
- **Editor preview empty state** ([VIB-213](/VIB/issues/VIB-213)) — designed empty state inside `.browser-chrome` with vibeSpot sparkle mark, headline, and chat-input hint. Auto-hides when generation begins or when the iframe loads content.
- **Theme robustness on project home** ([VIB-214](/VIB/issues/VIB-214)) — restored starter grid CSS rules and added explicit background/color-scheme declarations for dark/light parity.
- **Scrollable project rail** ([VIB-181](/VIB/issues/VIB-181)) — project rail items now scroll instead of overflowing the container.
- **Dead code cleanup and QC tooling** ([VIB-191](/VIB/issues/VIB-191)) — removed 6 dead event listeners from the VIB-187 restructure. Added `ui-element-refs.test.ts` validator and `PRE-MERGE-QC.md` checklist.
- **Session module preservation** ([VIB-286](/VIB/issues/VIB-286)) — modules in the library and active session now survive page refresh. WebSocket reconnects on dashboard load so pages and chat persist across navigations. Module library refreshes when the Library workspace tab is activated.
- **Unique AI design output** ([VIB-281](/VIB/issues/VIB-281)) — AI now generates unique color palettes and font choices per project instead of repeating defaults. Design-guide recipes feed into the design system when no brand kit is set.
- **Chat message display after pipeline** ([VIB-279](/VIB/issues/VIB-279)) — assistant chat messages now display correctly after the agentic pipeline completes.
- **Extract button crash** ([VIB-276](/VIB/issues/VIB-276)) — extract button no longer crashes on wrong selector after generation.
- **Responsive preview controls** ([VIB-278](/VIB/issues/VIB-278)) — enlarged and centered responsive preview controls for better usability.
- **Empty page tree after generation** ([VIB-277](/VIB/issues/VIB-277)) — page tree and module slideout now populate correctly after generation completes.

### Email template generation ([VIB-158](/VIB/issues/VIB-158))

Full email template generation built on the VIB-154 spike. vibeSpot can now create, iterate, and upload HubSpot email templates alongside landing pages.

- **`vibespot email` CLI command** — launches email mode with email-specific setup flow
- **Email tab in web UI** — new content mode toggle in setup screen for email projects
- **3 email starter templates** — Welcome, Announcement, Newsletter bundles in `starters/`
- **5 email plan templates** — Welcome, Announcement, Newsletter, Event Invite, Re-engagement in `assets/plan-templates/`
- **Pipeline email routing** — all 4 stages (Intent Analyzer, Page Architect, Module Developer, Validator) route through `contentType: "email"` for email-safe generation
- **Email-specific Page Architect** — dedicated `email-architect.ts` prompt with table-based layout planning, inline CSS design tokens, MSO conditional structure
- **Email validator auto-fix** — skips CSS prefix and CDN import fixes for email; sets `host_template_types: ["EMAIL"]` in meta.json
- **Intent analyzer email detection** — `contentType` field in structured output schema for LLM-level email content classification
- **Email template scaffold** — `addEmailTemplateToTheme()` creates `templates/email.html` with MSO/VML namespaces and `templateType: email`
- **Email preview** — email-realistic preview rendering with table layout support

---

## v1.2.0 — 2026-04-30

### Undo/redo with Ctrl+Z and visual history timeline ([VIB-91](/VIB/issues/VIB-91))

A compact horizontal version-history strip now sits above the chat input, with each entry showing a one-line description of a generation step. Hovering an entry reveals a tooltip with the commit hash, age, and the section names changed in that step. Clicking an entry restores that version. Ctrl+Z / Cmd+Z step backwards through history; Ctrl+Y / Ctrl+Shift+Z / Cmd+Shift+Z step forwards. Shortcuts respect text fields — they only fire when the chat input or another text editor is not focused — and are suppressed during AI generation.

- **[src/server/project-git.ts](src/server/project-git.ts)** — `getHistory` / `getTemplateHistory` now run a single `git log --name-only` and populate `changedFiles` + extracted `changedModules` per commit, so the timeline tooltip renders without an extra round-trip.
- **[ui/index.html](ui/index.html)** — new `#history-timeline` strip with prev/next buttons, scrollable entry track, and a tooltip element.
- **[ui/chat.js](ui/chat.js)** — `refreshHistoryTimeline()`, cursor tracking, click-to-restore, hover tooltip, and a global `keydown` listener for Ctrl+Z / Ctrl+Y.
- **[ui/styles.css](ui/styles.css)** — themed styles for the timeline strip, entries, current-version highlight, and tooltip.

### Clickable preview elements — select mode ([VIB-90](/VIB/issues/VIB-90))

A new "Select" toggle in the preview topbar lets you click an element in the live preview to reference it in chat.

- **[ui/preview.js](ui/preview.js)** — hover/click handlers, chat-prefill string, auto-deactivation during generation.
- **[ui/chat.js](ui/chat.js)** — `window.prefillChatInput()` for contextual pre-fill.
- **[ui/styles.css](ui/styles.css)** — pill toggle and crosshair cursor.

### Smart chat suggestions ([VIB-89](/VIB/issues/VIB-89))

Contextual suggestion chips after pipeline completion. Filtered by existing modules.

### Simplified setup / onboarding flow ([VIB-85](/VIB/issues/VIB-85))

The setup screen no longer leads with a 6-button grid. Returning users land on a "Continue where you left off" rail of recent projects; new users see a chat-style "Describe the landing page you want to build…" prompt as the primary path, with "Start from Template" as a single secondary action and the niche import flows tucked behind a "More ways to start" disclosure. Submitting the prompt creates a fresh theme, jumps directly into chat, and auto-sends the prompt as the first message — collapsing 6 cold-start choices to 2.

- **[ui/index.html](ui/index.html)** — restructured `#setup-options`: new `#setup-recent`, `#setup-prompt-card`, `#setup-secondary`, and a collapsible `#setup-more-panel` that wraps the legacy Blank Theme / From HubSpot / From Figma / From React buttons. The existing setup panels (`panel-starter`, `panel-new`, `panel-continue`, `panel-download`, `panel-figma`, `panel-convert`) are kept verbatim so all existing functionality stays accessible.
- **[ui/setup.js](ui/setup.js)** — adds `populateRecentProjects(info)` (called from `initSetup`), `startFromPrompt()` + `generateThemeNameFromPrompt()` for the describe-it path, an `expandMoreOptions()` disclosure toggle, and a "View all" handler that delegates back to the existing `togglePanel("continue")` flow.
- **[ui/chat.js](ui/chat.js)** — on the next websocket `init`, consumes `window.__pendingInitialPrompt` and forwards it to `sendMessage()` so the user's setup-screen prompt becomes the first chat turn (skipped if the session already has history, e.g. resumed projects).
- **[ui/styles.css](ui/styles.css)** — new `.setup__recent*`, `.setup__prompt-*`, `.setup__secondary*`, `.setup__more*` rules using the existing CSS variable palette so dark/light parity is preserved. The walkthrough flow for first-run users with no AI engine configured is untouched.

### Inverse pipeline — HubSpot → vibeSpot ([VIB-59](/VIB/issues/VIB-59))

Reverse-engineers imported HubSpot themes: design tokens, module graph, field schemas, round-trip risks.

### HubSpot Marketplace publication path ([VIB-58](/VIB/issues/VIB-58))

vibeSpot now ships a Marketplace check workflow that audits a generated theme against HubSpot's Marketplace submission requirements before you submit through the developer portal. Available from both the editor (storefront icon in the topbar) and the CLI (`vibespot marketplace check`).

- **[src/server/marketplace.ts](src/server/marketplace.ts)** — rule-based validator with structured `MarketplaceReport`. Errors when `theme.json` is missing any HubSpot-required field (`label`, `preview_path`, `screenshot_path`, `version`, `documentation_url`, `license`, `example_url`, `enable_domain_stylesheets`, `is_available_for_new_content`, plus `author.name` / `author.email` / `author.url`); also checks module/field labels, screenshot existence, CDN imports, hardcoded portal-bound URLs, and an accessibility baseline (`<img alt>`, semantic landmarks). Listing metadata enforces HubSpot's 2–5 feature count. Reads/writes a `marketplace.json` sidecar with category, description, features, support URL, pricing tier. `applyMarketplaceAutoFixes()` fills in missing module/field labels and strips external CDN `@import` / `<link>` / `<script>` references from shared CSS and module HTML/CSS.
- **[test/marketplace.test.ts](test/marketplace.test.ts)** — 11 tests covering the expanded `theme.json` rule set, the CDN auto-fix path (CSS `@import`, module `<link>`/`<script>`), and the 2–5 feature-count guidance.
- **[src/commands/marketplace.ts](src/commands/marketplace.ts) + [src/cli/program.ts](src/cli/program.ts)** — new `vibespot marketplace check [--path] [--json] [--fix]` and `vibespot marketplace edit` subcommands.
- **[src/server/routes/marketplace.ts](src/server/routes/marketplace.ts) + [src/server/server.ts](src/server/server.ts)** — `GET /api/marketplace/check`, `POST /api/marketplace/fix`, and `GET|POST /api/marketplace/listing` routes scoped to the active session theme.
- **[ui/marketplace.js](ui/marketplace.js), [ui/index.html](ui/index.html), [ui/styles.css](ui/styles.css)** — Marketplace panel with grouped findings (errors / warnings / notes), per-finding fix suggestions, an "Apply fixes" button, a re-check button, and an inline listing metadata editor.
- **[ui/docs/index.html](ui/docs/index.html)** — new "HubSpot Marketplace" section under "Deploy & History" plus CLI reference rows.

Out of scope for this iteration: automated submission (requires HubSpot Partner API access), automated screenshot capture (the validator only checks that the file exists at `screenshot_path`), and theme monetization. These remain manual for now.

### Starter templates ([VIB-56](/VIB/issues/VIB-56))

The setup screen now has a "Template" button that lets users create a new theme pre-populated with vetted, ready-to-preview modules. Five starter templates ship out of the box: SaaS Landing Page, Portfolio, Restaurant, Event / Conference, and Coming Soon.

- **[starters/](starters/)** — five JSON bundles, each containing all modules (fields.json, meta.json, module.html, module.css), shared CSS/JS, and module order. Included in the npm package via the `files` field.
- **[src/server/starters.ts](src/server/starters.ts)** — `resolveStartersDir()`, `listStarters()`, `getStarter(id)` with `StarterTemplate` / `StarterMeta` types.
- **[src/server/routes/setup.ts](src/server/routes/setup.ts)** — `POST /api/setup/create` now accepts optional `starterId`; new `GET /api/starters` endpoint; `bootstrapFromStarter()` writes modules + shared CSS/JS to disk and populates the session.
- **[ui/index.html](ui/index.html), [ui/setup.js](ui/setup.js), [ui/styles.css](ui/styles.css)** — starter template grid in the setup panel, card selection, and "Create from template" flow.

### Plan-mode templates ([VIB-57](/VIB/issues/VIB-57))

When the Plan view is empty, vibeSpot now offers a picker of pre-canned plan structures for common page types: SaaS landing, e-commerce product, event registration, blog/content hub, portfolio, agency/services, restaurant. Picking a template seeds `.vibespot/plan.md` with a structured brief (goal, audience, primary CTA, suggested kebab-case modules, brand/tone, and page-type-specific open questions) and flips plan mode on. The plan-mode system prompt has a new "Phase 1-T: TEMPLATED START" branch that recognizes a fresh template-seeded plan and skips straight to the page-specific elicitation in **Open questions**, instead of asking generic understand-phase questions.

- **[assets/plan-templates/](assets/plan-templates/)** — seven shipped templates as markdown files with YAML frontmatter (`id`, `label`, `description`, `icon`, `order`).
- **[src/server/plan-templates.ts](src/server/plan-templates.ts)** — frontmatter parser, directory scanner, cached `listPlanTemplates()` / `getPlanTemplate(id)` / `listPlanTemplateMetadata()`.
- **[src/server/routes/plan.ts](src/server/routes/plan.ts)** — adds `GET /api/plan/templates` (list) and `POST /api/plan/template` (apply by id; auto-enables plan mode and seeds `.vibespot/plan.md`).
- **[src/server/agent/prompts/plan-mode.ts](src/server/agent/prompts/plan-mode.ts)** — adds "Phase 1-T: TEMPLATED START" phase guidance for `turnCount === 0 && hasPlan`.
- **[ui/plan.js](ui/plan.js), [ui/styles.css](ui/styles.css), [ui/index.html](ui/index.html)** — template picker rendered in the Plan pane whenever the plan is empty. Includes a "Blank plan" fallback that enables plan mode without a seed (preserves the existing free-form behavior).
- **[test/plan-templates.test.ts](test/plan-templates.test.ts)** — 13 new tests covering frontmatter parsing, sort order, required fields, and structural invariants of every shipped template.

---

## v1.1.3 — 2026-04-28

Hotfix: model selection now persists for Codex CLI, Gemini CLI, and Gemini API engines, and the chosen model is actually passed to the CLI subprocess.

### The Bug
Selecting any non-default model in the Codex CLI dropdown (or Gemini CLI / Gemini API) immediately reverted to the first option after save. Root cause spanned four layers:

1. `VibeSpotConfig` had no fields for `codexCliModel` / `geminiCliModel` / `geminiApiModel`.
2. `handleSettingsEngineRoute`'s switch had no cases for those engines, so `POST /api/settings/engine` saved `aiEngine` but silently dropped `model`.
3. `handleSettingsStatusRoute` didn't return those fields on the status payload.
4. `getCurrentModel(engine, config)` returned `null` for those engines, so the dropdown's "selected" option fell through to the HTML default — the first `<option>` in the list, which carried the "(default)" label.

Even with persistence fixed, the runtime invocation in `engine-adapter.ts:resolveCLIBinary` didn't pass `-m` to `codex` or `gemini`, and `ai-handler.ts:resolveAgenticEngine` returned an empty model string for CLI engines. So a user picking a Codex model would have seen the dropdown stick but the subprocess still run with whatever `codex exec` defaults to.

### The Fix
- **[config.ts](src/utils/config.ts)** — Added `codexCliModel`, `geminiCliModel`, `geminiApiModel` to `VibeSpotConfig`.
- **[routes/settings.ts](src/server/routes/settings.ts)** — Added the missing switch cases in `handleSettingsEngineRoute`. Status payload now includes the new fields.
- **[ui/settings.js](ui/settings.js)** — `getCurrentModel` returns the persisted value (or a sensible default) for all engines instead of `null`.
- **[engine-adapter.ts](src/server/agent/engine-adapter.ts)** — `resolveCLIBinary` now takes a `model` parameter and appends `--model`/`-m` to claude / codex / gemini CLI invocations when set.
- **[ai-handler.ts](src/server/ai-handler.ts)** — `resolveAgenticEngine` populates `model` from the new config fields for CLI engines, so the value flows from settings → pipeline → CLI subprocess.

---

## v1.1.2 — 2026-04-28

Honest, current model dropdowns + a fix for the blank-on-open settings dialog.

### Model Selection
- **Specific Claude versions in Claude Code dropdown** — replaced the generic `opus`/`sonnet`/`haiku` aliases with pinned IDs (Claude Opus 4.7, Opus 4.6, Sonnet 4.6, Sonnet 4.5, Haiku 4.5). Picking a version now passes that exact ID to `claude --model` instead of letting the CLI pick whatever the alias resolves to today.
- **Codex CLI dropdown shows current models** — GPT-5.5, GPT-5.5 Pro, GPT-5.3 Codex, GPT-5.2 Codex, GPT-5.1 Codex Max, GPT-5.1 Codex Mini, GPT-5.4 Mini, GPT-5.4 Nano, Codex Mini (latest). Was stuck on `o4-mini` / `o3` / `gpt-4o`.
- **OpenAI API dropdown** — GPT-5.5, GPT-5.5 Pro, GPT-5.4 Mini, GPT-5.4 Nano, GPT-5.3 Codex.
- **Live model catalog now populates Codex CLI too** — when an OpenAI API key is configured, the `/v1/models` response feeds both the OpenAI API and Codex CLI dropdowns (cached 10 min). New releases on the user's account show up automatically.
- **Live-fetch regex widened** — supports decimal-versioned IDs (`gpt-5.5*`, `gpt-5.4*`, `gpt-5.3*`) and `codex-*` variants. `labelForOpenAIModel` now handles arbitrary `gpt-X.Y[-suffix]` patterns generically.
- **Static fallbacks added for Anthropic API, Claude OAuth, OpenAI API, Gemini API/CLI** — current versions show in the dropdown even before any API key is configured.

### Bug Fixes
- **Settings dialog opened to a blank page** — `btn-setup-settings` was registered as `addEventListener("click", openSettings)`, so the click `Event` was passed as the `tab` argument and overwrote `activeTab`. Wrapped in an arrow function so `openSettings()` is called with no argument and the AI tab renders by default.

---

## v1.1.1 — 2026-04-26

Hotfix: stop the agentic pipeline from creating duplicate modules when re-styling an existing page.

### The Bug
When the Intent Analyzer classified a request as `style_change` or `modify` AND `designSystemChanges: true`, the Page Architect's Module Planner stage was given **zero context about existing modules**. Combined with the prompt rule "module names: descriptive, title-case", the planner re-invented module names instead of regenerating the existing ones. With Plan Mode and Figma Import producing kebab-case names (e.g. `hero`, `how-it-works`), regeneration produced Title Case duplicates (`Hero Field Journal`, `How It Works`) — the case-insensitive match in `updateModules` couldn't bridge the gap, so they were added as NEW modules. Result: a 7-module page becomes a 14-module page after one "Revise the entire page!" prompt.

The bug had been latent for a long time; chat-driven generations historically used Title Case names too, so re-runs accidentally matched. Plan Mode and Figma Import introduced kebab-case identifiers, breaking the implicit naming continuity that was hiding the bug.

### The Fix
- **[page-architect.ts](src/server/agent/stages/page-architect.ts#L157)** — Removed the `!plan.designSystemChanges` gate. Existing modules are now always passed to the planner, split into two explicit sections: **"Existing Modules to Re-plan (PRESERVE THESE EXACT NAMES)"** for the Intent Analyzer's `affectedModules` and **"Existing Modules to Keep"** for the rest.
- **[page-architect prompt](src/server/agent/prompts/page-architect.ts)** — Replaced the unconditional "title-case" rule with explicit guidance: existing names must be used verbatim (they're identifiers, not labels), new modules use kebab-case to match the Plan Mode / Figma Import convention. Schema description updated to match.
- **[state.ts updateModules](src/server/session/state.ts)** — Defensive warning: when an arriving module name is similar-but-not-equal to an existing one (`hero` vs `Hero Field Journal`, `how-it-works` vs `How It Works`, `footer` vs `page-footer`), log a structured warning. The module is still added (we don't auto-merge — too risky for content), but drift is visible in logs.

### Verification
Re-running a "revise" prompt on an existing page now matches modules by exact name, regenerates the existing ones in place, and produces the same number of modules as before — no duplicates.

---

## v1.1.0 — 2026-04-26

Plan mode (deliberation phase before generation), streamlined Figma import (translation pipeline), Anthropic SDK upgrade with extended thinking, and an AI Capabilities settings panel.

### Plan Mode
- **Toggle from chat input** — prominent labeled pill (distinct from icon buttons) with clear On/Off state and accent glow when active
- **Three-phase prompt** — Understand (ask 2–4 high-leverage questions) → Research (propose first plan) → Refine (iterative edits) — phase keyed off conversation turn count
- **Plan pane in main window** — third tab next to Preview and Code; renders the markdown plan with full GFM-subset support (headings, lists, tables, code, blockquotes)
- **Inline plan editing** — pencil icon swaps the rendered plan for a textarea; save persists to `.vibespot/plan.md` and the next AI turn picks up the edits as context
- **Choice chips** — AI may emit a `vibespot-choices` JSON block with discrete options; rendered as clickable chips below the assistant message; clicking sends the value as next message
- **Hard write-gate** — server refuses to enter the agentic pipeline while plan mode is active, even if the AI mistakenly emits a generation block; generation only via explicit `plan_approve` action
- **Approval flow** — "Approve plan" prepends the plan as a `## Approved plan` section to a synthesized "Implement the approved plan." message; runs the agentic pipeline with the plan as a high-fidelity design brief
- **Discard flow** — clears `plan.md`, exits plan mode, returns chat to normal generation
- **Plan persists across sessions** — `.vibespot/plan.md` is loaded on theme open alongside other brand assets; toggle state persists in `~/.vibespot/config.json`
- **Plan-mode system prompt** — instructs the AI to consider existing modules, module library, brand assets so plans can reference reusable components

### Streamlined Figma Import
- **Translation pipeline** — replaces the previous agentic-pipeline import path; the AI is used only to translate each section to HubL, not to make creative decisions
- **Deterministic CSS generation** — design tokens map mechanically to `:root` CSS variables and utility classes (no AI guessing)
- **Section-to-spec mapping** — each Figma section becomes one module spec with exact text, layout, and content from the design
- **Module ordering preserved** — module order matches Figma's section order; existing modules in the active template are cleared before import to avoid jumbling
- **Image asset copy** — extracted PNGs are copied from `/tmp/` to `{theme}/assets/` automatically; `useAssets` toggle on the import screen controls whether modules reference them via `get_asset_url()` or use HubSpot image fields with placeholders
- **Responsive CSS by default** — Figma exports the desktop layout; the AI is instructed to add `@media (max-width: 767px)` and `@media (max-width: 1023px)` blocks per module
- **Re-import replaces** — running a Figma import on an existing theme clears the active template's modules first (Figma is treated as a full page replacement)

### Anthropic SDK Upgrade
- **`@anthropic-ai/sdk` 0.39 → 0.91.1** — 52 minor versions of features including extended thinking, citations, Files API, batch API, improved prompt caching, Web Search and Code Execution tools
- **Other dep bumps** — `commander` 13 → 14, `marked` 17 → 18 (UMD vendor refreshed), `execa` and `ws` to latest patch
- **`npm audit fix`** — cleared `@xmldom/xmldom` and `picomatch` high-severity vulnerabilities
- **Type fixes for the new SDK** — `MessageParam` namespace move (engine-adapter, ai-engines), `TextBlock` predicate updates (design-extractor)

### AI Capabilities Panel
- **New "AI Capabilities" section** under Settings → AI tab
- **Extended thinking toggle** — Anthropic API/OAuth; configurable budget (Low ~4k / Medium ~16k / High ~32k tokens); Page Architect's two substages (Design System + Module Planner) opt in when enabled, Module Developer left untouched to avoid N× cost on parallel calls
- **Web Search toggle** — works on Anthropic API/OAuth (appends the `web_search_20250305` server-side tool to non-structured-output calls) AND Claude Code CLI (passes `--allowedTools=WebSearch`); auto-engages for plan mode where research is highest-value
- **Status indicators** — Prompt Caching shows "Active" on Anthropic API, "Auto (CLI-managed)" on Claude Code, "Anthropic only" elsewhere; Extended Thinking shows the equivalent — toggleable on API, "Auto (CLI-managed)" on Claude Code; Citations is the remaining "Coming soon" item
- **Tool definition cache control** — `input_schema` for the Module Developer's tool is now `cache_control: { type: "ephemeral" }`, saving schema-encoding tokens on every parallel call after the first

### Claude Code stream-json
- **New `spawnClaudeCodeStreamJSON` helper** — line-buffered JSON parser for `claude --output-format stream-json --include-partial-messages --verbose`; fault-tolerant (malformed lines silently dropped, parser never crashes); preserves live token-typing UX; captures the final `result` event for usage stats
- **Tool-use visibility** — tool calls (`Read`, `Edit`, `Bash`, `WebSearch`, `WebFetch`, `Grep`, `Glob`, `Write`) are surfaced as live status lines in the pipeline UI ("Reading hero/module.html", "Searching: 'pricing best practices'", "Editing styleguide.md") instead of generic rotating placeholders
- **Both Claude Code call sites upgraded** — the agentic CLI path (`callAgentCLI`) and the legacy single-call mode (`generateWithClaudeCode`) both use the new helper

### UI
- **"From Figma" button gets a Beta badge** to match "From React"
- **"Convert React" renamed to "From React"** for consistency with "From HubSpot" / "From Figma"
- **"Experimental" badge changed to "Beta"** across the setup screen and docs
- **Plan Mode badge** appears in the chat header when active (replaces engine label); pill is colored with accent and a subtle glow ring

### Documentation
- **VIBESPOT_OVERVIEW.md** — comprehensive ~1,000-line system overview document covering architecture, agentic pipeline, plan mode, Figma import, sessions, integrations, and strategic opportunities
- **README expanded** with Plan Mode and Figma Import sections; What's New leads with v1.1
- **Docs site** — new sections for Plan Mode (with phase walkthrough) and Figma Import (with extraction details, image modes, and translation pipeline); sidebar updated; "From Figma" added to the setup mockup and "Starting a Project" list

### Bug Fixes
- **chat.js syntax error** — missing closing brace for `handleWsMessage` caused chat.js to fail silently on parse, which manifested as "0 modules and no chat history" for ALL projects (not just Figma imports). The bug was introduced when adding the `needs_setup` case
- **Figma import module order** — modules now appear in the page in their Figma section order; old modules are cleared before import so they don't mix with new ones
- **Plan-mode bubble gap** — when streaming finished, `finishStreaming()` re-rendered from `streamBuffer` (still containing the raw response with the fenced plan block), producing trailing `<br>` tags from stripped fences. Fixed by overwriting `streamBuffer` with the cleaned content on `plan_complete`
- **Render-markdown trailing whitespace** — collapses runs of 3+ blank lines and trims trailing whitespace after stripping fenced blocks; prevents future similar regressions
- **Choice chip "Other" handling** — clicking "Other" no longer auto-sends "Other" as a literal answer; instead clears + focuses the input with a contextual placeholder; AI is told via system prompt not to include "Other" since the chat input is always available for free-text answers

---

## v1.0.10 — 2026-04-09

Figma design import — paste a Figma URL, extract structure and assets, generate a full HubSpot page.

### Figma Import
- **"From Figma" on setup screen** — paste a `figma.com/design/...` URL, extract design tokens, text content, section structure, and image assets
- **Figma API client** — parses Figma file tree, extracts colors, typography, spacing, effects, and text content with role inference (headline/body/cta/label)
- **Frame screenshots** — exports top-level frames as PNG for visual reference
- **Embedded image export** — batch-exports IMAGE fill nodes as theme assets (50 per request)
- **Rate limit retry** — exponential backoff (10s → 120s) on Figma API 429 responses
- **Extraction summary** — shows file name, section count, asset count, font families, color swatches, and section tags before generating
- **Full pipeline integration** — serialized Figma extraction fed through agentic pipeline (Intent → Architect → Developer → Quality Check)
- **Auto theme scaffold** — creates theme directory, session, and git commit on completion
- **Settings tab** — dedicated "Figma" tab with PAT input, test connection button, and help link
- **Inline token prompt** — if no token configured, "From Figma" panel offers inline save or links to Figma Settings tab
- **Deep link to settings** — "Add one in Settings" link opens Settings directly on the Figma tab

### UI
- **Setup button grid** — 5 columns (was 4) with wider container (620px) to prevent label wrapping
- **`openSettings()` deep linking** — accepts optional tab parameter for navigating directly to a specific settings tab

---

## v1.0.9 — 2026-04-08

MD file uploads, CLI timeout fix, pipeline robustness.

### File Uploads
- **Markdown file support** — `.md`/`.markdown` files now upload reliably via extension-based MIME fallback (browsers often misreport these as `application/octet-stream`)
- **File content in agentic pipeline** — uploaded document text is now included in AI context for all pipeline stages (was missing — files were silently ignored)

### Pipeline Reliability
- **CLI engine timeout** increased from 5 → 10 minutes for large prompts (configurable via `spawnCLI` parameter)
- **Module planner prompt optimized** — shared CSS summarized to class/variable names only (98% smaller), fixing timeouts on complex pages
- **Structured output validation** — module planner results validated before use; graceful fallback instead of crash on malformed AI output (`Cannot read properties of undefined`)

---

## v1.0.7 — 2026-03-27

User-facing documentation, Docs link in sidebar.

### Documentation
- **Complete SPA documentation** at `/docs/` — 12 sections covering setup, editor, AI generation, editing, deploying, version history, settings, CLI, shortcuts, and troubleshooting
- **Interactive UI mockups** — editor layout, setup screen, settings panel, upload flow (pure CSS, no images)
- **Client-side search** with keyboard navigation (/ to focus, arrow keys, Enter)
- **Sticky sidebar nav** with scroll spy highlighting
- **Interactive pipeline diagram** with hover tooltips
- **Collapsible sections**, tabbed content, step lists, callout boxes, code copy buttons
- **Mobile responsive** — sidebar collapses to hamburger on narrow screens
- **Docs link** added to project rail sidebar (book icon, opens in new tab)
- Files located at `ui/docs/` (tracked by git, included in npm package)

---

## v1.0.6 — 2026-03-27

Preview stays visible during modifications, quality check auto-fixes, question answers in chat.

### Preview Improvements
- **Preview stays visible during modify/question** — no more blank spinner page while modules regenerate
- **Static file serving** — removed stale in-memory cache and aggressive browser caching (`no-cache` + ETag revalidation)

### Quality Check Auto-Fix
- **CSS prefix auto-fix** — unprefixed CSS class selectors now auto-prefixed with `themeName-` (was report-only)
- **HTML class auto-fix** — corresponding HTML `class="..."` attributes updated to match prefixed CSS
- Both CSS and HTML fixes marked as `autoFixed: true` in quality check output

### Question Intent
- **Answer text displayed in chat** — pipeline `answer` field now sent in `pipeline_complete` event and rendered in the chat bubble
- **Stats line** — shows "Answered in Xs" instead of "Generated 0 modules"

---

## v1.0.5 — 2026-03-26

Claude OAuth engine and Anthropic prompt caching.

### Claude OAuth (`claude-oauth`)
- **New auth variant** — use your Claude Pro/Max subscription via OAuth token, no API key needed
- **Token paste flow** — run `claude setup-token` in terminal, paste the `sk-ant-oat01-...` token in Settings
- **Auto-refresh** — access tokens (8h lifetime) are automatically refreshed 5 minutes before expiry
- **Token storage** — `~/.vibespot/claude-oauth.json` with restricted permissions (0o600)
- **Full pipeline support** — works with both streaming (single-call) and agentic (multi-stage) modes
- **Settings UI** — Claude OAuth section with status display, token input, and disconnect button
- **CLI wizard** — `claude-oauth` available as engine option in preflight wizard

### Anthropic Prompt Caching
- **Ephemeral cache control** — system prompts split into blocks with `cache_control: { type: "ephemeral" }` on static content
- **Streaming mode** — `buildVibeSystemPromptBlocks()` marks conversion guide, HubSpot rules, design guide, and content guide for caching
- **Agentic pipeline** — module developer marks HubSpot rules + conversion guide (~42K tokens) for caching across N parallel module calls
- **Design system stage** — design guide marked for caching
- Applies to both `anthropic-api` and `claude-oauth` engines

---

## v1.0.4 — 2026-03-19

Template and module deletion improvements, pipeline step alignment fix.

### Template Deletion
- **Delete template from disk** — deleting a template now removes its `.html` file (and blog listing template) from the theme directory, not just from the session
- **Delete modules option** — template delete dialog now offers three choices: delete template + its exclusive modules, delete template only (keep modules), or cancel
- **Exclusive module detection** — only modules not used by any other template are removed when "delete with modules" is chosen

### Module Library
- **Delete module button** — module library preview panel now has a "Delete module" button that removes the module from all templates and deletes the `.module` directory from disk
- **Full cleanup on removeModule** — `removeModule()` now removes the module from all templates (not just the active one) and deletes the directory from disk immediately

### UI
- **Pipeline step checkmark alignment** — replaced CSS pseudo-element trick (`width: 0` + `::after`) with direct text replacement, so the `✓` icon occupies the same inline space as the spinner and stays aligned with the label

---

## v1.0.3 — 2026-03-19

Fix nested HubL conditionals breaking button rendering and downstream CSS.

### Bug Fix
- **Nested conditional rendering** — HubL renderer's `RE_IF_PATTERN` regex now matches innermost if/endif blocks first, then peels layers outward. Previously, the non-greedy body pattern paired outer `{% if %}` with inner `{% endif %}` tags, causing button text and closing `</a>` tags to be consumed by mismatched orphan conditionals. This produced empty button rectangles and broke CSS for all downstream modules.

---

## v1.0.2 — 2026-03-19

Brand assets redesign, per-asset extraction, and cross-template context sharing.

### Brand Assets UI
- **Hover-expand cards** — each brand asset (styleguide, brand voice, product context) is a ghost button that reveals Upload and Extract actions on hover
- **Per-asset extraction** — extract styleguide, brand voice, or product context individually via AI
- **Extract All** — single button runs all three extractors in parallel
- **Extracting state** — cards show "Extracting..." label with dimmed state during AI extraction
- **Event delegation** — unified click/change handling replaces 8+ individual listeners

### Brand Voice Extractor (new)
- **AI-powered brand voice extraction** — analyzes rendered preview HTML to extract tone, voice characteristics, vocabulary patterns, sentence style, and dos/don'ts
- Used as context for consistent copy across pages in the same theme

### Cross-Template Context Sharing
- **Product context extraction** — AI extracts a product/company brief (name, value props, target audience, terminology) from the rendered preview
- **Preview-based extraction** — both brand voice and product context extractors now use the fully rendered preview HTML (with HubL resolved to actual field values) instead of raw template placeholders
- **Prompt injection** — product context is injected into Intent Analyzer, Page Architect, and Module Developer prompts for brand-consistent generation
- **Post-generation suggestion** — after first pipeline run, a dismissible chat prompt offers to extract all brand assets (never blocks preview)

### Session & Persistence
- **themeContext** added to `brandAssets` in session and snapshot types
- **theme-context.md** loaded from `.vibespot/` directory on session restore
- **Brand asset CRUD** — GET/POST/DELETE endpoints support all three asset types

---

## v1.0.1 — 2026-03-18

Pipeline reliability, intent analyzer improvements, and UI polish.

### Intent Analyzer
- **Conversation history** — intent analyzer now receives the last 3 chat exchanges, enabling back-references ("same section"), follow-ups ("now make it bigger"), and corrections ("I meant the hero")
- **Correction handling** — "I was referencing X" is now correctly classified as a modify intent targeting module X, no longer misclassified as a question
- **Cross-module style references** — "match the rest of the page" / "consistent with other sections" correctly targets the specific module rather than triggering a design system rebuild

### Pipeline Reliability
- **moduleOrder reconciliation** — if the AI Module Planner omits a module from the page order (was causing modules to render after the footer), the pipeline now auto-inserts missing modules before the footer and warns in the chat
- **Font limitation feedback** — when the user requests a web font (e.g., Montserrat), the design system stage now reports that HubSpot modules use system font stacks instead of silently dropping the request

### UI
- **Pipeline step collapsing** — duplicate step events for the same stage (e.g., two "designing" steps for design system + module planner) now properly update instead of creating orphan elements
- **Lonely checkmark fix** — the stray `✓` between module cards and quality check is resolved via proper icon visibility handling and step element positioning

---

## v1.0.0 — 2026-03-15

Agentic pipeline — multi-stage AI generation replacing single-call mode.

### Agentic Pipeline
- **4-stage pipeline** — Intent Analyzer → Page Architect → Module Developer → Quality Check
- **Intent Analyzer** — classifies user requests (create, modify, add, remove, rearrange, style_change, question) and plans which modules to generate, modify, or keep
- **Page Architect** — split into two sequential calls:
  - **Design System Architect** — creates `:root` CSS variables, shared CSS, shared JS with complete design tokens (colors, typography, spacing, effects)
  - **Module Planner** — plans module specs using the finalized design system
- **Module Developer** — parallel per-module generation with concurrency up to 20
- **Quality Check agent** — auto-fixes common issues after generation:
  - Unbalanced HubL tags (orphan closing tags removed, missing closing tags appended)
  - Reserved field names (`name` → `item_name`, `label` → `section_label`)
  - Deprecated field types (`textarea` → `text`)
  - CDN @import removal
  - Invalid HubL functions (`now()` → `local_dt`)
  - Missing meta.json required fields
- **Question short-circuit** — questions answered directly without running the full pipeline

### Incremental Preview
- Completed modules appear in the live preview immediately as each finishes
- Themed skeleton placeholders for pending modules (matches light/dark theme)
- Design system pushed to preview early for themed placeholders
- Module order set after Stage 2 for correct placeholder positioning

### Pipeline UI
- Real-time pipeline progress in chat: Analyzing → Designing → Developing → module cards → Quality Check
- Per-module status cards (queued, generating, complete, failed)
- Detailed quality check reporting with per-issue breakdown (✓ auto-fixed / ⚠ warning)
- Pipeline completion stats (modules generated, duration)

### Multi-Engine Support
- **Engine adapter** — unified interface for API engines (Anthropic, OpenAI, Gemini) and CLI engines (Claude Code, Gemini CLI, Codex CLI)
- Structured output (JSON schema) support for API engines
- CLI engines use subprocess spawning with prompt piping
- Engine/model/concurrency configurable in Settings → AI tab

### Bug Fixes
- **Duplicate modules** — AI-generated module names (Title Case) vs spec names (kebab-case) caused 20 modules instead of 10. Fixed: module names always use canonical spec names; `updateModules` uses case-insensitive matching.
- **Design system CSS variables** — `:root` block was never generated, causing all `var()` references to resolve to nothing. Fixed by dedicated Design System Architect stage.
- **White gaps between placeholders** — body background now matches theme during generation

### Architecture
- Session module refactored from monolithic `session.ts` (1394 lines) into focused submodules:
  - `session/state.ts` — module mutations, field updates
  - `session/store.ts` — session CRUD, persistence
  - `session/disk.ts` — theme file I/O, git operations
  - `session/templates.ts` — template management
  - `session/types.ts` — shared interfaces
- Structured logging system with log levels and categories
- Agent prompts in dedicated `agent/prompts/` directory with JSON schemas

---

## v0.9.5 — 2026-03-15

Security hardening, architecture improvements, and UI polish.

### Security
- **Shell injection prevention** — replace `execSync` string interpolation with `execFileSync` + argument arrays across all server routes, CLI commands, and utilities. New `startJobSafe()` process manager API with stdin support.
- **CORS restriction** — restrict `Access-Control-Allow-Origin` from `*` to localhost-only origins
- **Security headers** — add `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`
- **XSS prevention** — escape HTML before markdown rendering in chat and dialog views
- **API key file permissions** — config file set to `0600` on write (non-Windows)
- **Input validation** — git commit hash validation, portalId numeric check, API key format validation for shell profile writes

### Architecture
- **Safe JSON.parse** — new `readJsonBody()` route helper with automatic 400 response on parse failure
- **Process manager cleanup** — streaming job listeners cleared on completion/error/timeout; shared `_attachJobHandlers()` reduces duplication
- **Cross-platform** — Windows-compatible `execFileSync` with `shell: true` for PATH resolution while keeping argument arrays for injection safety

### UI
- Brand asset view icon changed from play arrow to eye icon
- Brand asset delete now correctly refreshes the dashboard

---

## v0.9.4 — 2026-03-14

### Features
- Color swatches next to hex codes in styleguide/brandvoice preview
- Download button to save styleguide/brandvoice as markdown files
- Feedback button on all screens — submits to HubSpot form (bug reports, feature requests, comments)
- Brand asset inline controls (view/delete) replacing separate buttons

### UI
- Larger template card clone/delete controls
- Darker dialog overlay for better contrast
- Speech bubble feedback icon on dashboard and editor topbars

---

## v0.9.3 — 2026-03-13

### Features
- **Code editor** — CodeMirror 6 with file browser, Preview/Code toggle
- Custom vibespot theme using CSS variables for dark/light support
- Syntax highlighting, Cmd+S save, pretty-printed JSON
- Preview refreshes automatically when returning from code view after saving
- Orange save button for better visibility

### Theme Import
- Multi-template scanning — parse each template file, create TemplateEntry per file with correct module assignments
- Template cloning — deep-copy templates as starting point for new pages
- AI design extraction — analyze theme CSS/HTML/fields to auto-generate styleguide
- Reference theme import from HubSpot or local theme
- Narrative-aware editing — page structure context for AI modifications
- Styleguide/brandvoice viewer with rendered markdown

---

## v0.9.2 — 2026-03-13

### Bug Fixes
- Fix HubSpot API: upload to `published` env instead of `draft` (blank pages)
- Fix base layout: add `require_css`/`require_js` for template assets
- Fix hash routing: always init setup before handling route, dedup `openTheme`
- Fix module order: parse template file for display order instead of filesystem
- Fix Ctrl+C: force exit after 500ms grace period
- Fix anchor links: instruct AI to put `id` on module root element
- Fix version display: read from `package.json` dynamically
- Fix `\n` in preview: strip literal newlines from field defaults
- Fix duplicate messages in API call history
- Fix `+` button in project rail to open New Theme dialog

---

## v0.9.0 — 2026-03-12

HubSpot API migration — replace CLI dependency with direct API calls.

### HubSpot API
- Direct HTTP calls to HubSpot CMS Source Code API v3 (no more `@hubspot/cli` dependency)
- Per-file upload progress via WebSocket instead of streaming CLI stdout
- PAK-based authentication with API validation
- Multi-account support in config
- Theme scaffold creation without CLI
- Theme download from HubSpot via API (manual folder name input)

### Settings Overhaul
- Tabbed settings layout: AI, HubSpot, GitHub, vibeSpot
- Descriptions on every setting explaining what it does
- CLI tool toggles with lazy detection (no subprocess on settings load)
- API vs CLI upload mode selector
- HubSpot account management cards with add/switch/remove

### UI
- "Experimental" corner badge on Convert React button
- Download panel uses text input instead of dropdown (HubSpot API doesn't support root listing)

---

## v0.8.0 — 2026-03-11

File upload and media support for the chat interface.

### Features
- Unified file upload system for images and documents
- Attach files via paperclip button or drag-and-drop in chat
- Images copied to `theme/assets/`, referenced via `get_asset_url()` in HubL
- Documents (PDF, DOCX, MD, TXT) text-extracted and sent as AI context
- Multimodal vision support for Anthropic, OpenAI, and Gemini APIs
- File chips displayed in chat history for sent messages
- Asset manifest included in AI prompts for automatic image wiring
- HubL renderer resolves `get_asset_url()` for local preview

---

## v0.7.1 — 2026-03-10

Performance optimizations and architecture refactor.

### Performance
- rAF-debounced streaming and scroll updates
- Static file caching with ETag/304 responses
- Session index cache for instant project listing
- Bundle minification: 244KB → 137KB
- Favicon optimization: 279KB → 1.6KB
- Lazy Anthropic SDK loading
- Hoisted HubL regex patterns (no re-compilation per render)
- Event delegation for module list
- Upload log output buffering

### Architecture
- Extract `server.ts` (2117 → 664 lines) into 5 route modules
- Split `ai-handler.ts` (1038 → 143 lines) into prompts, parser, and engines
- Add `SessionRepository` interface for future SaaS readiness
- Structured error types and logging

### Bug Fixes
- Fix `ReferenceError: ifPattern is not defined` in HubL renderer (regex hoisting missed a reference)

---

## v0.7.0 — 2026-03-09

Per-template version history, renaming, ZIP download, and navigation improvements.

### Features
- Per-template version history with scoped git commits
- History panel "Show all" / "This template" toggle
- Safe rollback that doesn't affect other templates
- Inline rename for projects (themes) and templates via double-click
- Dashboard theme heading with working directory path
- Download theme as ZIP from dashboard
- Back button replaces brand logo in chat/editor topbar
- SVG star logo in topbars

---

## v0.6.0 — 2026-03-08

Light mode, loading speed improvements, and chat layout changes.

### Features
- Light/dark theme toggle (sun/moon icon in all topbars)
- Persists theme via localStorage, detects system preference on first visit
- All chat avatars moved to left side with sharp corner pointing toward avatar

### Performance
- Replace ~30 hardcoded colors with CSS custom properties for theming
- Cache AI prompt guides in memory (skip ~90KB disk I/O per generation)
- Session index file (`_index.json`) for O(1) project listing

---

## v0.5.2 — 2026-03-07

### Bug Fixes
- Fix favicon white corners (remove rounded rect, use full-bleed square)

---

## v0.5.1 — 2026-03-07

### Assets
- Add logo assets: SVG (vector), PNG (512×512), ICO (legacy favicon)

---

## v0.3.0 — 2025-03-03 (Stable)

The "it actually works" release. Vibe coding web UI is functional end-to-end with reliable uploads and auto-fix for common HubSpot errors.

### Bug Fixes
- Fix invalid color format upload error — auto-fix converts `rgba()`/`rgb()`/named colors to hex
- Fix `hs create` writing theme boilerplate to wrong directory
- Fix chat history leaking between projects (WebSocket lifecycle + DOM cleanup)
- Fix stale "Resuming session..." spinner when navigating back to main screen
- Fix invisible content on HubSpot pages (scroll-animate opacity)

### Improvements
- Deploy confirmation dialog with target portal name/ID
- Spinner feedback on Deploy button during portal info fetch
- Module control icons use accent orange for better visibility
- Replaced deprecated `hs upload` → `hs cms upload` everywhere
- Color field format rules added to `hubspot-rules.md`

### Auto-Fix System
- New: `rgba()`/`rgb()`/named color → hex conversion
- New: 3-digit hex → 6-digit hex conversion
- Detects "The format for the color value is invalid" errors

---

## v0.2.0 — Vibe Coding Web UI

Major release: added the browser-based vibe coding interface.

- Chat panel with AI streaming (multi-engine support)
- Live preview via HubL subset renderer
- Field editor sidebar for editing module field values
- Module list with drag-and-drop reordering and deletion
- Responsive preview toggle (desktop/tablet/mobile)
- Upload to HubSpot with celebration popup and confetti
- Session management with project list sidebar
- Hash-based routing (#/app/themeName)
- Version history via git commits (auto-commit after each AI generation)
- Robust JSON parsing with auto-repair for unescaped quotes
- Project deletion with confirmation dialog
- HubSpot data center detection (EU/NA portal URLs)

---

## v0.1.x — CLI Wizard

The original CLI-only converter.

- **v0.1.8** — Robustness, logging, and UX improvements
- **v0.1.7** — Auto-fix HubDB template errors on upload
- **v0.1.6** — Model selection, workspace fix, validation test
- **v0.1.4** — Initial AI-powered React to HubSpot CMS converter
- Multi-engine AI support (Claude Code, Anthropic API, OpenAI, Gemini, Codex)
- Wizard flow: preflight → source → theme-setup → conversion → upload
- Auto-fix system for common upload errors (textarea, reserved names, CDN imports)
