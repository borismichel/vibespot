# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**vibeSpot** is an AI-powered HubSpot CMS landing page builder. It provides both a vibe coding web interface (chat on left, live preview on right) and a CLI wizard for converting React/Lovable pages into native HubSpot CMS modules.

## Development Commands

```bash
npm run dev          # Run directly with tsx (no build step)
npm run build        # Build with tsup → dist/index.js
node bin/vibespot.mjs # Run the built CLI (requires build first)
```

### Validation Test

After any code changes, always ask the user if they want to run the end-to-end validation test:

```bash
npm run build && npx tsx test/validate.ts
```

This test clones a real repo, creates a HubSpot theme, runs AI conversion via Claude Code, validates all generated files, uploads to HubSpot, verifies in HubSpot, then cleans up. Takes 3-5 minutes. The test is local-only (not in git or npm).

### UI Element Reference Check

After any changes to `ui/*.js` or `ui/index.html`, run:

```bash
npx tsx test/ui-element-refs.test.ts
```

This validates that every `getElementById`/`querySelector("#id")` in JS files references an ID that exists in the HTML (or is dynamically created). Exits non-zero on crash-causing mismatches. See `test/PRE-MERGE-QC.md` for the full pre-merge checklist.

There is no unit test suite or linting configured.

## Architecture

### Entry Flow
`bin/vibespot.mjs` → `dist/index.js` → `src/index.ts` → `src/cli/program.ts` (Commander)

The default command (no subcommand) runs the vibe coding web UI. Subcommands: `wizard`, `init`, `convert`, `upload`, `marketplace check|edit`, `doctor`.

### Key Directories
- `src/commands/` — One file per CLI command, each exports a single action function
- `src/server/` — HTTP server, WebSocket, AI handler, session management, preview builder, version history (git). `server.ts` owns the server lifecycle, the single auth-gate seam (`handleRequest`, VIB-1889), and static/preview serving; the `/api/*` dispatch is a route table in `routes/api-router.ts`, the WebSocket protocol lives in `ws-handler.ts`, and run-state (content mode, active preview origin) in `server-context.ts` (VIB-1932)
- `src/server/agent/` — Agentic pipeline (see below)
- `src/server/session/` — Session management split into submodules (state, store, disk, templates, types)
- `src/wizard/` — Step implementations for the wizard flow: preflight → source → theme-setup → conversion → uploader → next-steps
- `src/ai/` — Multi-engine AI system for single-call mode (legacy)
- `src/hubl/` — Lightweight HubL template renderer for local preview (supports variables, conditionals, loops, filters incl. `convert_rgb`, simple `path/N`·`path*N` arithmetic, scope_css, require_css/js). `convert_rgb` + the `opacity/100` idiom render defaulted colors faithfully and collapse undefaulted ones to empty — this keeps the validator's rendered-CSS check sound (VIB-1842).
- `src/cli/` — Commander setup, ASCII banner, chalk color theme (respects `NO_COLOR`)
- `src/utils/` — Shell execution (`execSync` wrappers), tool detection, file helpers, `~/.vibespot/config.json` persistence
- `src/prompts/` — `@clack/prompts` wrapper with themed styling and cancel handling
- `starters/` — Bundled starter template JSON files (SaaS landing, portfolio, restaurant, event, coming soon). Each is a self-contained bundle with modules, shared CSS/JS, and module order. Loaded by `src/server/starters.ts`
- `src/server/marketplace.ts` — Rule-based HubSpot Marketplace publication validator. `validateMarketplace(themePath)` returns a structured `MarketplaceReport`; `applyMarketplaceAutoFixes()` patches the small set of findings we can resolve without intent (missing module/field labels). Read/write a `marketplace.json` listing sidecar via `readMarketplaceMeta` / `writeMarketplaceMeta`. Exposed via `vibespot marketplace check|edit` (CLI), the topbar storefront button (UI), and `/api/marketplace/check|fix|listing` routes.
- `src/server/inverse-analyzer.ts` — Rule-based reverse-engineer of an imported HubSpot theme. `analyzeTheme(themePath)` returns an `InverseReport` with extracted design tokens (`:root` vars + inferred palette / typography / spacing / radii / shadows from theme + module CSS), a per-template module-usage graph plus orphan modules, field schema flags for patterns vibeSpot doesn't natively generate (HubDB, repeater occurrence, deeply nested groups, custom widget types, conditional visibility), and round-trip risks (HubL macros, raw blocks, partials outside `modules/`, custom `module.js`, `import_modules.json`). `buildRootCssFromTokens()` synthesises a `:root` block from the inferred palette/typography. `scanThemeFromDisk()` calls into this module to seed `session.sharedCss` when the imported theme ships none. Exposed via `vibespot inverse [--path] [--json] [--apply-tokens]` (CLI) and `/api/inverse/analyze|apply-tokens` routes.
- `ui/` — Static frontend assets (HTML, JS, CSS) for the vibe coding web interface
- `assets/` — Bundled guides: `conversion-guide.md`, `design-guide.md`, `content-guide.md`, `hubspot-rules.md`, `humanify-guide.md`. Also `assets/plan-templates/*.md` — pre-canned plan-mode templates loaded by `src/server/plan-templates.ts`.

### Agentic Pipeline (`src/server/agent/`)

The default generation mode. Runs a 4-stage pipeline for each user message:

1. **Intent Analyzer** (`stages/intent-analyzer.ts`) — Classifies request as create/modify/add/remove/rearrange/style_change/question. Plans which modules to generate, modify, keep, or reuse. Questions short-circuit the pipeline.

