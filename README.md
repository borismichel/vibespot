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
- **Live preview on the right** — see your page render in real-time, plus a **Plan tab** and a **Code tab**
- **Agentic pipeline** — multi-stage AI generation with real-time progress
- **Plan mode** *(new in v1.1)* — toggle on to deliberate before generating: the AI asks elicitation questions, builds a markdown plan in a dedicated pane, and only generates after you approve
- **Project sidebar** — create, open, resume, or delete projects
- **Module management** — reorder via drag-and-drop, edit fields, delete modules from module list or module library
- **Starter templates** — SaaS, Portfolio, Restaurant, Event
- **From Figma** *(Beta)* — paste a Figma URL to extract design tokens, text, and assets, then generate a full page that translates the design verbatim
- **From React** *(Beta)* — convert existing React/Lovable projects from a Git URL
- **Field editor** — tweak text, colors, images directly
- **File uploads** — attach images and documents via drag-and-drop or paperclip button
- **Upload to HubSpot** — per-file progress, auto-fix, celebration popup with direct portal link
- **Version history** — per-template git commits with rollback
- **Light/dark mode** — toggle or auto-detect system preference
- **Tabbed settings** — AI engines (with extended-thinking toggle), HubSpot accounts, Figma, GitHub, vibeSpot config
- **ZIP download** — export your theme as a ZIP file

### Agentic Pipeline

When you send a message, vibeSpot runs a 4-stage pipeline:

1. **Intent Analyzer** — classifies your request and plans which modules to create, modify, or keep unchanged. Uses conversation history to resolve back-references ("same section") and corrections ("I meant the hero").
2. **Page Architect** — designs the visual system (CSS variables, shared styles) then plans module specs. Reports font limitations when web fonts are requested.
3. **Module Developer** — generates all modules in parallel (up to 20 concurrent)
4. **Quality Check** — auto-fixes common issues (unbalanced HubL tags, reserved field names, deprecated types, CDN imports). Verifies all modules are in the page order.

Completed modules appear in the live preview immediately as each finishes, with themed skeleton placeholders for modules still generating.

### Plan Mode

Plan mode is a deliberation phase that runs *before* any code is generated. Toggle it from the prominent **Plan Mode** pill above the chat input. While active:

- The AI asks elicitation questions to surface gaps in your brief: who's the audience, what's the primary CTA, what sections should the page have, what's the brand voice.
- Each response builds up a markdown plan, persisted to `{theme}/.vibespot/plan.md` and rendered in a dedicated **Plan** tab in the right pane.
- The AI may emit clickable answer chips for common questions (e.g. "What's your primary goal? [Lead capture] [Sign-ups] [Demo bookings]") to keep the conversation fast.
- You can **edit the plan inline** (pencil icon → textarea → Save) — refinements without typing chat messages.
- Generation is **hard-gated**: the agentic pipeline is refused while plan mode is on. The only way to generate is the explicit **Approve plan** button, which prepends the plan to the user message as a design brief and runs the pipeline against the approved spec.
- **Discard & start over** clears the plan and exits plan mode.

Plan mode is ideal when:
- You're starting from a vague brief and want the AI to help you scope the page.
- Multiple stakeholders need to review the plan before code is generated.
- You're generating a high-stakes page and want to control content/structure decisions explicitly.

When plan mode is off, vibeSpot generates immediately — the existing fast path. Mode state persists across sessions.

### Figma Import (Beta)

Translate a Figma design into a HubSpot CMS theme without re-implementing it. The pipeline preserves the design's exact colors, typography, copy, and section order — the AI is only used to translate each section to HubL, not to make creative decisions.

**Setup:**
1. Open **Settings → Figma** and paste a Figma Personal Access Token (generate one in your Figma account settings).
2. Click **From Figma** on the setup screen and paste a Figma file URL or a specific frame URL.

**What the importer extracts:**
- **Design tokens** — colors (with usage counts), typography styles (family, size, weight per role), spacing scale, effects (shadows, border radii). These map mechanically to `:root` CSS variables — no AI guessing.
- **Section structure** — top-level frames become modules, in their original Figma order.
- **Per-section content** — exact headlines, body copy, and CTAs are extracted with role and font-size annotations, fed to the AI as field defaults.
- **Image assets** — downloaded from Figma's image API as PNGs (2× resolution).

