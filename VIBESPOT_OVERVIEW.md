# vibeSpot — System Overview

> A planning-committee briefing on what vibeSpot is, what it does, and how it works.
> Current version: **1.0.10** · Codebase: ~84 TypeScript modules (`src/`) + 10 UI scripts (`ui/`)

---

## 1. Executive Summary

**vibeSpot is an AI-powered HubSpot CMS landing page builder.** It lets a non-engineer describe a page in plain English (or paste a Figma URL) and have a deployable, native HubSpot CMS theme — modules, fields, templates, CSS, JS — generated, previewed locally, and uploaded to a HubSpot portal in a single workflow.

It ships as a single npm CLI (`vibespot`) that spawns a local HTTP/WebSocket server and opens a browser. The UI is a chat-on-the-left, live-preview-on-the-right "vibe coding" workspace — augmented by a Plan tab for deliberation before generation, a Code tab for direct file inspection, and a Dashboard view for managing multiple templates per theme.

Under the hood it runs a multi-stage **agentic pipeline** (Intent Analyzer → Page Architect → Module Developer → Quality Check) on top of any of seven supported AI engines (Anthropic, OpenAI, Gemini, plus Claude Code / Gemini CLI / Codex CLI subprocesses, plus Claude OAuth). All artifacts persist on disk in standard HubSpot CMS format, version-controlled by git, and uploaded over the HubSpot Source Code API.

It is opinionated: it generates **HubL-native modules** (not React, not iframes, not generic HTML) so the output is fully editable in HubSpot's drag-and-drop editor by HubSpot users.

---

## 2. Purpose & Positioning

### Problem
Building HubSpot CMS landing pages today requires either:
- a HubSpot CMS developer (HubL syntax, fields.json schema, module conventions, theme structure), or
- the in-portal drag-and-drop editor (slow, limited to existing modules, no design fidelity).

There is **no AI-native authoring surface** that produces production HubSpot modules. Tools like Lovable, v0, Bolt produce React/Next.js, which doesn't deploy to HubSpot. Tools like Webflow, Framer don't integrate with HubSpot's CMS or content model.

### Solution
vibeSpot fills the gap. It accepts vague natural-language briefs, optional Figma references, optional uploaded brand assets, and produces HubSpot-native CMS themes that deploy with a click.

### Target users
- **Marketing teams** at HubSpot-heavy companies who want to ship pages without engineering tickets.
- **HubSpot agencies / partners** who want to scale page production.
- **HubSpot CMS developers** who use it as a force multiplier — generate the scaffold, then refine in code.
- **Designers** who can convert a Figma file directly to an editable HubSpot module without re-implementation.