2. **Page Architect** (`stages/page-architect.ts`) — Two sequential calls:
   - **2a: Design System** — Creates `:root` CSS variables, shared CSS (component styles, responsive rules), shared JS. Uses `DESIGN_SYSTEM_SCHEMA` for structured output.
   - **2b: Module Planner** — Plans module specs (name, description, contentBrief, layoutNotes) using the finalized CSS. Uses `MODULE_PLANNER_SCHEMA`.

3. **Module Developer** (`stages/module-developer.ts`) — Parallel generation with concurrency limiter (default 20). Each module gets the shared CSS, conversion guide, and HubSpot rules as context. Uses `MODULE_DEVELOPER_SCHEMA` for structured output.

4. **Quality Check** (`stages/validator.ts`) — Rule-based validation and auto-fix:
   - Unbalanced HubL tags: orphan closers removed, missing closers appended (stack-based algorithm)
   - Reserved field names (`name` → `item_name`, `label` → `section_label`)
   - Deprecated field types (`textarea` → `text`)
   - CDN @import stripping
   - `now()` → `local_dt`
   - Missing meta.json required fields
   - Invalid CSS color values (VIB-1842): renders the module with its field defaults (via `src/hubl`) and flags color functions with empty components — e.g. `rgba(15, 17, 21, )` from a style field with no default. Recorded as a `⚠` warning (`code: "invalid-css"`, not auto-fixed); the eval (`scoreValidity` → `invalidCssModules`) counts it as a distinct axis that docks pass-rate.

**Engine Adapter** (`engine-adapter.ts`) — Unified interface for all AI engines:
- API engines (Anthropic, OpenAI, Gemini): structured output via JSON schema, streaming
- CLI engines (Claude Code, Gemini CLI, Codex CLI): subprocess spawning with prompt piping
- **Instrumentation**: API responses' token usage is captured into `AgentCallResult.usage` (`TokenUsage` in `src/server/pricing.ts`) and `callAgentAPI` emits a per-call usage/cost log plus a Langfuse generation (`src/server/langfuse.ts`). CLI engines report no usage. See "Observability (Langfuse)" below.

**Prompts** (`prompts/`) — System prompts and JSON schemas for each stage. The editable stage *instruction* prompts (intent-analyzer, design-system, module-planner, site-module-planner, module-developer) are sourced through the **stage-prompt registry** (`prompts/registry.ts`, VIB-1769) rather than inline literals — see "Stage-prompt registry" below. The large static `.md` guides are NOT managed there; they stay as cached file blocks appended by the builders.

### Stage-prompt registry (Langfuse Phase 3, `prompts/registry.ts` + `prompts/managed/`)

Langfuse-managed prompts via **bundle-at-build** (no runtime dependency on our infra — fits the local-CLI deployment model, confirmed by Boris on [VIB-1769]):

- **Source selection**: `renderStagePrompt(id, vars)` / `getStagePrompt(id)` pick the active template — the version-pinned Langfuse-compiled bundle entry when valid, else the in-code local fallback. A bundle entry is accepted only when (a) its `version` equals the pinned local version and (b) it references no placeholder outside the stage's allow-list; either failure silently falls back to local (per-prompt). So a stale/missing/tampered bundle never alters generation.
- **Local fallback** (`managed/local-prompts.ts`): the canonical `LOCAL_STAGE_PROMPTS` — each stage's instruction template (with `{{placeholder}}` tokens), pinned `version`, and allow-listed `placeholders`. This is the guaranteed offline copy.
- **Bundle** (`assets/prompts.bundle.json`): compiled at build time by `scripts/sync-prompts.ts` (`npm run prompts:pull` pulls each stage prompt from Langfuse at its pinned version → `vibespot-stage-{id}`; `npm run prompts:seed` / `--from-local` seeds it from the local fallback). Loaded at runtime via `resolveAsset` (same path as the `.md` guides), shipped via `files: [assets]`. **`build` never fetches Langfuse** — it uses the committed bundle.
- **Direction is one-way (Langfuse → bundle → runtime).** The pull/build flow only *reads* prompts; it never creates them. So a stage prompt is visible/editable in the Langfuse **Prompts** UI only after it's been published there. `npm run prompts:push` (`scripts/sync-prompts.ts --push`) seeds the project once — `POST /api/public/v2/prompts` creates each `vibespot-stage-{id}` from the local fallback at its pinned version (`production` label), idempotent (skips a stage already at that version). The full round-trip: **`prompts:push` (seed once) → edit in the Langfuse UI → `prompts:pull` (bake the edits into the bundle at build)**. Without a push, the project's Prompts tab is empty even though generations still trace correctly (VIB-1853 — bundling prompts at deploy ≠ publishing them to Langfuse).
- **No untrusted interpolation**: substitution replaces only allow-listed `{{token}}`s with CONTROLLED values (theme name, computed module/CSS summaries — never raw user input), single-pass so inserted values are never re-scanned/re-expanded.
- **Behavior parity**: externalization is byte-identical to the previous inline prompts, locked by a golden snapshot test (`test/prompt-registry.test.ts` + `test/fixtures/prompt-golden.json`). The quality-check stage is rule-based (no model call) → it has no managed prompt.

**Types** (`types.ts`) — `PipelinePlan`, `PageBlueprint`, `ModuleSpec`, `PipelineEvent`, `PipelineResult`, concurrency limiter.

**Pipeline Events** (emitted via WebSocket):
- `agent_step` — Stage transitions (analyzing, designing, developing, quality_check)
- `agent_decision` — Stage details shown in UI
- `module_progress` — Per-module status (queued, generating, complete, failed)
- `design_system_ready` — CSS pushed to session for themed placeholders
- `blueprint_ready` — Module order set for placeholder positioning
- `checkpoint_requested` — Pipeline parked at a gate; carries the preview card + `estCostNext` (see Checkpoint gate)
- `generation_superseded` — A barge-in cancelled the running build (VIB-1880); the replacement run's events follow
- `pipeline_complete` / `pipeline_partial` — Final stats

