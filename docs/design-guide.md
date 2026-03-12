# vibeSpot — Brand & Design Guide

> For external agencies, designers, and copywriters working on vibeSpot properties.

---

## 1. Brand Overview

### What is vibeSpot?
vibeSpot is an AI-powered tool that lets you build HubSpot CMS landing pages by describing what you want in plain language. You chat with AI, see your page take shape in real time, drag modules around, tweak fields visually, and deploy to HubSpot in one click.

It replaces the slow, manual process of writing HubL templates and wiring up fields.json by hand. What used to take an afternoon takes a conversation.

### Who is it for?

| Audience | What they care about |
|----------|---------------------|
| **HubSpot power users** | Speed. They know the CMS but hate the repetitive module setup. |
| **Marketing agencies** | Volume. They build landing pages for clients constantly and need to move fast. |
| **Developers** | Control. They want real HubSpot modules (not HTML exports) with proper fields and HubL. |
| **Solo founders / marketers** | Access. They don't know HubL but want professional CMS pages without hiring a dev. |

### Brand Personality

vibeSpot is **a sharp tool, not a friendly assistant.** Think of it as the difference between a Swiss Army knife and a chatbot with a smiley face.

| Trait | What it means | What it doesn't mean |
|-------|--------------|---------------------|
| **Direct** | Get to the point. Lead with the action. | Not blunt or cold — we're concise, not terse. |
| **Technical but clear** | We respect that users know what they're doing. No hand-holding. | Not jargon-heavy. Explain when needed, but don't over-explain. |
| **Warm** | The UI has warmth — the coral accent, the dark cozy background, the celebration confetti. | Not cutesy. No exclamation marks everywhere. No "Yay!" |
| **Opinionated** | We make design decisions so users don't have to. One good way, not ten options. | Not rigid. The tool bends to what you describe. |
| **Honest** | If something failed, say so. If a module needs fixing, fix it silently or say what happened. | Not apologetic. "Fixed the reserved field name" not "Sorry about that!" |

### Brand Values
1. **Speed over ceremony** — Every click should do something. No wizards with 12 steps.
2. **Real output** — We generate native HubSpot modules, not approximations. What you see is what deploys.
3. **Quiet competence** — The best UX is when the tool just works. Auto-fix broken uploads. Handle edge cases. Don't make the user think.

---

## 2. Voice & Tone

### Writing Principles

**Lead with the verb.** Don't narrate what's happening — just do it.
- Yes: "Describe your page. See it build."
- No: "With vibeSpot, you can easily describe your page and watch as it builds in real time."

**Be specific over generic.** Concrete details beat marketing fluff.
- Yes: "Generates HubL templates, fields.json, and module.css — ready for `hs upload`."
- No: "Powerful AI creates beautiful landing pages effortlessly."

**Use the user's language.** If they say "module," we say "module." If they say "page," we say "page." No rebranding common terms.

**Stay lowercase where possible.** vibeSpot is always lowercase-v. Section headers in the UI use sentence case, not Title Case.

### Vocabulary

| Use | Don't use |
|-----|-----------|
| build, create, generate | leverage, utilize, harness |
| deploy, upload, push | publish (HubSpot-specific meaning) |
| module, template, theme | widget, block, component |
| chat, describe, tell | prompt, instruct (too AI-jargon) |
| fix, repair, handle | remediate, resolve, mitigate |
| fast, quick, instant | seamless, effortless, magical |
| works with | integrates with, synergizes with |

### Tone by Context

| Context | Tone | Example |
|---------|------|---------|
| **Marketing site** | Confident, concise, slightly playful | "Describe it. Preview it. Deploy it." |
| **App UI labels** | Neutral, functional | "Modules (5)" / "Upload to HubSpot" |
| **Error messages** | Calm, specific, actionable | "Upload failed: reserved field name 'label'. Auto-fixing..." |
| **Success states** | Understated celebration | "Deployed to HubSpot" + confetti (the confetti does the celebrating) |
| **Empty states** | Inviting, not sad | "No modules yet. Describe your page to get started." |
| **Tooltips** | One line, no period | "Edit module fields" / "Drag to reorder" |

