# Changelog

All notable changes to vibeSpot are documented here.

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
