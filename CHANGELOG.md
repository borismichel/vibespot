# Changelog

All notable changes to vibeSpot are documented here.

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
