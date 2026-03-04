# vibeSpot

AI-powered HubSpot CMS landing page builder — vibe coding & React converter.

```
  ≋ vibeSpot — Build HubSpot Landing Pages with AI
```

> **Before you start:** vibeSpot's in-app setup will walk you through configuration, but for the smoothest experience, install your preferred AI engine and the HubSpot CLI **before** running vibeSpot. The onboarding flow is still being refined — having these tools ready avoids extra back-and-forth.
>
> **Requirements:** Node.js 18+, HubSpot CLI 8+ (`npm install -g @hubspot/cli@latest`). HubSpot CLI versions below 8 are **not supported** — deprecated commands like `hs create website-theme` were removed in v8.

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
- **Project sidebar** — create, open, resume, or delete projects
- **Module management** — reorder via drag-and-drop, edit fields, delete modules
- **Starter templates** — SaaS, Portfolio, Restaurant, Event
- **GitHub import** — convert existing React projects
- **Field editor** — tweak text, colors, images directly
- **Upload to HubSpot** — celebration popup with direct link to create pages
- **Version history** — automatic git commits after each AI generation

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

## After Building Your Page

Once your modules are ready:

1. Click **Upload to HubSpot** in the toolbar
2. The celebration popup shows a direct link to your HubSpot portal (EU and NA regions auto-detected)
3. In HubSpot: **Content** → **Landing Pages** → **Create**
4. Choose your uploaded theme
5. Drag your modules onto the page
6. Edit text, images, and colors in the page editor
7. Preview and publish!

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

Settings are saved in `~/.vibespot/config.json`:
- `aiEngine` — Your preferred AI engine (`anthropic-api`, `openai-api`, `gemini-api`, `claude-code`, `gemini-cli`, `codex-cli`)
- `anthropicApiKey` — Your Anthropic API key
- `openaiApiKey` — Your OpenAI API key
- `geminiApiKey` — Your Gemini API key
- `lastThemePath` — Last used theme directory
- `lastSourcePath` — Last used source directory

## Troubleshooting

**"command not found: node"** — Install Node.js from [nodejs.org](https://nodejs.org) and restart your terminal.

**"vibeSpot has not been built yet"** — Use `npx vibespot` instead, or run `npm run build` first.

**HubSpot upload keeps failing** — Run `vibespot doctor` to check your setup. Make sure `hs accounts list` shows your portal.

**Preview shows default template instead of modules** — Delete the boilerplate modules (button, card, menu, pricing-card, social-follow) using the × button on each module in the sidebar.

## License

Personal use only — see [LICENSE](LICENSE) for details. Commercial licensing available on request.
