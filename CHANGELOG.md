# Changelog

All notable changes to vibeSpot are documented here.

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
