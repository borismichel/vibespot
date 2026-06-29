<p align="center">
  <img src="assets/readme/00-hero-banner.svg" alt="vibeSpot — Build HubSpot landing pages with AI" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vibespot"><img src="https://img.shields.io/npm/v/vibespot?style=flat&color=e8613a&labelColor=1f2937" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-e8613a?style=flat&labelColor=1f2937" alt="License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A518-e8613a?style=flat&labelColor=1f2937" alt="Node 18+">
  <a href="https://vibespot.letsplaywith.tech"><img src="https://img.shields.io/badge/site-vibespot.letsplaywith.tech-e8613a?style=flat&labelColor=1f2937" alt="Website"></a>
</p>

<p align="center"><b>Build HubSpot landing pages with AI.</b></p>

<p align="center">
  Describe what you want in plain English — or paste a Figma URL. vibeSpot generates a native HubSpot theme: editable modules, real fields, your design tokens. Local-first. Your keys, your portal, your code.
</p>

<p align="center">
  <img src="assets/readme/01-vibe-coding-hero.png" alt="vibeSpot — chat on the left, live preview on the right" width="100%">
</p>

## Quickstart

```bash
npx vibespot
```

A browser opens. Pick an AI engine, drop in an API key, describe your page. That's the whole product.

Requires Node.js 18+. No HubSpot CLI install needed — vibeSpot talks to HubSpot directly via API.

## The tour

### 1. Talk to it. Ship a HubSpot page.

<img src="assets/readme/01-vibe-coding-hero.png" alt="Chat-driven page generation with live preview" width="100%">

Type what you want on the left. Watch real HubSpot modules render on the right — Split, Plan, and Code views, all live. A four-stage agentic pipeline (Intent → Architect → Module Developer → Quality Check) generates modules in parallel and auto-fixes common HubL issues before they reach you.

### 2. Check the work before the expensive build — Checkpoints

<p align="center">
  <img src="assets/readme/02-checkpoints.png" alt="Design checkpoint card: palette, type specimen, sample hero, and the estimated build cost — with approve, steer, skip, and cancel actions" width="360">
</p>

By default vibeSpot doesn't run the whole pipeline in one blind shot. It pauses at cheap seams and shows you a card before spending tokens on the parallel module build:

- **Brand intake** — when your theme has no style system yet, vibeSpot asks first: bring your brand (colors, code, an existing theme, a live site, your voice) or let it choose for you.
- **Design checkpoint** — palette swatches, a type specimen, and one sample hero, rendered straight from the design tokens. No extra model call.
- **Structure checkpoint** — the planned modules as an editable outline. Reorder, rename, cut, or add sections before a single module is built.

Each card shows the estimated cost of the build it gates. **Approve** to continue, **steer** with a note to redo just that stage, **skip** to build now, or **cancel** to write nothing. In a hurry? The one-tap **one-shot** button next to send skips every gate — the old one-call behaviour.

Type while a build is running and your message **queues** ("runs next") instead of cancelling it — or hit **Interrupt now** to stop the build and replan immediately.

**Plan mode** is the heaviest checkpoint variant. Toggle it on for a vague brief and vibeSpot asks the questions a senior designer would — audience, primary CTA, sections, voice — and builds a markdown plan in the right pane. Generation is hard-gated until you approve. Pre-canned templates skip the cold start for common page types.

### 3. Translate Figma 1:1

<img src="assets/readme/03-figma-import.png" alt="Figma import: paste a URL, extract design tokens and copy" width="100%">

Paste a Figma URL. vibeSpot extracts the exact design tokens (colors, type, spacing, shadows), the literal copy, and the section structure — then translates each section to HubL. The AI translates; it doesn't invent. What ships matches the Figma file.

### 4. Build whole sites in one prompt

<img src="assets/readme/04-multi-page-sites.png" alt="Multi-page site with shared header/footer and page tree" width="100%">

One prompt → multi-page HubSpot site. Shared header and footer, per-page layouts, cross-page navigation validation. The project sidebar shows the page tree with type badges and module counts. Drag to reorder, click to open.

### 5. Edit in the live preview

<img src="assets/readme/05-inline-wysiwyg.png" alt="Inline WYSIWYG editing with per-section hover toolbar" width="100%">

Click text, images, and links directly in the live preview to edit them inline. Hover any module for a floating toolbar: color picker, spacing slider, image swap, font size. Undo/redo through every generation step.

### 6. Upload straight to HubSpot