### What it explicitly is *not*
- Not a hosted SaaS (it is a local CLI; pages live in the user's HubSpot portal, not on vibeSpot infrastructure).
- Not a general-purpose website builder. HubSpot CMS is the target output.
- Not a Figma-to-React pipeline. Figma assets become HubL modules.

---

## 3. Functional Overview

vibeSpot has two user-facing surfaces and four primary workflows.

### Surfaces
1. **Web UI ("vibe coding mode")** — the default. Run `vibespot` and the browser opens to a chat workspace.
2. **CLI wizard** — `vibespot wizard` walks through theme setup interactively in the terminal. One-shot scaffolding for new projects.

### Workflows

| Workflow | Trigger | Output |
|---|---|---|
| **Conversational generation** | Chat in the web UI ("Build me a SaaS landing page for…") | HubSpot modules + template, live-previewed and committed to git |
| **Plan mode** *(new)* | Toggle Plan Mode in chat → describe goals → answer elicitation questions → approve | A markdown plan file, then a generated theme guided by it |
| **Figma import** | Paste Figma URL → extract → name theme → generate | Modules whose colors, text, layout, and assets match the Figma design |
| **HubSpot upload** | "Deploy" button (or `vibespot upload`) | Theme uploaded to selected HubSpot account; auto-fix retry on failure |

Secondary commands: `vibespot init` (scaffold a theme dir), `vibespot convert` (run conversion only), `vibespot doctor` (diagnose env: Node/git/HubSpot CLI/API keys/credentials).

---

## 4. User Experience

### 4.1 First-run / onboarding
On first launch with no AI engine and no themes, a walkthrough modal explains the model. The setup screen surfaces:
- Connect HubSpot (Personal Access Key paste, or HubSpot CLI if installed)
- Choose AI engine (auto-selects first available; offers API-key entry for any engine)
- Create a theme (name → scaffold) or fetch one from HubSpot or load from disk

The left edge always shows a **project rail** — every theme/session the user has worked on. Click to switch projects instantly.

### 4.2 Vibe coding mode (the main surface)
Two-panel workspace:

```
┌──────────────────────────┬──────────────────────────────────┐
│                          │ ┌──────────────────────────────┐ │
│  CHAT                    │ │ Preview │ Plan │ Code        │ │
│  ────                    │ ├──────────────────────────────┤ │
│  • messages              │ │                              │ │
│  • module list           │ │   live HubL preview          │ │
│  • file uploads          │ │   (responsive: phone/tab/dt) │ │
│  • plan-mode toggle      │ │                              │ │
│  • input + send          │ │                              │ │
│                          │ └──────────────────────────────┘ │
└──────────────────────────┴──────────────────────────────────┘
```

- **Left panel** holds the chat and the module list (drag-reorder, edit fields, delete per-module).
- **Right panel** has a three-tab view: Preview (live HubL render), Plan (markdown plan in plan mode), Code (CodeMirror editor over generated files).
- Chat accepts text, drops, image uploads (PDFs, MD, DOCX, images). Uploaded files become context for the AI.
- Sessions persist; chat history survives restarts.

### 4.3 Plan mode (deliberation phase)
A prominent labeled toggle next to the chat input switches the system into **plan mode**. Mechanics:
1. Each chat message routes to a plan-focused AI prompt with three implicit phases: **Understand → Research → Refine**.
2. The AI emits a markdown plan inside a `vibespot-plan` fenced block on every response. The plan is parsed out, written to `{theme}/.vibespot/plan.md`, and rendered in the right-pane Plan tab.
3. The AI may also emit a `vibespot-choices` JSON block to render clickable answer chips — fast gap-filling for known options.
4. The user can edit the plan inline (textarea in the Plan tab) and save changes directly.
5. **Hard write-gate**: while plan mode is active, the server *refuses* to enter the agentic pipeline, even if the AI tries to emit a `vibespot-modules` block. Generation only happens via the explicit **Approve plan** button.
6. On approval, plan mode flips off, the plan is prepended to the user message as a design brief, and the agentic pipeline runs against the approved spec.

### 4.4 Figma import
Paste a Figma URL → vibeSpot extracts via Figma API:
- Design tokens (colors with usage counts, typography styles, spacing scale, effects like shadows/border radii)
- Section structure (top-level frames → modules)
- Image assets (downloaded as PNGs to `{theme}/assets/`)
- Per-section text content with role/font-size annotations

A **streamlined translation pipeline** then converts each section to a HubL module — *deterministic CSS generation* (no AI guessing tokens), *AI-assisted HubL translation* (only the per-section markup decision is left to the model). Result: modules that match Figma's exact colors, copy, spacing, and section order.

A toggle ("Import images as assets") chooses whether images become `get_asset_url()` references (true to design) or HubSpot image fields with placeholders (editable in HubSpot's editor).

### 4.5 Live preview & code view
- Preview renders via a custom **HubL subset interpreter** (`src/hubl/renderer.ts`) — no HubSpot round-trip needed. Supports variables, filters, conditionals, loops, asset URLs.
- Responsive toggle (desktop / tablet / mobile / full-width) with proper viewport simulation.
- Code tab opens a CodeMirror editor with file tree (theme.css, animations.js, per-module HTML/CSS/JS/fields.json). Read-focused; future versions will support direct edits.
- Version history button shows a git timeline; user can roll back to any commit (per-template scope, so one template's rollback doesn't affect others).

### 4.6 Field editor & module operations
- Click the gear icon on a module in the sidebar → opens a side panel with editable fields (text, image, color, link, etc.) — same editor experience HubSpot users get in-portal.
- Drag-reorder modules in the sidebar to reorder the page; preview re-renders.
- Delete a module (× icon) with confirmation.

### 4.7 Upload to HubSpot
- "Deploy" button uploads the theme to the active HubSpot account.
- Concurrency-limited parallel upload (default 5 workers).
- On error: parses the HubSpot API error, applies known auto-fixes (textarea→text, reserved field renames, color format normalization, deprecated function rewrites), retries.
- Celebration popup on success with confetti and a regional HubSpot link to view the theme in Design Manager (NA → `app.hubspot.com`, EU → `app-eu1.hubspot.com`).

---

## 5. Technical Architecture

### 5.1 Stack
- **Language**: TypeScript (strict, ESM-only)
- **Runtime**: Node.js 18+
- **Build**: tsup → single-file ESM bundle (`dist/index.js`, ~300KB)
- **CLI framework**: Commander
- **Server**: Node's built-in `http` + `ws` for WebSocket
- **Frontend**: vanilla HTML/CSS/JS (no React, no build step). CodeMirror 6 vendored for the code view.
- **Persistence**: filesystem (JSON sessions, markdown brand assets, theme directories)
- **Git**: invoked as subprocess (graceful degradation if absent)
- **HubSpot**: REST API + Source Code API, OAuth-via-PAK token exchange
- **Figma**: REST API for nodes + image export

### 5.2 Process model
- One process per CLI invocation.
- Local HTTP server binds to an available port (auto-finds next free starting from a default).
- Browser opens automatically to `http://localhost:PORT`.
- WebSocket upgrades on the same server. Single connection per browser tab.
- All AI calls and HubSpot uploads happen in-process. No background workers, no daemons.
- The server holds **one active session in memory** at a time; switching projects swaps it.

### 5.3 Directory layout

```
src/
├─ index.ts                  # CLI entry
├─ cli/                      # Commander program, banner, color theme
├─ commands/                 # One file per subcommand (init, wizard, convert, upload, doctor)
├─ wizard/                   # CLI wizard step modules (preflight, source, theme-setup, …)
├─ ai/                       # Single-call mode AI clients (legacy, still used)
├─ server/                   # The web UI server
│  ├─ server.ts              # HTTP + WebSocket entry, route table
│  ├─ session/               # Session CRUD, multi-template, disk I/O
│  ├─ routes/                # HTTP route handlers (settings, themes, templates, plan, figma, …)
│  ├─ agent/                 # Agentic pipeline, prompts, engine adapters
│  │  ├─ pipeline.ts         # 4-stage orchestrator
│  │  ├─ engine-adapter.ts   # Multi-engine `callAgent()` interface
│  │  ├─ figma-pipeline.ts   # Streamlined Figma → HubL converter
│  │  ├─ stages/             # intent-analyzer, page-architect, module-developer, validator,
│  │  │                        context-extractor, brandvoice-extractor
│  │  └─ prompts/            # System prompts + JSON schemas (intent-analyzer,
│  │                           page-architect, module-developer, plan-mode)
│  ├─ figma/                 # Figma extractor (REST + image download)
│  ├─ preview.ts             # Builds the HubL preview HTML
│  ├─ project-git.ts         # Git wrapper for version history
│  ├─ auto-fix.ts            # HubSpot upload error → fix + retry
│  ├─ ai-handler.ts          # Coordinates engine selection, single-call vs agentic
│  ├─ ai-engines.ts          # Streaming clients for each engine
│  ├─ ai-parser.ts           # Parses `vibespot-modules` blocks from AI output
│  └─ plan-parser.ts         # Parses `vibespot-plan` and `vibespot-choices` blocks
├─ hubl/                     # Lightweight HubL interpreter for preview rendering
├─ hubspot/                  # HubSpot REST + Source Code API client
└─ utils/                    # config, fs, detect (HubSpot CLI / data center / engines)

ui/
├─ index.html                # Single-page app shell
├─ chat.js                   # WebSocket dispatcher, chat rendering, pipeline UI
├─ plan.js                   # Plan-mode controller (toggle, pane, editor, choice chips)
├─ setup.js                  # Onboarding, project rail, navigation
├─ dashboard.js              # Multi-template dashboard
├─ preview.js                # Preview iframe management
├─ code-editor.js            # CodeMirror integration
├─ field-editor.js           # Module field editor sidebar
├─ settings.js               # Settings panel
├─ upload-panel.js           # Upload progress + auto-fix dialog
└─ styles.css                # All styles (~4200 lines)

assets/                      # Bundled prompts/guides shipped to AI
├─ conversion-guide.md       # Lovable/React → HubL conversion patterns
├─ design-guide.md           # CSS/layout conventions
├─ content-guide.md          # Tone, copy guidelines
├─ hubspot-rules.md          # Reserved field names, deprecated types, etc.
└─ humanify-guide.md         # "Make this not sound like AI" guidance
```

### 5.4 Build & packaging
- `npm run dev` runs source directly via `tsx` (no build).
- `npm run build` produces `dist/index.js` via tsup; bundles everything as ESM with shims for `import.meta.dirname` (Node 18 compat).
- `bin/vibespot.mjs` is the npm-published entry, simply invoking the bundle.
- `package.json` `files`: `dist/`, `bin/`, `assets/`, `ui/` — all four directories must travel together.
- Pure ESM (`"type": "module"`); all internal imports use `.js` extensions even in `.ts` files (TypeScript ESM convention).

---

## 6. AI / Agent System

### 6.1 Multi-engine support
Seven AI engines, all unified behind a single `callAgent()` interface:

| Engine | Type | Streaming | Structured output |
|---|---|---|---|
| `anthropic-api` | REST | yes | JSON schema |
| `claude-oauth` | REST (Claude.ai OAuth tokens) | yes | JSON schema |
| `openai-api` | REST | yes | JSON schema |
| `gemini-api` | REST | yes | JSON schema |
| `claude-code` | local CLI subprocess | yes | prompt-extracted JSON |
| `gemini-cli` | local CLI subprocess | yes | prompt-extracted JSON |
| `codex-cli` | local CLI subprocess | yes | prompt-extracted JSON |

Engine choice is per-user via Settings; auto-detection picks the first available. CLI engines need only the binary on `PATH` (no API key).

### 6.2 Two generation modes

**Single-call mode** — the legacy path. One AI call, asks the model to produce a `vibespot-modules` JSON block. Used as the default for the first conversation, and as a fallback for engines or scenarios where agentic mode isn't viable.

**Agentic mode** — the default, opt-in via a one-time prompt. Decomposes generation into discrete stages with structured output, parallel module generation, and rule-based validation:

```
┌──────────────────┐  intent: create | modify | add | remove | rearrange |
│ Intent Analyzer  │          style_change | text_change | question
└────────┬─────────┘  → plans which modules to gen, modify, keep, reuse
         │ short-circuits "question" intent (just answers, no generation)
         ▼
┌──────────────────┐  2a. Design System: :root vars, shared CSS/JS
│ Page Architect   │  2b. Module Planner: specs (name, brief, layout)
└────────┬─────────┘  → emits `design_system_ready` and `blueprint_ready`
         │            events for incremental preview placeholders
         ▼
┌──────────────────┐  Parallel per-module generation
│ Module Developer │  (concurrency-limited, default 20)
└────────┬─────────┘  Each module: HTML + CSS + JS + fields.json + meta.json
         │            Streams `module_progress` events per module
         ▼
┌──────────────────┐  Rule-based auto-fix:
│ Quality Check    │  • unbalanced HubL tags (stack-based balancer)
└──────────────────┘  • reserved field names (name → item_name, label → section_label)
                     • deprecated field types (textarea → text)
                     • CDN @import stripping
                     • now() → local_dt
                     • missing meta.json required fields
```

All stages emit typed `PipelineEvent`s over WebSocket, which the UI uses to render a live progress bubble (stage spinners, module cards transitioning queued → generating → complete/failed, quality-check summary).

### 6.3 Plan mode (deliberation layer)

A *third* mode, layered above the others, controlled by a single config flag (`planMode: boolean`).

When active, the chat handler refuses to enter the agentic pipeline. Instead it routes messages to a **plan-focused AI prompt** that:
- Operates in three phases (Understand / Research / Refine), keyed off conversation turn count.
- Asks elicitation questions, surfaces gaps in the user's brief.
- Maintains a markdown plan in `{theme}/.vibespot/plan.md`, accumulating across turns.
- Optionally emits structured choice chips via a `vibespot-choices` JSON block, rendered as clickable answer buttons in chat.

When the user clicks **Approve plan**:
1. The server flips `planMode` off.
2. The approved plan is prepended to the synthesized user message ("Implement the approved plan.") as a `## Approved plan` section.
3. The agentic pipeline runs with the plan as a high-fidelity design brief.

The plan also persists across sessions: open the same theme weeks later, plan mode picks up where it left off (loaded from `.vibespot/plan.md`).

This is **inspired by Claude Code's plan mode**, with adaptations for the HubSpot/landing-page domain (markdown plan as the primary artifact, choice chips for fast gap-filling, inline edit in the right pane).

### 6.4 Brand asset extraction (post-pipeline, background)
After successful generation, two extractors run in the background (never blocking the user):
- **Styleguide**: analyzes the rendered preview to extract brand voice, audience, value props, terminology.
- **Brand voice**: extracts tone, vocabulary (preferred/avoided), sentence style, dos/don'ts.

Both store to `session.brandAssets` (in memory) and `{theme}/.vibespot/{styleguide|brandvoice}.md` (on disk). They are then **fed back into subsequent AI calls** via system prompts, so successive generations stay on-brand without the user re-stating context.

### 6.5 Figma translation pipeline (parallel system)
A separate, narrower pipeline for Figma imports — bypassing the full agentic flow because the design decisions are already made:
1. **Deterministic CSS generation** — design tokens map mechanically to `:root` CSS variables and utility classes. No AI involved.
2. **Section → spec mapping** — each Figma section becomes one module spec with the section's exact text/layout.
3. **AI translation only** — for each spec, the AI translates the Figma section into a HubL module using the *same* Module Developer prompt as the agentic pipeline. Parallel, concurrency-limited.
4. **Validation** — the same auto-fix layer.

Result: modules that *translate* a design rather than *re-invent* it.

### 6.6 Prompt caching
For Anthropic engines, system prompts are built as cacheable blocks (`cache_control: { type: "ephemeral" }`). Repeated calls within the cache window (5min) reuse the cached prompt. Substantial cost reduction on multi-stage pipelines and agentic mode where many calls share identical system context.

---

## 7. Data Flow & State Management

### 7.1 Session model
A **session** represents one user's work on one theme. Stored as JSON at `~/.vibespot/sessions/{sessionId}.json`. The shape:

```ts
VibeSession {
  id, themeName, themePath, createdAt, updatedAt
  templates: TemplateEntry[]      // ← multi-template support
  activeTemplateId: string
  brandAssets: { styleguide, brandvoice, themeContext, plan, humanify }
  assets: SessionAsset[]          // uploaded files (images, docs)
  // legacy flat fields (kept in sync with active template):
  modules, moduleOrder, sharedCss, sharedJs, template, messages
}
```

Each `TemplateEntry` is itself complete (its own modules, moduleOrder, sharedCss, sharedJs, template HTML, chat messages). Templates can be `landing_page`, `blog_post`, `website_page`, or `module_only` (a shared component library with no page template).

### 7.2 Sync mechanism
The flat session fields (`session.modules`, `session.messages`, etc.) are kept in sync with the active template via two helpers:
- `syncFlatFieldsFromTemplate()` — copy template → flat (called when switching templates)
- `syncFlatFieldsToTemplate()` — copy flat → template (called after every mutation)

Most internal code reads/writes the flat fields. The active template is the source of truth on save.

### 7.3 Disk persistence
For each theme, vibeSpot writes:

```
{themePath}/
├─ theme.json                  # HubSpot theme metadata
├─ templates/                  # one .html per template
├─ modules/                    # one .module/ dir per module
│  └─ <name>.module/
│     ├─ fields.json
│     ├─ meta.json
│     ├─ module.html
│     ├─ module.css
│     └─ module.js (optional)
├─ css/<theme>-theme.css
├─ js/<theme>-animations.js
├─ assets/                     # images (incl. Figma exports)
└─ .vibespot/                  # vibeSpot-specific, gitignored from HubSpot upload
   ├─ chat.json                # chat history (survives session deletion)
   ├─ plan.md                  # current plan (plan mode)
   ├─ styleguide.md            # extracted brand styleguide
   ├─ brandvoice.md            # extracted brand voice
   └─ theme-context.md         # extracted product context
```

The session JSON in `~/.vibespot/sessions/` is the *primary* state; theme files on disk are derived (via `writeModulesToDisk()`). Themes can also be loaded *from* disk (via `scanThemeFromDisk()` — modules from `.module/` dirs, templates from `.html` files, brand assets from `.vibespot/`).

A session index `~/.vibespot/sessions/_index.json` summarizes all sessions (for the project rail) — auto-rebuildable from the session files.

### 7.4 Git versioning
- Each theme directory is a git repo (auto-initialized).
- Every successful AI generation auto-commits.
- Two commit scopes: **per-template** (commit message prefixed `[templateId]`) and **per-theme** (entire workspace).
- History view in the UI shows commits with timestamps, filterable by template.
- Rollback creates a new commit (linear history; no destructive resets).
- All git operations gracefully no-op if git isn't installed (project still works, just without history).

---

## 8. HubSpot Integration

### 8.1 Authentication
- **Personal Access Keys (PAKs)** — exchanged for short-lived OAuth tokens via `/localdevauth/v1/auth/refresh`. Cached with a 5-minute refresh buffer.
- **Multi-account support** — users can connect multiple HubSpot portals; switch between them in Settings.
- **Data center detection** — PAK prefix (`pat-eu1-…` vs `pat-na1-…`) determines whether to call `app.hubspot.com` or `app-eu1.hubspot.com`. Used for upload links and OAuth flows.
- Falls back to **HubSpot CLI** (`hs cms fetch`, `hs cms upload`) if no PAK and the CLI is installed.

### 8.2 Upload pipeline
- Walks the theme directory, excluding `.git`, `node_modules`, `.vibespot`, dotfiles.
- PUTs each file via multipart to `/cms/v3/source-code/published/content/{path}`.
- Configurable concurrency (default 5 workers).
- Exponential backoff (1s/2s/4s) on 429 and 5xx.
- All errors collected and surfaced in the UI.

### 8.3 Auto-fix on upload failure
A second-line defense beyond the agentic pipeline's quality check. If upload returns errors, vibeSpot:
1. Parses the structured error response (category, detail, status, file path).
2. Identifies known fixable patterns: `textarea` field type (use `text`), `name` reserved field (use `item_name`), `now()` function (use `local_dt`), invalid color formats (must be hex), CDN `@import` (must inline), HubDB queries (require Pro).
3. Applies fixes to the affected files in place.
4. Retries the upload.

This is a separate layer from the pipeline's quality check because some errors are only surfaced by HubSpot itself (e.g., HubDB tier restrictions).

### 8.4 HubL preview renderer (`src/hubl/`)
A lightweight in-process HubL interpreter so the live preview doesn't need a HubSpot round-trip. Supports:
- Variable resolution with nested paths and filters (`upper`, `lower`, `capitalize`, `truncate`, `default`, `length`, `join`, …)
- Conditionals (`if`/`elif`/`else`/`endif`) with HubSpot truthiness rules
- Loops (`for`/`endfor`) with `loop.index`, `loop.first`, `loop.last`, `loop.length`
- Comparison and boolean operators
- `range()`, `split()`
- Asset URL resolution (`get_asset_url("…")` → local `/theme-assets/...` route)
- Strips HubSpot-only directives (`require_css`, `require_js`, `dnd_area`, `extends`, `block`, comments)

Aggressive but bounded: max 30 nested iterations, regex-based to keep complexity low. Sufficient for ~99% of generated module patterns.

---

## 9. Real-time Communication

### 9.1 WebSocket events (server → client)
| Event | Purpose |
|---|---|
| `init` | On connect: session, modules, messages, plan mode state |
| `stream` / `stream_status` | Streaming AI text and status messages |
| `agent_step` / `agent_decision` | Agentic pipeline stage transitions and details |
| `module_progress` | Per-module status (queued → generating → complete/failed) |
| `design_system_ready` | Push CSS to UI for themed placeholders |
| `blueprint_ready` | Module order set for placeholder positioning |
| `pipeline_complete` / `pipeline_partial` | Final stats |
| `modules_updated` | Module list changed; UI re-renders sidebar + preview |
| `plan_updated` | Plan markdown changed; Plan tab re-renders |
| `plan_choices` | Render answer chips below the most recent assistant message |
| `plan_complete` / `plan_discarded` | Plan-mode lifecycle |
| `version_created` | Git commit succeeded; refresh history |
| `generation_complete` | Final cleanup |
| `error` | Surface error to user |

### 9.2 Client → server messages
`chat`, `plan_approve`, `plan_discard`, `ping`, plus theme/upload-related messages.

### 9.3 Server-Sent Events (SSE)
Used for endpoints that don't need bidirectional streaming but need progress updates: Figma extraction (`/api/figma/extract`), Figma generate (`/api/figma/generate`).

---

## 10. Notable Engineering Decisions

1. **Pure ESM single-file bundle**. tsup bundles everything to `dist/index.js`. Simplifies distribution (one file + assets), works under `npx vibespot`, supports global install.

2. **Filesystem as primary persistence**. No database, no cloud. Session JSON in `~/.vibespot/`, themes in `~/vibespot-themes/`. Easy to inspect, back up, version manually.

3. **Graceful degradation everywhere**. Git missing → no history but everything else works. No AI engine → walkthrough modal explains setup. No HubSpot account → user can still generate and preview locally.

4. **Multi-engine adapter**. The `callAgent()` interface unifies API engines (with native structured output) and CLI subprocesses (with prompt-extracted JSON), so the agentic pipeline works identically across all seven engines.

5. **Hard write-gate in plan mode**. Defense in depth — even if the AI mistakenly emits a `vibespot-modules` block, the server refuses to write modules until the user explicitly approves. Mirrors Claude Code's plan-mode write refusal.

6. **Two-layer auto-fix**. Quality-check stage in the pipeline catches predictable issues (HubL syntax, reserved names). Upload auto-fix catches HubSpot-only issues (HubDB tier, color format). Together they handle the long tail.

7. **Per-template chat history**. Each template has its own chat. Switching templates switches conversational context — a hidden but powerful affordance for users iterating on multiple page variants.

8. **Prompt-cache aware**. Anthropic system prompts use cache blocks; the agentic pipeline structure (long stable system prompt, short user message per call) is designed to maximize hit rate.

9. **Concurrency limits everywhere**. Module generation: default 20 parallel. HubSpot upload: default 5 parallel. Configurable.

10. **No external SaaS**. vibeSpot is local-first. The user's API keys, code, designs, and HubSpot data never touch vibeSpot infrastructure. There is no vibeSpot infrastructure.

---

## 11. Current State (as of v1.0.10)

### Quantitative
- **84** TypeScript modules in `src/`
- **10** UI scripts in `ui/`
- **4** agentic pipeline stages
- **4** plan/prompt files (intent-analyzer, page-architect, module-developer, plan-mode)
- **7** supported AI engines
- **~4,200** lines of CSS in a single file
- **~300KB** built bundle (single file)

### What works well
- **End-to-end generation** from chat to deployed HubSpot theme (validated by an internal end-to-end test that creates a theme, generates modules with Claude Code, validates files, uploads to HubSpot, verifies, cleans up — runs in 3-5 min).
- **Multi-template support** — designers can build a landing page, a blog template, and a module library in one theme.
- **Figma import** — produces modules that match designs accurately (after the recent rework that replaced the agentic pipeline with a translation-only pipeline).
- **Plan mode** — newly added; lets users build up a plan via dialogue and elicitation before committing to generation.
- **Auto-fix retry** — most upload failures self-heal without user intervention.
- **Cross-engine consistency** — pipeline produces broadly equivalent output on Claude, GPT, Gemini.

### Known limitations / current gaps
- **Code editor is read-only in practice** — user can view files, but direct edits don't yet flow back into the session model.
- **Single active session** — switching themes unloads the previous; large workspaces with many themes feel slow on cold open.
- **No collaborative editing** — vibeSpot is single-user, local. No multi-user workspaces, no real-time collab.
- **No CMS-content authoring** — the system generates *templates*; actual page content (the rows in HubSpot CMS) is still authored in HubSpot's editor by content editors.
- **HubL renderer is a subset** — covers the patterns vibeSpot generates, but a hand-crafted module using rare HubL features may render differently in preview vs HubSpot.
- **No automated tests beyond the end-to-end** — no unit tests, no linting in CI. (Test coverage is a gap to close.)
- **CLI engines slower** — Claude Code / Gemini CLI / Codex CLI subprocess overhead makes generation 2-3x slower than direct API calls.
- **Brand-asset extractors are best-effort** — they sometimes fail silently if the rendered preview is malformed; users may need to hand-edit `.vibespot/styleguide.md`.
- **No template marketplace** — every theme starts from scratch (or a Figma file). No sharable starter templates yet.

---

## 12. Strategic Opportunities

These are areas the planning committee may want to consider for prioritization.

### Near-term (small wins)
- **Make the Code tab editable** — flow inline edits back through the session/disk write path. Low effort, high user value.
- **Test infrastructure** — add unit tests for the HubL renderer, ai-parser, plan-parser, session sync logic. The end-to-end test is great but slow.
- **Starter templates** — bundle 5-10 vetted plan/theme combos a user can fork as a starting point.
- **Plan-mode templates** — pre-canned plan structures (SaaS landing, e-commerce, event, blog) to accelerate the Understand phase.

### Medium-term (architectural)
- **Multi-active-session support** — enable working in two themes simultaneously (separate browser tabs, separate WS connections).
- **Asset library** — a global, theme-agnostic image/icon library so brand visuals carry across themes.
- **Content authoring assistance** — a layer that helps content editors write *for* the generated templates, not just structure.
- **HubSpot Marketplace publication path** — a workflow that prepares a generated theme for HubSpot Marketplace submission (the rules differ from regular themes).

### Larger bets
- **Shared / collaborative workspaces** — turn vibeSpot from a local CLI into a team tool. Requires infrastructure, auth, conflict resolution. Significant scope shift.
- **Inverse pipeline (HubSpot → vibeSpot)** — given an existing HubSpot theme, reverse-engineer it into a vibeSpot session for AI-assisted iteration. Already partially possible via `scanThemeFromDisk()` + `vibespot fetch`.
- **A/B variant generation** — generate two or three variants of a section ("hero with video", "hero with form", "hero with logos") and let the user split-test.
- **Plan mode as a library** — extract the plan-mode pattern as a generic AI deliberation primitive that other tools could embed.
- **Generative refactoring** — "make this page accessible / SEO-tuned / mobile-first" as one-click meta-actions on an existing theme.

### Risks worth flagging
- **AI engine dependency**. Output quality is bounded by model capability. New model releases shift baseline; vibeSpot needs to keep prompts current.
- **HubSpot API changes**. The Source Code API and field/meta schemas evolve; auto-fix patterns require ongoing maintenance.
- **Single-user model limits enterprise adoption**. Marketing teams want shared workspaces.
- **Local-first vs hosted tension**. Local-first is privacy-positive but limits collaboration, cross-device, and analytics. A hosted-optional model (opt-in sync) is a possible compromise.

---

## Appendix A: A typical user session, end-to-end

1. User installs: `npm i -g vibespot` (or runs `npx vibespot`).
2. First launch → walkthrough → connects HubSpot PAK → enters Anthropic API key.
3. Creates theme "acme-launch" → setup screen scaffolds an empty theme directory and opens the chat.
4. Toggles **Plan mode** → "We're launching a new SaaS product called Acme that helps marketing teams measure attribution. Help me build the landing page."
5. AI asks 3 elicitation questions (target audience, primary CTA, brand maturity). User answers via chips and free text.
6. AI proposes a 7-section plan in the right pane (Hero, Trust Bar, How It Works, Features, Social Proof, Pricing, Footer). User edits the plan inline to swap "Pricing" for "FAQ".
7. User clicks **Approve plan**. View switches to Preview tab.
8. Pipeline runs: Intent Analyzer → Page Architect → Module Developer (parallel) → Quality Check. Modules appear one-by-one in the preview as they generate.
9. Generation complete in ~90s. User clicks a module's gear icon and edits the headline copy in the field editor.
10. Drags FAQ above Pricing — wait, no Pricing — they're testing variants. Toggle back into Plan mode? No, just drag-reorder.
11. Clicks **Deploy**. Theme uploads to HubSpot in 30s. Celebration popup with link to `app-eu1.hubspot.com` Design Manager.
12. Marketing colleague opens the new theme in HubSpot, creates a page from it, fills in real content via HubSpot's drag-and-drop editor, publishes.

Total elapsed: ~10 minutes. Prior to vibeSpot, the same flow involved a developer ticket and a 2-week turnaround.

---

## Appendix B: Glossary

- **Module** — a HubSpot CMS module: a `<name>.module/` directory containing `module.html` (HubL), `module.css`, optional `module.js`, `fields.json` (editable field schema), `meta.json` (metadata).
- **Template** — a HubSpot page template (`.html` in `templates/`) that composes modules via `dnd_module` directives.
- **Theme** — a HubSpot CMS theme: a directory with `theme.json`, modules, templates, css, js, assets.
- **HubL** — HubSpot's templating language; a Jinja2 dialect with HubSpot-specific extensions.
- **Vibe coding** — informal term for AI-assisted, conversational programming. Adopted as the name of vibeSpot's primary mode.
- **PAK** — Personal Access Key: HubSpot's developer auth credential.
- **Agentic pipeline** — the four-stage decomposed AI generation flow.
- **Plan mode** — the deliberation phase that produces a markdown plan before any code is generated.
- **Brand assets** — extracted styleguide, brand voice, theme context — fed back into the AI to maintain consistency across generations.