### Checkpoint gate (VIB-1877, conversational pipeline)

A reusable **park-and-re-enter** primitive that pauses the pipeline at a cheap seam so the user can intervene before the expensive build — generalizing the older `plan_approve` pause. Shipped seams, fired in order: the **brand-intake checkpoint** (C2, VIB-1878, raised first, only when no style system exists), the **design checkpoint** (C1, VIB-1877), the **structure checkpoint** (C3, VIB-1879), then the build — plus **plan mode** as the heaviest variant (C4, VIB-1880, see below). Flow: brand-intake → design → structure → build.

- **Mechanism (crash-safe):** when checkpoints are on, `runAgentPipeline` (`agent/pipeline.ts`) splits Stage 2 at the design seam — it runs only `runDesignSystem` (2a), then **returns at the gate** with `PipelineResult.pendingCheckpoint` set, instead of awaiting Stage 3. No dangling promise. The resume state is held in an in-memory `Map<resumeToken, CheckpointResumeState>` — a `DesignCheckpointState | StructureCheckpointState` union (the design state's `kind` also covers `brand_intake`, where the design system is built on resume; the structure state additionally carries the full `blueprint`). The token + preview are persisted on `session.pendingCheckpoint`; the full resume state is also serialized onto `session.pendingCheckpoint.resumeState` (the union members are all JSON-serializable, so they ride the session to disk), so a gate now survives a **server restart** too (VIB-1883): on `checkpoint_resolve` a store miss is rehydrated from the persisted `resumeState` — the resolve handler passes it as `resumeAgentPipeline`'s `fallbackState`, which repopulates the in-memory store before continuing. `resumeState` is stripped from the `init` payload sent to the client (server-only). `parkAtCheckpoint()` is the shared park helper (it takes the preview as a parameter); `parkAtDesignCheckpoint` / `parkAtStructureCheckpoint` / `parkAtBrandIntakeCheckpoint` differ only in which preview they hand it.
- **Resume:** `checkpoint_resolve { action: approve|steer|skip|cancel, note?, outline?, brandIntake? }` (WS) → `handleAgenticResume` → `resumeAgentPipeline`. **cancel** drops the run (every seam). Otherwise branch on the parked `state.kind`:
  - **brand-intake gate** — `resumeBrandIntake` always advances to the design gate: *Surprise me* (skip) builds a plain design system; *Bring your brand* (approve) routes the intake channels, seeds the design system, merges the brand `:root`, then re-parks at the design gate.
  - **design gate** — *approve* runs `runModulePlanner` (2b, extracted from `runPageArchitect`) against the parked design then PARKS at the structure gate; *skip* runs the planner and `runBuildPhase` (Stage 3+4) straight through, suppressing the structure gate; *steer* re-runs ONLY `runDesignSystem` with the note and re-parks design.
  - **structure gate** — *approve/skip* fold the user's edited `outline` into the blueprint (`applyStructureEdits`) and `runBuildPhase`; *steer* re-runs ONLY `runModulePlanner` with the note and re-parks structure.
  - Resume reuses the same `runWithCostTracking` + `runWithTrace` scoping so continuation cost rolls into the page total, and threads the barge-in `AbortSignal` into `runBuildPhase`.
- **Design preview:** `agent/design-preview.ts` `buildDesignPreview()` — palette swatches + heading/body type specimen + one representative hero, **deterministically from the design tokens, no model call**. The hero is a self-contained HTML string rendered in a sandboxed iframe `srcdoc` in `ui/chat.js`. `estCostNext` (on every gate) reuses `cost-tracker.ts` `peekCurrentCost()` (spend-so-far × `STAGE3_COST_MULTIPLIER`); omitted for CLI engines (no usage).
- **Structure preview + edits:** `agent/structure-preview.ts` — `buildStructurePreview(blueprint)` lists the planned modules in page order (each carrying its `sourceIndex` into `blueprint.modules`), **no model call**. The UI renders an editable outline (reorder ▲/▼, cut ✕, rename inline, + Add section) and sends the kept rows back as `resolution.outline`. `applyStructureEdits(blueprint, outline)` rebuilds `blueprint.modules` + `moduleOrder` from the outline: a row with a `sourceIndex` keeps that module's planned `contentBrief`/`layoutNotes` (so reorder/rename is free), a hand-added row (no `sourceIndex`) gets a generic brief; names are kebab-coerced, collisions de-duped, an empty result falls back to the original blueprint. Covered by `test/structure-preview.test.ts`.
- **Brand-intake checkpoint (VIB-1878, C2):** a `brand_intake` gate raised *before* the design system, **only** on `intent === "create"` when `hasStyleSystem(snapshot)` is false (no `brandAssets.styleguide` and no `:root` in `sharedCss`) — an imported theme / resumed session has a style system, so the ask is skipped (Boris-locked "use it if present"). The card (`buildBrandIntakePreview()`, deterministic) offers **Surprise me** (resolved as `skip`) or **Bring your brand** (`approve` + `CheckpointResolution.brandIntake` channels). `resumeBrandIntake` routes the channels through `agent/brand-intake.ts` `routeBrandIntake()` — colors/code → in-memory token parse, `themePath` → `inverse-analyzer.extractDesignTokens`, `siteUrl` → fetch + parse, `voice` → brandvoice — folds them into one `:root` + brand brief, seeds a snapshot copy, runs `runDesignSystem` (brand-aware), **merges the brand `cssVariables` (brand wins) + appends a brand override `:root`**, then re-parks at the design gate. Derived brand assets ride back on `PipelineResult.brandAssetsUpdate` and are persisted via `saveBrandAssetToTheme`. All channels are deterministic — no model call at the gate. *(Deferred: file/screenshot upload → AI-vision styleguide.)*
- **Interaction model:** checkpoints are **on by default** for non-email `needsArchitect` runs. The send button's one-tap **one-shot** affordance (`#chat-send-oneshot` → `oneShot:true` on the `chat` message → `checkpointsEnabled=false`) skips all gates (= prior behavior). Plan-approved runs pass `checkpointsEnabled=false` (the plan already gated). No three-mode selector.

### Barge-in + plan fold (VIB-1880, conversational pipeline C4)

- **Barge-in = cancel-and-replan.** A `chat` message arriving while `isGenerating()` cancels the active run and replans with the new message (vs queuing). `ai-handler.ts` registers every cancellable run's `AbortController` in a set (`beginCancellableRun` / `endCancellableRun`) — including runs still queued on the lock — and `cancelActiveGeneration()` aborts them all (newest message wins). Runs are serialized by a **per-session generation lock** (promise-chain mutex in `ai-handler.ts`, VIB-1895): the replacement run waits for the aborted predecessor to unwind instead of the old global-flag + 10s-timeout poll that could let overlapping pipelines mutate one session. The signal threads `runAgentPipeline` → **all stages** (intent analyzer, design system, module planner, site planner — VIB-1895) → `runBuildPhase`/`runMultiPageFlow`/`resumeAgentPipeline` → `runModuleDeveloper` → `createConcurrencyLimiter(n, signal)` (VIB-1880: queued tasks reject with `PipelineAbortError`; entering after abort rejects) **and** into `callAgent`'s provider request (Anthropic SDK `{ signal }` / `fetch` `signal` / CLI subprocess kill in `spawnCLI`/`spawnClaudeCodeStreamJSON` — VIB-1895) so in-flight calls stop spending. Seam checks (`if (signal?.aborted) throw new PipelineAbortError()`) bail between stages. The 429 backoff-retry in the engine adapter covers all API engines (Anthropic, OpenAI, Gemini, Langdock) and wakes early on abort. On abort the handlers return `{ canceled: true }` (mapped via `isAbortError`) instead of surfacing an error; the server emits `generation_superseded`. UI (`ui/chat.js`): the composer stays live during the build (`enableBargeIn()` on the `developing` step / `module_progress`), but a mid-build send is **softened to queue-by-default** (VIB-1876): `sendMessage` stashes it in `queuedMessage`, shows a "Queued — runs next" chip with an **Interrupt now** button, and dispatches it when the run finishes (`flushQueuedMessage()` from the terminal handlers). Only **Interrupt** (`opts.interrupt`) takes the old cancel-and-replan path — `supersedeCurrentRun()` then sends normally. Single-call streaming and parked checkpoint gates stay locked.
- **Plan mode folded onto the gate.** Plan mode is `CheckpointKind: "plan"` — the heaviest variant. When a plan is produced, the server parks `pendingCheckpoint{kind:"plan"}` (preview carries the plan markdown; no in-memory resume store — the plan lives on `session.brandAssets.plan`). Approve / steer / cancel resolve through the same `checkpoint_resolve` WS message: the handler branches on `pending.kind` — **plan** → `runPlanApproval` (build the approved plan, one-shot) / `runPlanDeliberation` (re-stream + re-park, for steer) / `runPlanDiscard` (cancel); **design/structure/brand_intake** → `handleAgenticResume`. The old `plan_approve`/`plan_discard` WS cases are thin aliases over these helpers (kept for older clients); `ui/plan.js` now sends `checkpoint_resolve {kind:"plan"}`. Build-and-commit is one shared `finalizeAgenticGeneration()` helper used by the chat, design-resume, and plan-approve paths.

### Observability (Langfuse)

`src/server/langfuse.ts` is an **opt-in**, dependency-free client for Langfuse's ingestion API (`POST /api/public/ingestion`) — deliberately not the OpenTelemetry-based Langfuse v5 SDK, to keep the single-file tsup bundle lean.

- **Token/cost capture** (`src/server/pricing.ts`): every API engine's response `usage` is normalized by the shared provider mappers (`mapAnthropicUsage` / `mapOpenAIUsage` / `mapGeminiUsage` — OpenAI/Gemini subtract cached tokens out of the prompt count per VIB-1766) into a provider-neutral `TokenUsage`; `computeCost()` estimates USD from an approximate price table. `reportModelUsage()` is the single chokepoint that emits the `agent-usage` log (regardless of Langfuse config) **and** the Langfuse generation. It is reused by the agentic engine adapter (`callAgentAPI`) **and** the direct-SDK paths that bypass it: single-call streaming chat (`ai-engines.ts streamWith*`), AI design/styleguide extraction (`design-extractor.ts`), and the legacy converter (`claude-api.ts`). CLI engines have no usage. **Full I/O capture (VIB-1862):** API-engine generations record the real SDK input (`{ system, messages }`) and output (structured data or text) via `reportUsage`; generation payloads use a larger `MAX_GENERATION_FIELD_CHARS` (200 KB) so guide-laden prompts + large module JSON are captured effectively in full, while trace/span summaries keep the tight `MAX_FIELD_CHARS` (24 KB).
- **Nested data model** (`AsyncLocalStorage`): **trace = one user action**, **span = one pipeline stage**, **generation = one model call**.
  - `runWithTrace()` opens a trace and sets `sessionId = themeName` (Langfuse session = vibeSpot theme). Called around `runAgentPipeline` and `runFigmaConversion` (`ai-handler.ts`), brand enrichment (`brand-enrichment.ts`), and the brand-extract routes (`routes/templates.ts`, the WS `extract_brand_assets` handler in `server.ts`). Without this scope, `recordGeneration` still emits a standalone trace so a one-off call is never lost. `setTraceOutput(output)` (VIB-1862) sets the trace's **output** — it emits a second id-keyed `trace-create` for the active trace carrying just the (truncated) output, which Langfuse upserts onto the existing trace; the pipeline handlers call it at the end of each run with a compact `summarizePipelineOutput()` (module names/count, order, stats, page ids, assistant message) so the Traces list shows a meaningful result preview. No-op when disabled or outside a trace scope.
  - `runWithSpan(name, fn)` pushes a span id into the same ALS store. The pipeline stages wrap their calls: `intent-analyzer`, `design-system`, `module-planner` / `site-module-planner` (in the stage files), and `module-development` (around the parallel `runModuleDeveloper` / Figma conversion loop, at the orchestrator). Extraction flows use `extract-styleguide` / `extract-brandvoice` / `extract-theme-context` spans.
  - `recordGeneration()` reads the active trace **and** innermost span from ALS, attaching each generation to its span via `parentObservationId`. The module-development stage's N parallel calls (plus retries) all nest under the one `module-development` span, so a page reads `trace → stage spans → N module generations` with cost rolling up at every level. Span context propagates correctly through the concurrency limiter (queued tasks resume in their own ALS context). Each registry-managed stage call also passes `AgentCallOptions.prompt = stagePromptLink(id)` (`prompts/registry.ts`), so `recordGeneration` sets `promptName` (`vibespot-stage-{id}`) + `promptVersion` on the generation — linking it to the managed prompt in the Langfuse UI for per-prompt-version cost/latency/quality (VIB-1861). Only the page path is linked; the email/blog variants use non-registry builders.
- **Opt-in / fail-safe**: **off by default** — requires an explicit opt-in (`langfuseEnabled:true` in config, the AI Settings toggle, or `LANGFUSE_ENABLED=true`) **and** both `langfusePublicKey` + `langfuseSecretKey` set (config or `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` env; `langfuseBaseUrl`/`LANGFUSE_BASE_URL` defaults to `https://cloud.langfuse.com`). Keys alone never enable it, so a stray `LANGFUSE_*` in a user's environment never silently sends traces (VIB-1833). The eval harness passes `--langfuse`, which sets `LANGFUSE_ENABLED=true` for that run. These are also editable from the AI Settings panel's **Observability** section (`renderObservabilitySection` in `ui/settings.js`): keys reuse the masked `/api/settings/apikey` flow (providers `langfuse-public` / `langfuse-secret`), the base URL + enable toggle go through the generic `/api/settings` route, and `detectEnvironment().apiKeys.langfusePublic|langfuseSecret` carry the masked status to the UI. `runWithSpan` is a transparent pass-through when Langfuse is disabled or no trace is active. All network/serialization errors are swallowed — a Langfuse outage never blocks or fails generation. Inputs/outputs are truncated before send.
- **Per-page cost display** (`src/server/cost-tracker.ts`, VIB-1770): surfaces the captured cost to users and is **independent of Langfuse** — it works with no keys configured. `runWithCostTracking(fn)` opens its own `AsyncLocalStorage` accumulator scope around the pipeline run (`handleAgenticGenerate` / `handleFigmaImport`, wrapping the existing `runWithTrace`); `recordCostSample(model, usage)` is called from the same `reportModelUsage` chokepoint and sums every model call's tokens + `computeCost()` USD into a `PageCost`. Outside a scope (the legacy single-call paths) it's a no-op. The handler attaches `PageCost` to `PipelineResult.cost`; `server.ts` persists it on the chat message (`PipelineMetadata.cost`, re-rendered from history), rolls it into the per-theme running total (`session.costTotal`, via `addProjectCost`), and emits a `generation_cost` WS event. The UI (`ui/chat.js`) shows a per-message cost line and a per-project total chip in the chat header. Unpriced (unknown-model) calls flip `costComplete=false` → shown as a lower bound (`≥`); CLI engines report no usage so nothing is shown. Visibility only — no billing/credits/quotas.
- **Usage observer hook**: `onModelUsage(observer)` in `langfuse.ts` lets dev/CI tooling subscribe to every completed model call (engine/model/usage/cost/latency). It fires from `reportModelUsage` regardless of Langfuse config; no listener = no-op (zero production impact). Used by the eval harness below. (Distinct from the per-page cost tracker above: the observer is a global fan-out for tooling; `cost-tracker.ts` is a scoped per-generation accumulator for the user-facing total.)

### Provider-comparison eval harness (`test/eval/`, VIB-1768)

Internal dev/CI tooling (Langfuse Phase 2), **not** shipped to end users. `npm run eval` compares model providers on module generation across a dataset of reference landing-page briefs (`dataset.ts`), scoring **accuracy** (raw-output `validator.ts` pass-rate + structural coverage + LLM-as-judge in `scoring.ts`/`judge.ts`), **cost** (shipped `computeCost` via the `onModelUsage` hook → `usage-collector.ts`), and **latency**, ranked into a markdown + JSON report (`report.ts`). It runs the real `runAgentPipeline` per provider (capturing raw modules from `module_progress` events before the auto-fixer). With no API keys it falls back to a deterministic offline **mock** mode so CI works; `--providers=anthropic,openai,gemini` runs the real comparison; `--langfuse` registers the run as a Langfuse experiment (`langfuse-dataset.ts`: dataset + dataset-run-items + scores). Runs sequentially per (provider, page) since the usage hook is process-global. See `test/eval/README.md` + `PROVIDER-COMPARISON.md`.

**Judge calibration** (`npm run eval:calibrate`, `calibrate-judge.ts` + `calibration-set.ts`, VIB-1863) — the eval and the benchmark lean on the LLM-as-judge (`judge.ts`), so the judge itself is validated against ground truth (the langfuse-skill `judge-calibration` reference). Simple-mode calibration: a small fixed set of pages carry **human PASS/FAIL labels** (hand-authored unambiguous + a couple of borderline probes), the judge scores each page without seeing the label, its `overall` is binarised via a `--threshold` (default 0.70), and the harness reports valid/invalid-label counts, exact-match accuracy, a threshold sweep, and a ship/retune/iterate recommendation. `--langfuse` registers a `vibespot-judge-calibration` dataset experiment and pushes `judge-exact-match` (per row) + `judge-accuracy` (run aggregate) through the same direct-REST score path in `langfuse-dataset.ts`. Sample output: `test/eval/JUDGE-CALIBRATION.md`. (Calibration drove the threshold-retune in VIB-1864 — the judge discriminates cleanly between good and bad pages, but the binarisation cut-point had to be lowered to match where that separation actually falls.)

### AI Engine Design

All engines implement the `AIEngine` interface in `src/ai/engine.ts` (used by single-call mode and wizard).

The agentic pipeline uses `AgentEngine` type and `callAgent()` from `src/server/agent/engine-adapter.ts` which supports both API engines (with structured output) and CLI engines (with subprocess spawning).

**Anthropic API mode** (`src/ai/claude-api.ts`): Uses `@anthropic-ai/sdk` with sequential API calls. Model: `claude-sonnet-4-20250514`.

**OpenAI API mode**: Uses native fetch with OpenAI-compatible streaming API. Supports any OpenAI model.

**Gemini API mode**: Uses native fetch with Google Gemini streaming API.

**Claude Code mode** (`src/ai/claude-code.ts`): Spawns `claude --print` as a subprocess. **Context isolation (VIB-1855):** every `claude` spawn passes `--strict-mcp-config` (zero MCP servers, ignoring the user's configs) and runs in a dedicated empty temp `cwd` (`getIsolatedClaudeCwd` in `ai-engines.ts`) so the CLI can't inherit the user's MCP tool schemas or an ambient project `CLAUDE.md` — otherwise both load on top of our payload and overflow the 200k window ("Prompt is too long"). `CLAUDE_ISOLATION_FLAGS` is the shared flag list, applied in both `engine-adapter.ts:resolveCLIBinary` (agentic) and `ai-engines.ts:generateWithClaudeCode` (single-call). `buildStateContext` (`ai-prompts.ts`) token-budgets injected page state; `mapClaudeCliError` maps the raw too-long string to an actionable message.

**Gemini CLI mode / Codex CLI mode**: Both are thin configs over the shared `SimpleCLIEngine` (`src/ai/cli-engine.ts`, VIB-1902), which pipes the prompt via stdin through the maintained `spawnCLI` helper (strict exit-code handling, timer cleanup, abort support) and then scans the theme directory for generated files.

### Vibe Coding Mode

The default command (`vibespot` or `npx vibespot`) starts a local HTTP server and opens the browser. The web UI has:
- Setup screen with sidebar project list (create/fetch/open/resume theme) and starter template picker
- Starter templates: 5 pre-built page bundles (SaaS, portfolio, restaurant, event, coming soon) that bootstrap a new theme with modules and shared CSS/JS — instant preview with no AI wait. `GET /api/starters` lists them; `POST /api/setup/create` with `starterId` bootstraps from one.
- Project deletion with confirmation dialog and optional local file removal
- Chat panel with pipeline progress UI (stages, module cards, quality check)
- Live preview via HubL subset renderer with incremental module rendering
- Field editor sidebar for editing module field values
- Module list with reordering (drag-and-drop) and per-module deletion
- Responsive preview toggle (desktop/tablet/mobile)
- Upload to HubSpot with celebration popup, confetti, and regional HubSpot link
- Hash-based routing (#/app/themeName)
- Version history via git commits (auto-commit after each AI generation)

### Preview trust boundary (`src/server/preview-origin.ts` + `preview-protocol.ts`, VIB-1892)

The live preview renders **AI-generated HTML/JS**, so it runs on a **separate origin** (started with the app server at app port + 2). The iframe (`#preview-frame`) loads `http://<host>:<port+2>/?t=<token>` — never `srcdoc` for generated content — making all generated code cross-origin to the app: it cannot touch the app DOM, cookies, or `/api/*`. The preview origin's whole surface is the composed doc, `GET /preview-agent.js`, and token-gated `/theme-assets/*`; everything else 404s. The composed doc ships under `connect-src 'none'` + pinned `frame-ancestors`. The UI discovers the origin+token via `GET /api/preview-origin` (behind the app auth gate).

In-frame interaction (inline editing, section controls, highlights, working overlays) is owned by the trusted agent `ui/preview-agent.js`, injected at the top of `<head>` together with a config block and the per-module field definitions (`buildFieldsMap`). Parent (`ui/preview.js`) and agent talk over the vs:* postMessage protocol defined in `src/server/preview-protocol.ts` — every message is checked for peer origin, per-boot token, protocol version, and a direction-scoped verb allow-list. The **only write verbs are field edits** (`vs:edit-commit`, `vs:field-commit`), which the parent maps onto `POST /api/field` (`ui/inline-edit.js`, `ui/section-controls.js`) through the shared save module `ui/field-save.js` (VIB-1898) — per-field-keyed debounce, per-field POST ordering, also used by the field editor sidebar; behavior locked by `test/field-save.test.ts`. The agent may additionally *request* dropping back to view mode (`vs:request-mode`, sent on Esc with no editor open) — read-only, honoured only as an exit-to-view, with the parent re-issuing `vs:set-mode`. Never widen this vocabulary with privileged verbs; the browser copies of the verb strings are locked to the TS module by `test/preview-protocol-parity.test.ts`. Tests: `test/preview-origin.test.ts`, `test/preview-protocol.test.ts`.

### Server security (`src/server/security.ts`, VIB-1889)

The local server defaults to a `127.0.0.1` bind (`VIBESPOT_HOST` overrides; the Docker image sets `0.0.0.0`). Every route except `/healthz` passes an auth gate in `handleRequest`; the WebSocket upgrade enforces the same gate **plus** an Origin allow-list via `verifyClient` (browsers don't apply CORS to WebSockets). Policy: loopback requests with a local `Host` header are trusted (the Host check defeats DNS rebinding); any non-loopback bind requires a shared-secret token (`VIBESPOT_AUTH_TOKEN` or generated at boot, printed in the URL) accepted as Bearer / `X-Vibespot-Token` / `?token=` / session cookie — the `?token=` page load sets the cookie and redirects, so the UI needs no auth code. `VIBESPOT_DISABLE_AUTH=1` is for deploys behind their own gate (docker-compose.auth.yml sets it). State-changing API requests with a disallowed browser Origin get 403. `readBody` (route-helpers) caps buffered bodies at 5 MB → 413. Client-facing error messages go through `publicErrorMessage()` (errors.ts), which redacts home-directory paths. Tests: `test/security.test.ts`.

### AI Response Parsing (`ai-handler.ts`)

In single-call mode, the AI outputs modules in a ````vibespot-modules` JSON code block. The parser:
1. Extracts `vibespot-modules` blocks via regex
2. Attempts `JSON.parse()`, with auto-repair for unescaped quotes (up to 20 iterations)
3. Falls back to generic ````json` blocks containing a `"modules"` array
4. Warns the user if modules were described in prose but no structured JSON was provided
5. Warns if the response contained `vibespot-modules` references but JSON parsing failed

In agentic mode, the pipeline uses structured output (JSON schema) for reliable parsing.

### Auto-Fix Patterns

Two layers of auto-fix:

**Quality Check agent** (agentic pipeline, `stages/validator.ts`):
- Runs before modules reach the user or HubSpot
- Fixes: unbalanced HubL tags, reserved field names, deprecated types, CDN imports, `now()`, meta.json fields

**Upload auto-fix** (`auto-fix.ts`):
- Runs on HubSpot upload failure, then retries
- Fixes: `textarea` → `text`, reserved names, `now()` → `local_dt`, CDN imports, HubDB templates, stuck uploads

### Session Management (`src/server/session/`)

Split into focused submodules:
- `state.ts` — Module mutations (`updateModules`, `deleteModule`, `updateFieldValue`), case-insensitive module matching
- `store.ts` — Session CRUD, persistence to `~/.vibespot/sessions/`
- `disk.ts` — Theme file I/O, git operations, module scanning
- `templates.ts` — Template management (create, clone, delete, reorder)
- `types.ts` — `SessionData`, `TemplateEntry`, `ChatMessage`, `SessionSnapshot`

Each session tracks:
- Theme name/path, module data, module order, shared CSS/JS
- Chat messages (user + assistant) with pipeline metadata
- Templates, version history, brand assets

Key behaviors:
- `deleteSession()` removes all sessions for the same `themeName` (not just one)
- `scanThemeFromDisk()` loads existing modules from a theme directory
- `writeModulesToDisk()` writes session modules back to the theme directory
- `updateModules()` uses case-insensitive name matching to prevent duplicates

### HubSpot Data Center Detection

`detectDataCenter()` in `src/utils/detect.ts` reads `~/.hscli/config.yml` and checks the personal access key prefix (`CiRldTE` = eu1). Used to build correct regional URLs (`app-eu1.hubspot.com` vs `app.hubspot.com`).

### Settings load path (low-latency, VIB-1835)

`GET /api/settings/status` (`handleSettingsStatusRoute`) is **config-only and side-effect-free** — no subprocess, no network — so the settings panel opens instantly. It uses `detectEnvironmentLite()` (`src/utils/detect.ts`), which reads only config/env (API-key flags, Claude OAuth token file, HubSpot API-mode accounts) and returns `scanned:false` with the CLI/auth tools left as "not scanned" placeholders. Dropdowns ship from the inline `STATIC_MODELS`. Engine availability on this path is **optimistic** (enabled CLI engines are listed without verifying install).

The expensive work is on-demand:
- `GET /api/settings/models?refresh=1` (`handleSettingsModelsRoute`) — live provider catalog via `getModelCatalog()`, 10-min cache, `refresh=1` bypasses. Each provider fetch is bounded by `fetchWithTimeout` (2.5s) and the aggregate only caches when fully resolved.
- `GET /api/settings/tools?group=ai|platform|all&refresh=1` (`handleSettingsToolsRoute`) — subprocess detection split by group (`ai` = the 3 AI CLIs via `detectAITools()`, which also returns an accurate `availableEngines`; `platform` = GitHub + HubSpot-CLI via `detectPlatformTools()`; `all` = full `detectEnvironment()`). ~60s per-group server cache; the `gh auth status` / `hs accounts list` probes are capped at `AUTH_PROBE_TIMEOUT_MS` (4s).

Client (`ui/settings.js`): `refreshSettings()` renders instantly from `/status`; `fetchModels`/`fetchTools` layer their results over the fast payload via `applyScanCaches` (module-level `liveModels` / `scannedTools` / `scannedEngines` / `scannedGroups`). Per-tab **Refresh models** / **Scan AI tools** / **Check** buttons trigger the on-demand routes, and one non-blocking background scan (`maybeStartBackgroundScan`, `group=all` + models) runs once per open. (Note: `handleSetupInfoRoute` in `routes/setup.ts` still calls the full `detectEnvironment()` — separate flow, out of scope here.)

### "What's new" release dialog (VIB-1885)

A one-time post-upgrade dialog: the first time the web UI loads on a new version, it shows the release highlights + a changelog link, then stays dismissed until the next release.

- **Content is generated, not hand-kept.** `scripts/gen-whats-new.ts` (`npm run whatsnew:gen`, wired into `npm run build` → so `prepublishOnly` and every build refresh it) parses the **installed version's** section out of `CHANGELOG.md` and writes `assets/whats-new.json` (`{ version, date, changelogUrl, highlights[] }`). Each top-level `- **Bold title** … — body` bullet becomes a highlight (title = bold lead, body = trimmed snippet, markdown/issue-refs stripped, capped at 5). Defensive: any parse failure still writes valid JSON with empty `highlights` (→ `show:false`), so a build never breaks and the dialog never renders empty. **This is the "add it to the release workflow" step** — bumping the version + writing the CHANGELOG section is all a release needs; the next build bakes the matching notes.
- **Server** (`routes/whats-new.ts`): `GET /api/whats-new` → `{ show, content, currentVersion }`, where `show` is true only when the asset has highlights AND `content.version === getVersion()` AND `content.version !== config.lastSeenVersion`. `POST /api/whats-new/dismiss` writes `lastSeenVersion` (new `VibeSpotConfig` field in `~/.vibespot/config.json`).
- **UI** (`ui/whats-new.js`): on load (non-demo), `_wnInitProd()` fetches `/api/whats-new` and, if `show`, renders the modal via `maybeShowWhatsNew()` (reuses the `dialog.js` overlay pattern + design tokens; `role="dialog"`, focus trap, Esc, `prefers-reduced-motion`). Dismissing POSTs to `/dismiss`. A network failure silently skips — the dialog never blocks the app. `?whatsnew=1` (search or post-hash) self-renders the modal with bundled sample content for screenshots/demo.

## Critical Constraints

- **Pure ESM** — `"type": "module"` in package.json. No CommonJS `require()`. All internal imports use `.js` extensions.
- **Single-file bundle** — tsup bundles everything into `dist/index.js`. The `resolveAsset()` function in `src/utils/fs.ts` searches multiple relative paths to find `assets/` from the built output.
- **`import.meta.dirname`** — Used in `resolveAsset()`. tsup's `shims: true` handles this for Node 18 (native support requires Node 21+).
- **`files` in package.json** includes `dist/`, `bin/`, `assets/`, `ui/`, and `starters/` for npm publishing.
- **No CDN imports** — All CSS/JS must be self-contained. The system prompt and auto-fix strip external font imports.
- **Module names** — Always kebab-case (e.g., `hero`, `trust-bar`). The pipeline enforces this via `spec.name`; `updateModules()` uses case-insensitive matching as a safety net.

## Documentation Update Checklist

When a feature or fix ships, update the relevant docs before merging:

| Doc | When to update |
|-----|---------------|
| `CHANGELOG.md` | **Always** — add a version entry |
| `README.md` | User-facing feature or setup change |
| `ui/docs/index.html` | Affects documented features or workflows |
| `CLAUDE.md` | Architecture, constraints, or key behaviors change |

## Related Projects

- **MPMX-2026** (`../MPMX-2026/`) — HubSpot CMS theme where conversion patterns were developed
- **lovable-to-hubspot** (`github.com/borismichel/lovable-to-hubspot`) — Documentation-only repo with the conversion guide

## Parallel Development Rules

These rules prevent code loss when multiple features are developed concurrently in worktrees or branches.

### Branch Lifecycle (Mandatory)

1. **Every feature branch MUST be merged to `main` via PR before the issue is marked done.** A feature is not "done" until its code is on `main`. Marking an issue done while the branch is unmerged is a defect.

2. **Rebase before merge.** When a feature branch has diverged from `main`, create a `-rebased` branch from current `main`, cherry-pick or rebase the work onto it, then open the PR from the rebased branch. Never merge a stale worktree branch directly.

3. **Verify the merge landed.** After merging a PR, confirm the feature's key identifiers (function names, CSS classes, HTML IDs, route paths) exist on `main`. A 30-second grep is cheaper than discovering lost code later.

### Worktree Hygiene

4. **One worktree per feature, short-lived.** Worktrees are for active development only. Once the rebased branch is merged, remove the worktree and delete the local branch.

5. **Never leave orphan worktrees.** Before closing a milestone, run `git worktree list` and verify every worktree either has a merged PR or an open PR. Orphan worktrees with unmerged work are the primary source of code loss.

### Merge Order & Conflict Resolution

6. **Merge features sequentially to `main`.** When N features are ready in parallel, merge them one at a time. Each subsequent feature rebases onto the updated `main` before its PR. This ensures each merge resolves conflicts against the true current state.

7. **After resolving conflicts, re-run the validation test.** `npm run build && npx tsx test/validate.ts` — a conflict resolution that compiles is not necessarily correct.

### Pre-Milestone Checklist

Before tagging a release or declaring a milestone complete:

- [ ] `git branch --no-merged main` returns no feature branches with unshipped work
- [ ] `git worktree list` shows only the main worktree (or worktrees for active in-progress issues)
- [ ] All issues marked `done` have their code on `main` (spot-check: grep for 2-3 key identifiers per feature)
- [ ] CHANGELOG.md lists every shipped feature
- [ ] `npm run build` succeeds on `main`