**Two image modes (toggle on the import screen):**
- **Import images as assets** *(default)* — images land in `{theme}/assets/` and are referenced via `get_asset_url()`. The page looks identical to Figma out of the box.
- **Image fields with placeholders** — modules use HubSpot image fields with placehold.co defaults. Content editors swap in their own images via the HubSpot editor.

**The conversion pipeline (streamlined):**
1. **Generate shared CSS** — deterministic mapping of design tokens to CSS variables and utility classes. No AI.
2. **Map sections to module specs** — each section's exact text and layout becomes a module specification.
3. **AI translation** — for each module, the AI converts the Figma section into HubL. Parallel, concurrency-limited. The system prompt forbids inventing content; everything comes from Figma.
4. **Quality check** — the same auto-fix layer used by the agentic pipeline.

The result is a HubSpot theme where every color, word, and pixel of spacing matches the original design — fully editable in HubSpot's drag-and-drop editor.

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
| Claude OAuth | Run `claude setup-token` → paste token | Uses your Claude Pro/Max subscription |
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

Settings are managed in the **Settings** panel (tabbed: AI, HubSpot, Figma, GitHub, vibeSpot) and saved in `~/.vibespot/config.json`:

- `aiEngine` — Your preferred AI engine (`anthropic-api`, `claude-oauth`, `openai-api`, `gemini-api`, `claude-code`, `gemini-cli`, `codex-cli`)
- `anthropicApiKey`, `openaiApiKey`, `geminiApiKey` — API keys (stored locally, never sent except to the provider)
- `hubspotAccounts` — Connected HubSpot accounts (PAK-based auth)
- `hubspotUploadMode` — `api` (default, direct API) or `cli` (legacy, requires HubSpot CLI)
- `agenticConcurrency` — Max parallel module generation calls (default: 20)
- `figmaToken` — Figma Personal Access Token for design import
- `enabledCLITools` — Which CLI tools to detect on settings load

## What's New

### v1.1.0
- **Plan mode** — deliberation phase before generation. Prominent toggle above chat input; AI asks elicitation questions, builds a markdown plan in a dedicated tab, only generates after Approve. Plan persists to `.vibespot/plan.md` across sessions.
- **Streamlined Figma import** — replaces the old agentic-pipeline path with a translation pipeline that preserves Figma's exact design tokens, copy, and section order. Image assets copy into the theme automatically.
- **Anthropic SDK upgrade** (0.39 → 0.91) — unlocks extended thinking, improved prompt caching, and tool/schema-level cache control.
- **AI Capabilities settings panel** — toggle Extended Thinking (Anthropic API engines, with Low/Medium/High budget) and Web Search (Anthropic API + Claude Code CLI). Prompt Caching shows as auto-active; Citations is the remaining "coming soon" item. Claude Code engines see honest "Auto (CLI-managed)" badges where the CLI handles the feature internally.
- **Cache control on tool definitions** — Module Developer's identical tool schema is now cached, saving schema-encoding tokens on every parallel call after the first.
- **Claude Code stream-json output** — both single-call mode and the agentic CLI path now use `--output-format stream-json --include-partial-messages --verbose`. Tool calls (`Read`, `Edit`, `Bash`, `WebSearch`, `WebFetch`, `Grep`, `Glob`) flow into the pipeline status pane as concrete activity ("Searching: '…'", "Reading hero/module.html") instead of generic rotating placeholders.

### v1.0.x
- **Figma design import** (v1.0.10) — paste a Figma URL to extract design tokens, text, section structure, and image assets, then generate a full HubSpot page via the agentic pipeline
- **Template & module deletion** (v1.0.4) — delete templates from disk, option to delete exclusive modules, delete module button in module library preview
- **Brand assets redesign** (v1.0.2) — hover-expand cards with per-asset Upload/Extract, Extract All, brand voice extractor, cross-template product context sharing via rendered preview HTML
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