### Capitalization
- **vibeSpot** — always lowercase v, capital S. Never "Vibespot", "VibeSpot", or "VIBESPOT".
- **HubSpot** — always capital H, capital S (their brand guideline).
- **HubL** — capital H, capital L (HubSpot's template language).
- UI labels: sentence case ("New project", not "New Project").

---

## 3. Logo & Identity

### The Mark
A **four-pointed star** with smooth curved edges (quadratic bezier), filled with the accent gradient. The star represents a spark — the moment an idea becomes a page.

### Logo Assets

| Asset | File | Dimensions | Use |
|-------|------|-----------|-----|
| Logo (vector) | `logo.svg` | Scalable (512 viewBox) | Marketing, print, co-branding |
| Logo (raster) | `logo.png` | 512 × 512 px | Social media, OG images, thumbnails |
| Favicon (vector) | `favicon.svg` | Scalable (512 viewBox) | Browser tab (modern browsers) |
| Favicon (legacy) | `favicon.ico` | Multi-size | Browser tab (legacy fallback) |

### Variants

**App icon** (rounded corners)
Used for app store contexts, social avatars, and the `logo.svg`/`logo.png` files.
```
Background: #0c0a09
Corner radius: rx="96" on 512×512 (~19%)
Star: accent gradient fill
```

**Favicon** (square)
Used for browser tabs. No rounded corners — the OS/browser handles masking.
```
Background: #0c0a09
Full-bleed rectangle
Star: accent gradient fill
```

**Inline brand mark** (in-app)
The topbar uses a small `28×28` rounded square with a "v" letterform:
```
Background: accent gradient
Corner radius: 8px
Letter: white, Space Grotesk 700, 16px
```

### Light Background Usage
When the logo must appear on a white or light background (co-branding, press kits, light-mode marketing pages):
- Use the full logo with dark background intact — the dark rect is part of the mark
- Minimum size: 32×32px (below this the star loses definition)
- Do not extract the star and place it on a light background without the dark container

### Clear Space
Maintain minimum clear space of **1× the star width** on all sides. On marketing layouts with generous whitespace, increase to 1.5×.

### Don'ts
| Rule | Reason |
|------|--------|
| Do not rotate or skew | The star points are intentionally axis-aligned |
| Do not use a flat color instead of the gradient | The gradient gives the star dimensionality |
| Do not add drop shadows or outer glow | The star already has visual presence against the dark bg |
| Do not stretch or distort | Maintain 1:1 aspect ratio always |
| Do not animate the star (spin, pulse, etc.) | The mark should feel stable and confident |
| Do not place on a busy photo background | The dark container ensures contrast |

---

## 4. Color System

### Primary Palette

#### Backgrounds
The dark theme uses layered transparency to create depth without introducing new colors.

| Name | Token | Value | Use |
|------|-------|-------|-----|
| Canvas | `--bg` | `#0c0a09` | Page background. Near-black with a warm brown undertone. |
| Panel | `--bg-panel` | `rgba(255,255,255, 0.03)` | Translucent panel surfaces |
| Panel Solid | `--bg-panel-solid` | `#131110` | Opaque panels (overlays, slideouts) |
| Input | `--bg-input` | `rgba(255,255,255, 0.04)` | Input fields, secondary buttons |
| Hover | `--bg-hover` | `rgba(255,255,255, 0.06)` | Hover states on interactive elements |
| Active | `--bg-active` | `rgba(255,255,255, 0.08)` | Pressed / active states |

**Design note:** The background is NOT pure black (`#000`). It's `#0c0a09` — a very dark warm brown. This is deliberate. Pure black feels harsh; the warm undertone makes extended use comfortable and pairs with the coral accent.

#### Accent — Warm Coral-Orange
The single accent color, used for all interactive and branded elements.

| Name | Token | Value | Use |
|------|-------|-------|-----|
| Accent | `--accent` | `#e8613a` | Primary: links, active states, icons |
| Accent Hover | `--accent-hover` | `#f2825f` | Lighter state on hover |
| Accent Dim | `--accent-dim` | `rgba(232,97,58, 0.15)` | Subtle backgrounds (active items, AI avatar) |
| Accent Glow | `--accent-glow` | `rgba(232,97,58, 0.3)` | Focus rings, border glow on hover |
| Accent Tint | `--accent-tint` | `rgba(232,97,58, 0.06)` | Very subtle wash |
| Accent Gradient | `--accent-gradient` | `linear-gradient(135deg, #e8613a, #f2825f)` | Primary buttons, user bubbles, logo star |

**Critical: This is NOT HubSpot orange.** HubSpot's brand color is `#ff5c35`. vibeSpot's accent is `#e8613a` — warmer, deeper, more muted. This distinction is intentional. Do not "correct" it to match HubSpot.

#### Text
| Name | Token | Value | Contrast on #0c0a09 | Use |
|------|-------|-------|---------------------|-----|
| Primary | `--text` | `#f0ece8` | ~17:1 (AAA) | Headings, body text, primary labels |
| Secondary | `--text-dim` | `rgba(255,255,255, 0.45)` | ~7:1 (AA) | Labels, secondary info, inactive items |
| Tertiary | `--text-muted` | `rgba(255,255,255, 0.2)` | ~3.5:1 | Timestamps, hints, placeholder text (decorative only) |

#### Borders
| Name | Token | Value | Use |
|------|-------|-------|-----|
| Default | `--border` | `rgba(255,255,255, 0.06)` | Dividers, card edges, input borders |
| Hover | `--border-hover` | `rgba(255,255,255, 0.12)` | Border on hover/focus |

#### Status
| Name | Token | Value | Use |
|------|-------|-------|-----|
| Success | `--success` | `#4ade80` | Completed actions, connected indicators |
| Warning | `--warning` | `#f59e0b` | Caution states, degraded services |
| Error | `--error` | `#ef4444` | Failures, destructive actions, danger buttons |

### Color Don'ts
| Rule | Reason |
|------|--------|
| Don't introduce new accent colors | One accent keeps the UI focused and scannable |
| Don't use pure white (`#fff`) for text | `#f0ece8` is warmer and easier on the eyes in dark mode |
| Don't use opaque background colors for panels | The layered transparency system creates natural depth |
| Don't use status colors for decoration | Green/amber/red are reserved for semantic meaning |
| Don't lighten the canvas background | `#0c0a09` was chosen for contrast ratios and warmth |

---

## 5. Typography

### Font Stack

| Role | Font | Weights Loaded | Use |
|------|------|---------------|-----|
| Display | **Space Grotesk** | 500, 600, 700 | Brand name, headings, hero text |
| Body | **DM Sans** | 300, 400, 500, 600 | UI text, labels, chat, body copy |
| Mono | **SF Mono** (fallback: Fira Code, Cascadia Code) | System | Code snippets, technical labels |

**Why this pairing:** Space Grotesk has geometric personality — it feels technical and modern without being cold. DM Sans is its quieter companion — highly legible at small sizes, neutral enough to disappear into the UI. Together they say "developer tool" not "enterprise dashboard."

```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
```

### Type Scale — App UI

#### Display (Space Grotesk)
| Element | Size | Weight | Tracking | Context |
|---------|------|--------|----------|---------|
| Hero symbol | 48px | — | — | The `✦` on the setup screen |
| Page title | 32px | 700 | -0.03em | "vibeSpot" heading |
| Section title | 16–17px | 600–700 | -0.02em | Topbar brand name, panel headings |

#### Interface (DM Sans)
| Element | Size | Weight | Line Height | Context |
|---------|------|--------|-------------|---------|
| Base body | 14px | 400 | default | Standard readable text |
| UI text | 13px | 400–500 | 1.5 | Buttons, labels, module names, list items |
| Chat content | 13.5px | 400 | 1.6 | Message bubbles (slightly larger for readability) |
| Meta | 12px | 400–600 | default | Timestamps, counts, secondary info |
| Tiny | 11px | 500–600 | default | Status pills, badge counts, footer text |
| Micro | 10px | 600 | default | Uppercase category labels only |

#### Code (SF Mono)
| Element | Size | Weight | Context |
|---------|------|--------|---------|
| Inline code | 12.5px | 400 | `code` inside chat bubbles |
| Code blocks | 11.5px | 400 | Fenced code in assistant responses |
| Tech labels | 11px | 600 | Uppercase engine/status indicators |

### Uppercase Labels
A recurring pattern for status badges, section labels, and category tags:
```css
text-transform: uppercase;
letter-spacing: 0.05em–0.08em;
font-size: 10–11px;
font-weight: 600;
```
Used sparingly. If everything is uppercase, nothing is.

### Type Scale — Marketing Site
Scale up from app sizes for the public-facing landing page.

| Element | Font | Size | Weight | Tracking |
|---------|------|------|--------|----------|
| Hero headline | Space Grotesk | 48–64px | 700 | -0.03em |
| Hero subline | DM Sans | 18–20px | 400 | 0 |
| Section heading | Space Grotesk | 28–36px | 600 | -0.02em |
| Section body | DM Sans | 16–18px | 400 | 0 |
| Feature card title | DM Sans | 16px | 600 | 0 |
| Feature card body | DM Sans | 14px | 400 | 0 |
| CTA button | DM Sans | 14–16px | 600 | 0 |
| Nav links | DM Sans | 14px | 500 | 0 |
| Footer | DM Sans | 13px | 400 | 0 |
| Code / terminal | SF Mono / Fira Code | 14px | 400 | 0 |

### Typography Don'ts
| Rule | Reason |
|------|--------|
| Don't use Space Grotesk for body text | It's a display face — legibility drops below 14px |
| Don't use weight 300 (light) for anything except decorative | Too thin on dark backgrounds |
| Don't go below 10px | Unreadable on most screens |
| Don't use more than 2 weights per element group | Keeps the visual hierarchy clean |
| Don't center-align body paragraphs | Left-align always. Center only for hero headlines and short taglines. |

---

## 6. Spacing & Layout

### App Layout Dimensions
| Token | Value | Context |
|-------|-------|---------|
| `--topbar-h` | `56px` | Top navigation bar |
| `--statusbar-h` | `28px` | Bottom status bar |
| `--rail-w` | `48px` | Collapsed project rail |
| Rail expanded | `220px` | Setup screen project list |

### Border Radius
| Token | Value | Use | Vibe |
|-------|-------|-----|------|
| `--radius` | `10px` | Buttons, cards, inputs | The default. Rounded but not bubbly. |
| `--radius-sm` | `6px` | Inner elements, small pills | Subtle rounding |
| `--radius-lg` | `16px` | Dialogs, panels, overlays | Soft, friendly containers |
| `--radius-pill` | `99px` | Tags, badges, scrollbar thumb | Fully rounded capsules |

### App Spacing
| Context | Padding | Gap |
|---------|---------|-----|
| Cards / list items | `10px 12px` | — |
| Panels | `12px` | — |
| Buttons (default) | `8px 16px` | — |
| Buttons (small) | `4px 12px` | — |
| Between list items | — | `4px` |
| Between sections | — | `12–16px` |
| Dialog padding | `24px` | — |
| Slideout header | `12px 16px` | `8px` between elements |

### Marketing Site Spacing
For the public-facing landing page — breathe more than the app UI:

| Context | Value |
|---------|-------|
| Section vertical padding | `64–80px` |
| Between section heading and content | `40–48px` |
| Feature grid gap | `24–32px` |
| Card internal padding | `24–32px` |
| Hero vertical padding | `120–160px` |
| Max content width | `1200px` |

---

## 7. Components

### Buttons

| Variant | Background | Text | Border | Hover | When to use |
|---------|-----------|------|--------|-------|-------------|
| **Primary** | `--accent-gradient` | `white` | none | `brightness(1.1)` | Main action per screen. One per view. |
| **Secondary** | `--bg-input` | `--text` | `1px solid --border` | `--bg-hover`, border `--accent-glow` | Supporting actions. Most common button. |
| **Ghost** | `transparent` | `--text-dim` | `1px solid --border` | text `--text`, border `--border-hover` | Tertiary. Cancel, dismiss, "maybe later." |
| **Danger** | `--error` | `white` | `1px solid --error` | `brightness(1.15)` | Destructive only. Delete, remove permanently. |

**Button don'ts:**
- Don't use Primary for more than one action in a view
- Don't use Danger for non-destructive actions
- Don't add icons to buttons unless the action is ambiguous without one
- Don't make buttons full-width unless in a narrow container (<300px)

### Chat Bubbles

**User message:**
```
[bubble gradient background] ← sharp top-right corner points toward avatar
                        [Y] ← 32px circle, accent gradient, white "Y"
```
- Background: `--accent-gradient`
- Text: `white`
- Border radius: `16px 4px 16px 16px` (sharp corner toward avatar)
- Max width: `85%`

**Assistant message:**
```
[AI] ← 32px circle, accent-dim bg, accent text "AI"
[bubble dark background] ← sharp top-left corner points toward avatar
```
- Background: `--bg-input`
- Text: `--text`
- Border: `1px solid --border`
- Border radius: `4px 16px 16px 16px` (sharp corner toward avatar)
- Max width: `95%`

**Key detail:** The sharp corner always points toward the avatar. This is a directional cue that makes the conversation flow feel natural.

### Avatars
| Variant | Size | Background | Text | Border |
|---------|------|-----------|------|--------|
| User | 32×32 | `--accent-gradient` | white | none |
| AI | 32×32 | `--accent-dim` | `--accent` | `1px solid --accent-glow` |

Avatar vertical alignment: `margin-top: 20px` to align with the bubble (not the header text).

### Toggle Switch
iOS-style sliding toggle. Used for feature flags (Humanify) and destructive confirmations.

| State | Track | Thumb |
|-------|-------|-------|
| Off | `--bg-input` bg, `--border` border | `--text-dim`, left position |
| On (standard) | `--accent` bg | white, right position (`translateX(16px)`) |
| On (destructive) | `--error` bg | white, right position |

Dimensions: 36×20px track, 14×14px thumb, 2px inset.

### Cards / List Items
- Padding: `10px 12px`, radius: `8px`
- Background: transparent → `--bg-hover` on hover
- Active: `--accent-dim` background, `--accent` text
- Controls (edit, delete): hidden by default, appear on hover, 32×32 hit targets

### Dialogs
- Overlay: `rgba(0,0,0,0.6)` fullscreen
- Dialog: `--bg-panel-solid`, `1px --border`, `16px` radius, `24px` padding
- Shadow: `0 16px 48px rgba(0,0,0,0.5)`, max width `400px`
- Actions: right-aligned, secondary (left) + primary/danger (right)

### Slideout Panels
- Background: `--bg-panel-solid`
- Entry: `translateX(-100%)` → `translateX(0)`
- Transition: `0.25s cubic-bezier(0.4, 0, 0.2, 1)`
- When closed: `pointer-events: none`

### Component Don'ts
| Rule | Reason |
|------|--------|
| Don't mix button variants in a single action group | Creates visual confusion about priority |
| Don't use colored borders on cards | Borders are always `--border` or `--accent-glow` on hover |
| Don't add shadows to cards inside panels | The dark bg and subtle borders provide enough separation |
| Don't animate colors on hover | Only animate opacity, transform, filter, and background |

---

## 8. Motion & Transitions

### Principles
1. **Fast and purposeful.** Nothing exceeds 0.3s. No bouncing, no spring physics, no overshoot.
2. **Entrance, not exit.** Elements animate in but disappear instantly (or with a simple reverse).
3. **Direction matches intent.** Slideouts come from where they conceptually live. Chat messages rise from below.

### Timing Reference
| Context | Duration | Easing |
|---------|----------|--------|
| Hover states | `0.15s` | `ease` |
| General UI transitions | `0.2s` | `ease` |
| Slideout panels | `0.25s` | `cubic-bezier(0.4, 0, 0.2, 1)` |
| Drag placeholder shift | `0.2s` | `cubic-bezier(0.2, 0, 0, 1)` |
| Chat message entrance | `0.2s` | `ease` |

### Keyframe Animations

```css
/* Chat message fade-in */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Streaming cursor blink */
@keyframes blink { 50% { opacity: 0; } }

/* Loading spinner */
@keyframes spin { to { transform: rotate(360deg); } }
/* 20×20px circle, 2px border, accent color, 0.8s duration */
```

### Marketing Site Motion
- Staggered fade-in for sections: `0.1s` delay increments
- Subtle Y-axis entrance: `y: 20` → `y: 0`
- Duration: `0.3–0.5s`, ease-out
- **No parallax.** vibeSpot's technical audience finds it distracting.

### Motion Don'ts
| Rule | Reason |
|------|--------|
| No bounce or spring easing | vibeSpot feels precise, not playful |
| No animation longer than 0.3s (app) / 0.5s (marketing) | Productivity tool = responsive |
| No animation on page load except spinners | Content should be instantly available |
| Don't animate layout properties (width, height) | Use transform for performance |

---

## 9. Iconography

### Approach
vibeSpot uses **Unicode glyphs** for most icons, keeping the codebase dependency-free.

| Glyph | Unicode | Meaning |
|-------|---------|---------|
| `✦` | U+2726 | Brand star (setup screen) |
| `⠿` | U+283F | Drag handle |
| `⚙` | U+2699 | Edit / settings |
| `×` | U+00D7 | Close / delete |
| `+` | U+002B | Add / create |
| `←` | U+2190 | Back / return |

**Inline SVGs** only when Unicode doesn't suffice: gear icon (settings button), grid icon (modules button), responsive device toggles.

### Sizing
| Context | Icon Size | Hit Target |
|---------|-----------|------------|
| Module controls (edit, delete) | 20–22px | 32×32px with hover bg |
| Navigation / toolbar | 14–16px | 28–36px clickable area |
| Drag handle | 14px | Full card row |
| Status dots | 8–10px | Decorative (not interactive) |

### Icon Don'ts
- Don't use icon libraries (Font Awesome, Material Icons) — they don't match the glyph aesthetic
- Don't use emoji as functional icons (confetti for celebration is fine)
- Don't add color to icons not in an active/accent state — default is `--text-dim`

---

## 10. Marketing Site Guidelines

For the public-facing vibeSpot landing page.

### Page Structure
```
[Nav]           Logo + links + CTA
[Hero]          Headline + subline + CTA + terminal/preview visual
[Features]      2–3 column grid of feature cards
[How It Works]  3-step flow (describe → preview → deploy)
[Demo]          Screenshot or video embed
[Tech]          "Built with" tech stack pills
[CTA]           Final call-to-action
[Footer]        Links + copyright
```

### Hero Section

**Navigation:**
- Fixed top bar, `--bg` with `backdrop-filter: blur(12px)`
- Logo (inline brand mark) + links + Primary CTA

**Feature Cards:**
- `--bg-panel-solid` with `1px --border`, `16px` radius
- Accent-colored icon, 24–32px
- Hover: border → `--accent-glow`, subtle `translateY(-2px)`

**Code/Terminal Blocks:**
```css
background: #131110;
border: 1px solid rgba(255,255,255,0.06);
border-radius: 12px;
padding: 20px 24px;
font-family: "SF Mono", "Fira Code", monospace;
font-size: 14px;
color: #f0ece8;
```
Command prefix (`$`) in `--text-muted`. Output in `--text-dim`. Highlighted parts in `--accent`.

**Footer:**
- Minimal: logo, links, copyright
- `--text-muted` 13px, links `--text-dim` → `--accent` on hover
- `border-top: 1px solid --border`

### Marketing Don'ts
| Rule | Reason |
|------|--------|
| Don't use a light/white background | vibeSpot is dark-mode native |
| Don't use stock photography | Real screenshots, terminal output, or abstract gradients |
| Don't add more than 2 CTAs above the fold | One primary, one secondary max |
| Don't use carousel/slider components | Static, scannable content |

---

## 11. Accessibility

### Standards
Target: **WCAG 2.1 AA** for all interactive elements.

### Contrast Ratios
| Pair | Ratio | Level |
|------|-------|-------|
| `--text` on `--bg` | ~17:1 | AAA |
| `--text-dim` on `--bg` | ~7:1 | AA |
| `--accent` on `--bg` | ~4.8:1 | AA (large text) |
| `white` on `--accent` (buttons) | ~4.5:1 | AA |
| `--text-muted` on `--bg` | ~3.5:1 | Decorative only |

### Focus States
```css
outline: 2px solid var(--accent-glow);
outline-offset: 2px;
```
Do not use `outline: none` without a visible replacement.

### Touch Targets
| Element | Minimum Size |
|---------|-------------|
| Buttons | 36×36px |
| Module controls | 32×32px |
| Rail items | 36×36px (collapsed), full row (expanded) |
| Toggle switches | 36×20px track |

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

### Screen Readers
- Interactive elements need `title` or `aria-label`
- SVG icon buttons need accompanying accessible text
- Status changes use `aria-live` regions

---

## 12. Scrollbar & Browser Chrome

```css
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(255,255,255, 0.08);
  border-radius: 99px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(255,255,255, 0.14);
}

::selection { background: rgba(232,97,58, 0.3); }

/* Required on dark backgrounds */
-webkit-font-smoothing: antialiased;
-moz-osx-font-smoothing: grayscale;
```

---

## Appendix A: Full Token Reference

```css
:root {
  --bg: #0c0a09;
  --bg-panel: rgba(255,255,255,0.03);
  --bg-panel-solid: #131110;
  --bg-input: rgba(255,255,255,0.04);
  --bg-hover: rgba(255,255,255,0.06);
  --bg-active: rgba(255,255,255,0.08);

  --border: rgba(255,255,255,0.06);
  --border-hover: rgba(255,255,255,0.12);

  --text: #f0ece8;
  --text-dim: rgba(255,255,255,0.45);
  --text-muted: rgba(255,255,255,0.2);

  --accent: #e8613a;
  --accent-hover: #f2825f;
  --accent-dim: rgba(232,97,58,0.15);
  --accent-glow: rgba(232,97,58,0.3);
  --accent-tint: rgba(232,97,58,0.06);
  --accent-gradient: linear-gradient(135deg, #e8613a, #f2825f);

  --success: #4ade80;
  --warning: #f59e0b;
  --error: #ef4444;

  --radius: 10px;
  --radius-sm: 6px;
  --radius-lg: 16px;
  --radius-pill: 99px;

  --font-display: "Space Grotesk", -apple-system, BlinkMacSystemFont, sans-serif;
  --font: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: "SF Mono", "Fira Code", "Cascadia Code", monospace;

  --topbar-h: 56px;
  --statusbar-h: 28px;
  --rail-w: 48px;
}
```

## Appendix B: File Locations

| What | Path |
|------|------|
| CSS tokens & styles | `ui/styles.css` |
| HTML structure | `ui/index.html` |
| Logo SVG (rounded) | `assets/logo.svg` |
| Logo PNG (512×512) | `assets/logo.png` |
| Favicon SVG (square) | `ui/favicon.svg` |
| Favicon ICO | `ui/favicon.ico` |

## Appendix C: Screenshots (TODO)

Capture and add annotated screenshots of:
1. Setup screen (expanded rail, project cards, settings)
2. Chat interface (user + AI bubbles, streaming state)
3. Module slideout (list view, drag state)
4. Field editor (slideout editor view)
5. Upload celebration (confetti + success dialog)
6. Dashboard (template grid, module previews)

Capture at 2× resolution, 1440px viewport, default dark theme.

---

**Website:** [vibespot.letsplaywith.tech](https://vibespot.letsplaywith.tech) · **LinkedIn:** [myvibespot](https://www.linkedin.com/company/myvibespot/)

*vibeSpot v0.9.0 — Last updated March 2026*
