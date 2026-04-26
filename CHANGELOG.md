# Changelog

All notable changes to vibeSpot are documented here.

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
