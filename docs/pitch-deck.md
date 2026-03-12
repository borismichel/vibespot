# vibeSpot — Pitch Deck

> Short-form pitch material for presentations, investor conversations, partner calls, and marketing copy.

---

## The One-Liner

**vibeSpot turns conversations into HubSpot landing pages.**

Describe what you want in plain language. Watch it build in real time. Deploy to HubSpot in one click.

---

## The Problem

Building landing pages in HubSpot CMS is slow, manual, and frustrating.

### For developers:
- Writing HubL templates from scratch is tedious and repetitive
- Every module needs `module.html`, `fields.json`, `module.css`, and `meta.json` — all wired up correctly
- Reserved field names, deprecated types, and CDN import rules cause upload failures that waste hours
- No local preview — you upload, check, fix, re-upload

### For marketers and agencies:
- Hiring a developer for every landing page creates bottlenecks
- HubSpot's drag-and-drop editor is limited — custom designs require custom modules
- Agencies building pages for multiple clients need volume, but each page requires the same manual setup
- Existing AI tools generate generic HTML — not native HubSpot CMS modules

### The core tension:
HubSpot CMS is powerful, but building for it is disproportionately slow. A page that takes 30 seconds to describe takes hours to build.

---

## The Solution

vibeSpot is an AI-powered tool that generates **native HubSpot CMS modules** from natural language descriptions.

### How it works:
```
1. Describe    → Chat with AI: "Build a SaaS landing page with a hero,
                  features grid, pricing table, and CTA section"

2. Preview     → Watch your page appear in a live preview as the AI
                  generates real HubL templates and module fields

3. Tweak       → Edit fields visually, drag modules to reorder,
                  adjust colors and text in a slideout editor

4. Deploy      → One click uploads the entire theme to HubSpot.
                  Auto-fixes common issues. Confetti included.
```

### What makes it different:
It doesn't generate HTML mockups. It generates **real HubSpot CMS modules** — `module.html` with HubL syntax, `fields.json` with editable fields, `module.css` with scoped styles. The output is immediately usable in HubSpot's page editor, just like modules built by hand.

---

## Key Features

### 1. Vibe Coding Interface
Chat-based UI with live preview. Describe what you want on the left, see it build on the right. No code editor, no config files — just conversation.

### 2. Multi-Engine AI
Choose your AI engine: Claude, GPT, Gemini, or Codex. Switch between API and CLI modes. Use whichever model you're most comfortable with.

### 3. Native HubSpot Output
Every module includes `module.html` (HubL template), `fields.json` (editable fields), `module.css` (scoped styles), and `meta.json`. Ready for vibeSpot's one-click deploy via API or `hs upload`.

### 4. Live HubL Preview
A built-in HubL renderer shows your page locally — with variables, conditionals, loops, and filters. No need to upload to HubSpot just to see what it looks like.

### 5. Visual Module Editor
Click a module to edit its fields: text, colors, images, links, booleans, choices. Changes reflect instantly in the preview. No JSON editing required.

### 6. Drag-and-Drop Reordering
Click a module to jump to it in the preview. Hold and drag to reorder. Smooth animation with cursor-follow and placeholder positioning.