<img src="assets/readme/06-hubspot-upload.png" alt="Celebration popup after a successful HubSpot upload, with a direct link to the portal" width="100%">

Click Upload. Per-file progress, auto-fix for common errors, celebration popup with a direct link to your HubSpot portal (EU and NA regions auto-detected). From there it's Content → Landing Pages → Create → drop your modules onto the page.

## Choose your AI engine

vibeSpot runs the same pipeline across seven engines. Use whichever subscription you already pay for.

| Engine | Install | Notes |
|--------|---------|-------|
| Anthropic API | API key only | [console.anthropic.com](https://console.anthropic.com) |
| Claude OAuth | `claude setup-token` | Uses your Claude Pro/Max subscription |
| OpenAI API | API key only | Any OpenAI model |
| Gemini API | API key only | Google Gemini models |
| [Claude Code](https://claude.ai/code) | `npm i -g @anthropic-ai/claude-code` | Uses your Claude subscription |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm i -g @google/gemini-cli` | Uses your Google AI account |
| [OpenAI Codex](https://github.com/openai/codex) | `npm i -g @openai/codex` | Uses your OpenAI account |

## How the models compare

We ran the same two landing-page briefs through the pipeline on six models and kept every theme. The table shows accuracy (HubSpot/HubL validity + section coverage + an LLM judge), cost, and speed per page. The full themes, renders, and Langfuse trace ids live in [`test/eval/benchmark-results/`](test/eval/benchmark-results/).

| Model | Accuracy | Cost/page | Speed/page |
|-------|----------|-----------|------------|
| Sonnet 4.6 | 99% | $1.39 | ~6 min |
| Opus 4.7 | 98% | $7.76 | ~5 min |
| GPT 5.4 | 97% | $0.83 | ~4.5 min |
| Opus 4.8 | 97% | $6.50 | ~4 min |
| GPT 5.5 | 96% | $3.91 | ~9 min |
| Haiku 4.5 | 92% | $0.39 | ~2 min |

Every model produced valid, complete pages — 100% validator pass and section coverage across the board. Sonnet 4.6 leads on quality at roughly a fifth of Opus's cost; GPT 5.4 is the value pick; Opus 4.8 matches Opus 4.7's quality a bit cheaper and faster; Haiku 4.5 is fastest and cheapest if you plan to polish by hand. Two briefs scored by one judge — read it as a directional guide, and judge fidelity yourself from the saved themes. Reproduce it with `npm run benchmark` (see [`test/eval/BENCHMARK.md`](test/eval/BENCHMARK.md)).

## Setup

1. **Node 18+** — `node -v` to check, [nodejs.org](https://nodejs.org) to install.
2. **An AI engine key** — pick one from the table above.
3. **Run it** — `npx vibespot`. The browser opens.
4. **Connect HubSpot** — Settings → HubSpot → add a Personal Access Key. vibeSpot connects via the HubSpot API directly. No CLI install.

## Commands

Most users only need `npx vibespot`. The web UI handles everything else.

```bash
vibespot              # Vibe coding web UI (default)
vibespot wizard       # Classic CLI wizard for React → HubSpot
vibespot convert      # Convert a React project (no upload)
vibespot upload       # Upload a theme to HubSpot
vibespot inverse      # Reverse-engineer an imported HubSpot theme
vibespot doctor       # Diagnose environment issues
```

## What's new in v1.3

- **Release highlights on upgrade** — open the builder on a new version and a dialog shows what changed, with a link to the full changelog. Dismiss it and it stays gone until the next release.
- **Email template generation** — full pipeline for HubSpot emails: table layouts, MSO/VML compatibility, email validator auto-fix, 3 email starters.
- **Multi-page sites** — single prompt → full site with shared header/footer, page tree, navigation validation.
- **Inline WYSIWYG editing** — edit text, images, and links directly in the live preview with per-section visual controls.

Full history: [CHANGELOG.md](CHANGELOG.md).

## Links

- **Website** — [vibespot.letsplaywith.tech](https://vibespot.letsplaywith.tech)
- **LinkedIn** — [myvibespot](https://www.linkedin.com/company/myvibespot/)
- **npm** — [vibespot](https://www.npmjs.com/package/vibespot)
- **Contributing** — [CONTRIBUTING.md](CONTRIBUTING.md)
- **Code of Conduct** — [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

FSL-1.1-Apache-2.0 — see [LICENSE](LICENSE) for details.

