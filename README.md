# vibeSpot

AI-powered HubSpot CMS landing page builder — vibe coding & React converter.

```
  ≋ vibeSpot — Build HubSpot Landing Pages with AI
```

**Website:** [vibespot.letsplaywith.tech](https://vibespot.letsplaywith.tech)
**LinkedIn:** [myvibespot](https://www.linkedin.com/company/myvibespot/)

> **Requirements:** Node.js 18+. That's it — vibeSpot connects to HubSpot directly via API. No HubSpot CLI needed.

## What It Does

vibeSpot lets you build HubSpot landing pages by chatting with AI. Describe what you want, and it generates native HubSpot CMS modules — fully editable in the HubSpot page editor. No coding knowledge required.

It also converts existing React landing pages (built with Lovable, v0, Bolt, or any React-based builder) into HubSpot-native modules.

### Vibe Coding Mode (Default)

```bash
npx vibespot
```

Opens a browser with:
- **Chat on the left** — describe your landing page in natural language
- **Live preview on the right** — see your page render in real-time
- **Agentic pipeline** — multi-stage AI generation with real-time progress
- **Project sidebar** — create, open, resume, or delete projects
- **Module management** — reorder via drag-and-drop, edit fields, delete modules
- **Starter templates** — SaaS, Portfolio, Restaurant, Event
- **GitHub import** — convert existing React projects
- **Field editor** — tweak text, colors, images directly
- **File uploads** — attach images and documents via drag-and-drop or paperclip button
- **Upload to HubSpot** — per-file progress, auto-fix, celebration popup with direct portal link
- **Version history** — per-template git commits with rollback
- **Light/dark mode** — toggle or auto-detect system preference
- **Tabbed settings** — AI engines, HubSpot accounts, GitHub, vibeSpot config
- **ZIP download** — export your theme as a ZIP file

### Agentic Pipeline

When you send a message, vibeSpot runs a 4-stage pipeline:

1. **Intent Analyzer** — classifies your request and plans which modules to create, modify, or keep unchanged
2. **Page Architect** — designs the visual system (CSS variables, shared styles) then plans module specs
3. **Module Developer** — generates all modules in parallel (up to 20 concurrent)
4. **Quality Check** — auto-fixes common issues (unbalanced HubL tags, reserved field names, deprecated types, CDN imports)

Completed modules appear in the live preview immediately as each finishes, with themed skeleton placeholders for modules still generating.

### Classic Wizard Mode

```bash
npx vibespot wizard
```

Step-by-step CLI wizard for converting an existing React project to HubSpot modules.

## Setup Guide

### 1. Check if Node.js is installed

```bash
node -v
```

If you see `v18.x.x` or higher, you're good. Otherwise install from [nodejs.org](https://nodejs.org).

### 2. Install an AI Engine

vibeSpot needs an AI engine to generate code. Use **one** of these:

| Engine | Install | Notes |
|--------|---------|-------|
| Anthropic API | No install — just need an API key | Get one at [console.anthropic.com](https://console.anthropic.com) |
| OpenAI API | No install — just need an API key | Any OpenAI model |
| Gemini API | No install — just need an API key | Google Gemini models |
| [Claude Code](https://claude.ai/code) | `npm install -g @anthropic-ai/claude-code` | Uses your Claude subscription |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Uses your Google AI account |
| [OpenAI Codex](https://github.com/openai/codex) | `npm install -g @openai/codex` | Uses your OpenAI account |

### 3. Run vibeSpot

```bash
npx vibespot
```

The browser opens automatically. Enter your API key in the setup screen, create or open a theme, and start chatting.

### 4. Connect HubSpot

Open **Settings → HubSpot** and add your account with a Personal Access Key (PAK). vibeSpot connects directly via the HubSpot API — no CLI installation needed. You can also switch to legacy CLI mode if you prefer.

## After Building Your Page

Once your modules are ready:

1. Click **Upload to HubSpot** in the toolbar
2. Watch per-file upload progress with auto-fix for common errors
3. The celebration popup shows a direct link to your HubSpot portal (EU and NA regions auto-detected)
4. In HubSpot: **Content** → **Landing Pages** → **Create**
5. Choose your uploaded theme
6. Drag your modules onto the page
7. Edit text, images, and colors in the page editor
8. Preview and publish!

## Commands

```bash
vibespot              # Vibe coding web UI (default)
vibespot wizard       # Classic CLI wizard
vibespot init         # Check and install required tools
vibespot convert      # Convert a React project (no upload)
vibespot upload       # Upload theme to HubSpot
vibespot doctor       # Diagnose environment issues
```

Most users only need `npx vibespot` — the web UI handles everything.

## Configuration

Settings are managed in the **Settings** panel (tabbed: AI, HubSpot, GitHub, vibeSpot) and saved in `~/.vibespot/config.json`:

- `aiEngine` — Your preferred AI engine (`anthropic-api`, `openai-api`, `gemini-api`, `claude-code`, `gemini-cli`, `codex-cli`)
- `anthropicApiKey`, `openaiApiKey`, `geminiApiKey` — API keys (stored locally, never sent except to the provider)
- `hubspotAccounts` — Connected HubSpot accounts (PAK-based auth)
- `hubspotUploadMode` — `api` (default, direct API) or `cli` (legacy, requires HubSpot CLI)
- `agenticConcurrency` — Max parallel module generation calls (default: 20)
- `enabledCLITools` — Which CLI tools to detect on settings load

## What's New (v1.0)

- **Agentic pipeline** (v1.0.0) — 4-stage AI generation: Intent Analyzer → Page Architect (Design System + Module Planner) → Module Developer (parallel) → Quality Check (auto-fix)
- **Incremental preview** (v1.0.0) — completed modules appear immediately with themed placeholders for pending ones
- **Quality Check agent** (v1.0.0) — auto-fixes unbalanced HubL tags, reserved fields, deprecated types, CDN imports
- **Security hardening** (v0.9.5) — shell injection prevention, CORS restriction, XSS prevention, security headers, API key file permissions
- **Code editor** (v0.9.3) — CodeMirror 6 with syntax highlighting, file browser, Preview/Code toggle, dark/light theme
- **Design extraction** (v0.9.3) — AI-powered styleguide generation from existing themes
- **HubSpot API mode** (v0.9.0) — upload, download, and manage themes without the HubSpot CLI
- **File uploads** (v0.8.0) — attach images and documents to chat (drag-and-drop or paperclip)
- **Per-template version history** (v0.7.0) — scoped git commits, filtered history, safe rollback
- **Light/dark mode** (v0.6.0) — system preference detection, persisted toggle

See [CHANGELOG.md](CHANGELOG.md) for the full history.

## Troubleshooting

**"command not found: node"** — Install Node.js from [nodejs.org](https://nodejs.org) and restart your terminal.

**"vibeSpot has not been built yet"** — Use `npx vibespot` instead, or run `npm run build` first.

**HubSpot upload failing** — Open Settings → HubSpot and verify your account is connected. Run `vibespot doctor` for diagnostics.

**Preview shows default template instead of modules** — Delete the boilerplate modules (button, card, menu, pricing-card, social-follow) using the × button on each module in the sidebar.

## Links

- **Website:** [vibespot.letsplaywith.tech](https://vibespot.letsplaywith.tech)
- **LinkedIn:** [myvibespot](https://www.linkedin.com/company/myvibespot/)
- **npm:** [vibespot](https://www.npmjs.com/package/vibespot)

## License

Personal use only — see [LICENSE](LICENSE) for details. Commercial licensing available on request.