### 7. Auto-Fix on Upload
The uploader detects and fixes common HubSpot failures automatically:
- Reserved field names (`name` → `item_name`, `label` → `section_label`)
- Deprecated types (`textarea` → `text`)
- Invalid HubL functions (`now()` → `local_dt`)
- CDN font imports (stripped — HubSpot doesn't allow external `@import`)
- Stuck partial uploads (cleans up and retries)

### 8. Brand Assets & Humanify
Upload a brand guide and style document. The AI uses them for consistent output. Toggle "Humanify" to make AI-generated copy sound more natural and less robotic.

### 9. Multi-Template Projects
Manage multiple templates (landing pages, blog posts, website pages) within a single theme project. Each template has its own module set and layout.

### 10. React/Lovable Converter
Already have a React page? The CLI wizard analyzes the source, creates a HubSpot theme, and converts components into native CMS modules. Works with Lovable exports and standard React projects.

---

## Who It's For

| Audience | Pain Point | vibeSpot Value |
|----------|-----------|---------------|
| **HubSpot developers** | Repetitive module boilerplate | Generate modules from descriptions, skip the scaffolding |
| **Marketing agencies** | Client landing pages bottleneck dev teams | Marketers can build pages directly, devs review and deploy |
| **Solo marketers** | Can't afford custom development for every page | Professional CMS pages without writing code |
| **Growth teams** | A/B test pages take too long to produce | Spin up landing page variants in minutes |

---

## How It Compares

| | vibeSpot | HubSpot Drag & Drop | Generic AI Builders | Manual HubL Dev |
|--|---------|--------------------|--------------------|----------------|
| Custom designs | Yes | Limited to existing modules | Yes | Yes |
| Native HubSpot output | Yes | Yes | No (HTML export) | Yes |
| AI-assisted | Yes | No | Yes | No |
| Local preview | Yes | No (must publish) | Varies | No |
| Time to page | Minutes | Minutes (limited) | Minutes | Hours |
| Editable in HubSpot | Yes | Yes | No | Yes |
| Auto-fix upload issues | Yes | N/A | N/A | Manual |

---

## Technical Facts

- **Install:** `npx vibespot` (zero-config, runs instantly)
- **Website:** [vibespot.letsplaywith.tech](https://vibespot.letsplaywith.tech)
- **LinkedIn:** [myvibespot](https://www.linkedin.com/company/myvibespot/)
- **Runtime:** Node.js (local CLI tool, no cloud dependency)
- **HubSpot integration:** Direct API (default) or CLI (optional legacy mode)
- **AI engines:** Claude (API + CLI), OpenAI, Gemini (API + CLI), Codex CLI
- **Output:** Standard HubSpot CMS theme structure, uploads via API or `hs upload`
- **HubL support:** Variables, conditionals, loops, filters, `scope_css`, `require_css/js`
- **Stack:** TypeScript, Node.js, WebSocket, native HTTP server
- **License:** Personal use (commercial licensing available)
- **Size:** ~137KB bundled

---

## The Numbers (Placeholder — Update With Real Data)

| Metric | Value |
|--------|-------|
| Time to first page | ~5 minutes |
| Modules per generation | 3–8 (full page) |
| Upload success rate (with auto-fix) | ~95% |
| AI engines supported | 6 (3 API + 3 CLI) |
| npm weekly downloads | *TBD* |

---

## Traction & Roadmap

### Current (v0.9)
- Full vibe coding web UI with chat + live preview
- Multi-engine AI support (Claude, GPT, Gemini, Codex)
- Module slideout with drag-and-drop, visual field editor
- Direct HubSpot API integration (no CLI dependency)
- Per-file upload progress with auto-fix
- File uploads: images (asset wiring) and documents (AI context)
- Per-template version history with scoped rollback
- Light/dark mode with system preference detection
- Tabbed settings with descriptions
- Multi-account HubSpot support
- ZIP theme download
- Brand assets and Humanify toggle
- Multi-template project management
- React/Lovable conversion wizard (experimental)

### Next
- Collaborative editing (multiple users on one project)
- Template marketplace (share and import module presets)
- HubSpot design manager integration
- AI-powered A/B variant generation

---

## Key Quotes / Taglines

**Hero:**
> "Describe it. Preview it. Deploy it."

**Subline:**
> "Build HubSpot landing pages by chatting with AI. Real modules, real HubL, real fast."

**Value prop:**
> "What used to take an afternoon takes a conversation."

**Technical credibility:**
> "Generates native HubSpot CMS modules — not HTML exports. What you see is what deploys."

**For agencies:**
> "Stop bottlenecking your dev team on landing pages."

**For solo marketers:**
> "Professional HubSpot pages without writing a line of code."

---

## Tech Stack

`TypeScript` · `Node.js` · `Claude API` · `OpenAI API` · `Gemini API` · `HubL` · `HubSpot CMS API` · `WebSocket`

---

**Website:** [vibespot.letsplaywith.tech](https://vibespot.letsplaywith.tech) · **LinkedIn:** [myvibespot](https://www.linkedin.com/company/myvibespot/)

*vibeSpot v0.9.0 — March 2026*
