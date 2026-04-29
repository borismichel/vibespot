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

There is no unit test suite or linting configured.

## Architecture

### Entry Flow
`bin/vibespot.mjs` → `dist/index.js` → `src/index.ts` → `src/cli/program.ts` (Commander)

The default command (no subcommand) runs the vibe coding web UI. Subcommands: `wizard`, `init`, `convert`, `upload`, `marketplace check|edit`, `doctor`.

### Key Directories
- `src/commands/` — One file per CLI command, each exports a single action function
- `src/server/` — HTTP server, WebSocket, AI handler, session management, preview builder, version history (git)
- `src/server/agent/` — Agentic pipeline (see below)
- `src/server/session/` — Session management split into submodules (state, store, disk, templates, types)
- `src/wizard/` — Step implementations for the wizard flow: preflight → source → theme-setup → conversion → uploader → next-steps
- `src/ai/` — Multi-engine AI system for single-call mode (legacy)
- `src/hubl/` — Lightweight HubL template renderer for local preview (supports variables, conditionals, loops, filters, scope_css, require_css/js)
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

**Engine Adapter** (`engine-adapter.ts`) — Unified interface for all AI engines:
- API engines (Anthropic, OpenAI, Gemini): structured output via JSON schema, streaming
- CLI engines (Claude Code, Gemini CLI, Codex CLI): subprocess spawning with prompt piping

**Prompts** (`prompts/`) — System prompts and JSON schemas for each stage.

**Types** (`types.ts`) — `PipelinePlan`, `PageBlueprint`, `ModuleSpec`, `PipelineEvent`, `PipelineResult`, concurrency limiter.

**Pipeline Events** (emitted via WebSocket):
- `agent_step` — Stage transitions (analyzing, designing, developing, quality_check)
- `agent_decision` — Stage details shown in UI
- `module_progress` — Per-module status (queued, generating, complete, failed)
- `design_system_ready` — CSS pushed to session for themed placeholders
- `blueprint_ready` — Module order set for placeholder positioning
- `pipeline_complete` / `pipeline_partial` — Final stats

### AI Engine Design

All engines implement the `AIEngine` interface in `src/ai/engine.ts` (used by single-call mode and wizard).

The agentic pipeline uses `AgentEngine` type and `callAgent()` from `src/server/agent/engine-adapter.ts` which supports both API engines (with structured output) and CLI engines (with subprocess spawning).

**Anthropic API mode** (`src/ai/claude-api.ts`): Uses `@anthropic-ai/sdk` with sequential API calls. Model: `claude-sonnet-4-20250514`.

**OpenAI API mode**: Uses native fetch with OpenAI-compatible streaming API. Supports any OpenAI model.

**Gemini API mode**: Uses native fetch with Google Gemini streaming API.

**Claude Code mode** (`src/ai/claude-code.ts`): Spawns `claude --print` as a subprocess.

**Gemini CLI mode**: Spawns `gemini` CLI as a subprocess.

**Codex CLI mode**: Spawns `codex` CLI as a subprocess.

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
