/**
 * Prompt builders for Stage 2: Design System + Module Planner.
 *
 * Stage 2 is split into two sequential calls:
 * 2a: Design System — creates :root variables, shared CSS, shared JS
 * 2b: Module Planner — receives the CSS, plans modules with content briefs
 *
 * This split ensures the design system is complete and correct before
 * module developers reference it.
 */

import type { SystemPromptBlock } from "../engine-adapter.js";
import type { BrandKit } from "../../session/types.js";
import { getDesignGuide } from "../../../ai/prompts.js";

// ---------------------------------------------------------------------------
// Stage 2a: Design System
// ---------------------------------------------------------------------------

import { renderStagePrompt } from "./registry.js";

export function buildDesignSystemPrompt(
  themeName: string,
  brandAssets?: { styleguide?: string; brandvoice?: string; themeContext?: string; brandKit?: BrandKit },
): string {
  const parts: string[] = [];

  parts.push(renderStagePrompt("design-system", { themeName }));

  parts.push(`\n\n## Design Guide\n${getArchitectDesignSummary()}`);

  if (brandAssets?.styleguide) {
    parts.push(`\n\n## Brand Style Guide\n${brandAssets.styleguide}`);
  }
  if (brandAssets?.themeContext) {
    parts.push(`\n\n## Product Context\n${brandAssets.themeContext}`);
  }

  const hasBrandKit = brandAssets?.brandKit && (
    brandAssets.brandKit.colors?.primary ||
    brandAssets.brandKit.colors?.secondary ||
    brandAssets.brandKit.colors?.accent ||
    brandAssets.brandKit.fonts?.heading ||
    brandAssets.brandKit.fonts?.body
  );

  if (hasBrandKit) {
    const kitLines: string[] = [];
    const bk = brandAssets!.brandKit!;
    if (bk.colors?.primary) kitLines.push(`- Primary color: ${bk.colors.primary}`);
    if (bk.colors?.secondary) kitLines.push(`- Secondary color: ${bk.colors.secondary}`);
    if (bk.colors?.accent) kitLines.push(`- Accent color: ${bk.colors.accent}`);
    if (bk.fonts?.heading) kitLines.push(`- Heading font: ${bk.fonts.heading}`);
    if (bk.fonts?.body) kitLines.push(`- Body font: ${bk.fonts.body}`);
    if (bk.logoUrl) kitLines.push(`- Logo URL: ${bk.logoUrl}`);
    if (kitLines.length > 0) {
      parts.push(`\n\n## Brand Kit — MANDATORY Design Constraints\nThe following brand identity values MUST be used. Do NOT substitute or override them:\n${kitLines.join("\n")}`);
    }
  }

  if (!hasBrandKit && !brandAssets?.styleguide) {
    parts.push(`\n\n## No Brand Provided — Follow the Generation Recipe
No brand colors, fonts, or styleguide have been set. You MUST follow these rules to create a unique design:

${getNoBrandDesignRecipe()}`);
  }

  return parts.join("");
}

/**
 * Build design system prompt as blocks with cache control.
 * The design guide summary is static and cached.
 */
export function buildDesignSystemPromptBlocks(
  themeName: string,
  brandAssets?: { styleguide?: string; brandvoice?: string; themeContext?: string; brandKit?: BrandKit },
): SystemPromptBlock[] {
  // Build core prompt without the design guide (pass empty brandAssets to skip dynamic parts)
  const full = buildDesignSystemPrompt(themeName);
  // Split at the design guide marker
  const marker = "\n\n## Design Guide\n";
  const markerIdx = full.indexOf(marker);

  if (markerIdx === -1) {
    // Fallback: no split possible, return as single block
    return [{ type: "text", text: full }];
  }

  const corePart = full.slice(0, markerIdx);
  const designGuide = `## Design Guide\n${getArchitectDesignSummary()}`;

  const blocks: SystemPromptBlock[] = [
    { type: "text", text: corePart },
    { type: "text", text: designGuide, cache_control: { type: "ephemeral" } },
  ];

  // Dynamic brand assets
  const dynamicParts: string[] = [];
  if (brandAssets?.styleguide) dynamicParts.push(`## Brand Style Guide\n${brandAssets.styleguide}`);
  if (brandAssets?.themeContext) dynamicParts.push(`## Product Context\n${brandAssets.themeContext}`);

  const hasBrandKit = brandAssets?.brandKit && (
    brandAssets.brandKit.colors?.primary ||
    brandAssets.brandKit.colors?.secondary ||
    brandAssets.brandKit.colors?.accent ||
    brandAssets.brandKit.fonts?.heading ||
    brandAssets.brandKit.fonts?.body
  );

  if (hasBrandKit) {
    const kitLines: string[] = [];
    const bk = brandAssets!.brandKit!;
    if (bk.colors?.primary) kitLines.push(`- Primary color: ${bk.colors.primary}`);
    if (bk.colors?.secondary) kitLines.push(`- Secondary color: ${bk.colors.secondary}`);
    if (bk.colors?.accent) kitLines.push(`- Accent color: ${bk.colors.accent}`);
    if (bk.fonts?.heading) kitLines.push(`- Heading font: ${bk.fonts.heading}`);
    if (bk.fonts?.body) kitLines.push(`- Body font: ${bk.fonts.body}`);
    if (bk.logoUrl) kitLines.push(`- Logo URL: ${bk.logoUrl}`);
    if (kitLines.length > 0) {
      dynamicParts.push(`## Brand Kit — MANDATORY Design Constraints\nThe following brand identity values MUST be used. Do NOT substitute or override them:\n${kitLines.join("\n")}`);
    }
  }

  if (!hasBrandKit && !brandAssets?.styleguide) {
    dynamicParts.push(`## No Brand Provided — Follow the Generation Recipe
No brand colors, fonts, or styleguide have been set. You MUST follow these rules to create a unique design:

${getNoBrandDesignRecipe()}`);
  }

  if (dynamicParts.length > 0) {
    blocks.push({ type: "text", text: dynamicParts.join("\n\n") });
  }

  return blocks;
}

/** JSON Schema for Design System output. */
export const DESIGN_SYSTEM_SCHEMA = {
  type: "object",
  properties: {
    cssVariables: {
      type: "object",
      description: "CSS custom property name → value map. Every var() used in sharedCss must be defined here.",
    },
    sharedCss: {
      type: "string",
      description: "Complete shared CSS file. MUST start with :root {} block defining all cssVariables, followed by reset, typography, layout, components, animations, and responsive styles.",
    },
    sharedJs: {
      type: "string",
      description: "Optional shared JS for scroll animations (IntersectionObserver). Wrap in IIFE. Empty string if not needed.",
    },
    aesthetic: {
      type: "string",
      description: "Brief description of the chosen aesthetic direction (e.g., 'dark luxury with warm gold accents')",
    },
  },
  required: ["cssVariables", "sharedCss", "aesthetic"],
} as const;

// ---------------------------------------------------------------------------
// Stage 2b: Module Planner
// ---------------------------------------------------------------------------

/**
 * Extract CSS class names and custom property names from a CSS string.
 * The module planner only needs to know WHAT classes/vars exist, not their
 * full implementation — this cuts the prompt by 80%+ for large design systems.
 */
function summarizeCss(css: string): string {
  // Extract class names (deduplicated, preserving order)
  const classNames = [...new Set(
    [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => `.${m[1]}`)
  )];

  // Extract custom properties from :root
  const varNames = [...new Set(
    [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])
  )];

  // Extract @media breakpoints
  const breakpoints = [...new Set(
    [...css.matchAll(/@media\s*\([^)]+\)/g)].map((m) => m[0])
  )];

  const lines: string[] = [];
  if (varNames.length > 0) lines.push(`CSS Variables: ${varNames.join(", ")}`);
  if (classNames.length > 0) lines.push(`CSS Classes: ${classNames.join(", ")}`);
  if (breakpoints.length > 0) lines.push(`Breakpoints: ${breakpoints.join(", ")}`);
  return lines.join("\n");
}

export function buildModulePlannerPrompt(
  themeName: string,
  sharedCss: string,
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string; brandKit?: BrandKit },
  guidesNeeded?: string[],
): string {
  const parts: string[] = [];
  const cssSummary = summarizeCss(sharedCss);

  parts.push(renderStagePrompt("module-planner", { themeName, cssSummary }));

  if (!guidesNeeded || guidesNeeded.includes("content")) {
    parts.push(`\n\n## Content & Copywriting Guide\n${getArchitectContentSummary()}`);
  }

  if (brandAssets?.brandvoice) {
    parts.push(`\n\n## Brand Voice\n${brandAssets.brandvoice}`);
  }
  if (brandAssets?.themeContext) {
    parts.push(`\n\n## Product Context\n${brandAssets.themeContext}`);
  }
  if (brandAssets?.humanify !== false && guidesNeeded?.includes("humanify")) {
    parts.push(`\n\n## Anti-AI Copy Rules\n${getArchitectHumanifySummary()}`);
  }

  return parts.join("");
}

/** JSON Schema for Module Planner output. */
export const MODULE_PLANNER_SCHEMA = {
  type: "object",
  properties: {
    modules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Module identifier. If this module already exists in the project, use the existing name verbatim. For new modules, use kebab-case (e.g., 'hero', 'pricing-cards')." },
          description: { type: "string", description: "What this module does" },
          contentBrief: { type: "string", description: "Specific content: headlines, body copy, stats, CTAs" },
          layoutNotes: { type: "string", description: "Visual layout approach referencing shared CSS classes" },
        },
        required: ["name", "description", "contentBrief", "layoutNotes"],
      },
    },
    moduleOrder: {
      type: "array",
      items: { type: "string" },
      description: "Module names in page display order",
    },
    narrative: {
      type: "string",
      description: "Brief description of the page story/flow",
    },
  },
  required: ["modules", "moduleOrder", "narrative"],
} as const;

// ---------------------------------------------------------------------------
// Legacy export — kept for backward compatibility with pipeline imports
// ---------------------------------------------------------------------------

/** @deprecated Use DESIGN_SYSTEM_SCHEMA + MODULE_PLANNER_SCHEMA instead */
export const PAGE_ARCHITECT_SCHEMA = DESIGN_SYSTEM_SCHEMA;

/** @deprecated Use buildDesignSystemPrompt + buildModulePlannerPrompt instead */
export function buildPageArchitectPrompt(
  themeName: string,
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string },
  guidesNeeded?: string[],
): string {
  return buildDesignSystemPrompt(themeName, brandAssets);
}

// ---------------------------------------------------------------------------
// No-brand design recipe — loaded when no brand kit or styleguide is set
// ---------------------------------------------------------------------------

function getNoBrandDesignRecipe(): string {
  const designGuide = getDesignGuide();

  // Extract the Color System section (§4) and Font Pairing table from the design guide asset
  const colorSection = extractSection(designGuide, "## 4. Color System", "## 5.");
  const fontSection = extractSection(designGuide, "### Recommended Font Pairings", "### Typography Scale");

  const parts: string[] = [];

  parts.push(`### Step 1: Derive the aesthetic from the content
Read the user's request carefully. What industry? What audience? What mood?
Map it to ONE of these aesthetic directions — then commit fully:

| Business Type | Aesthetic | Color Direction | Font Mood |
|--------------|-----------|----------------|-----------|
| SaaS / Tech startup | Cool minimal or Bold tech | Blues, teals, electric purples, neon greens — COOL tones | Geometric sans or monospace |
| Restaurant / Food | Warm editorial | Deep greens, burgundy, cream, terracotta — WARM but rich | Serif display + clean body |
| Agency / Consultancy | Bold confident | Black + a single bold accent (red, orange, electric blue) | Strong geometric display |
| E-commerce / DTC | Playful or Premium | Depends on product: pastels for beauty, dark for luxury, bright for fun | Varies — match the product vibe |
| Finance / Legal | Dark luxury or Classic | Navy, charcoal, forest green, gold — DARK and authoritative | Classic serif or refined sans |
| Health / Wellness | Soft organic | Sage, lavender, soft sky, warm sand — MUTED and calming | Rounded sans or warm serif |
| Education / Non-profit | Warm and approachable | Warm blues, soft greens, sunny yellows — FRIENDLY | Humanist sans, readable |
| Real estate / Architecture | Minimal luxe | Off-whites, charcoal, muted golds — MINIMAL | Thin geometric or editorial serif |
| Developer tools / Data | Dark mode tech | Near-black bg, neon accent (cyan, lime, pink) — HIGH CONTRAST | Monospace display + clean sans body |
| Creative / Portfolio | Expressive | Unexpected: magenta + teal, black + coral, deep purple + lime — BOLD | Anything distinctive |
| Events / Entertainment | Energetic | Vibrant saturated colors, gradients OK — HIGH ENERGY | Bold display, fun pairings |
| Local service / Trades | Trustworthy practical | Navy, forest green, or deep red with clean white — SOLID | Clean readable sans |

### Step 2: Pick ORIGINAL colors
Do NOT copy any palette you've seen before. Generate new hex values by:
1. Pick a background hue that fits the aesthetic (dark? warm white? cool gray? tinted?)
2. Pick a primary that CONTRASTS with the bg and matches the industry mood
3. Pick an accent that complements the primary (analogous, split-complementary, or triadic)
4. Derive surface, text, muted, border colors from these three anchors
5. Verify contrast: body text ≥ 4.5:1, large text ≥ 3:1 against their backgrounds

**BANNED combinations** (too common, feels like a template):
- White bg + blue primary + light blue accent
- White bg + purple/violet primary
- Cream/beige bg + brown/orange primary + gold accent
- Any combination you've generated in the last 10 sessions`);

  if (fontSection) {
    parts.push(`### Step 3: Choose fonts from the design guide
These are ideal web font pairings. Since HubSpot CMS uses system fonts, pick the CLOSEST system font stack that matches the mood of the ideal pairing:

${fontSection}

**System font mapping** — use these to approximate the above:
- Serif display (Playfair, Cormorant, Fraunces) → Georgia, Cambria, "Times New Roman", serif
- Clean body serif (Source Serif) → Georgia, "Times New Roman", serif
- Geometric sans (Satoshi, Outfit, Cabinet) → Futura, "Century Gothic", "Trebuchet MS", sans-serif
- Modern sans (DM Sans, Plus Jakarta, General Sans) → system-ui, -apple-system, "Segoe UI", sans-serif
- Humanist sans (Libre Franklin, Nunito) → Optima, Candara, "Noto Sans", sans-serif
- Monospace (Space Mono, JetBrains) → "SF Mono", "Cascadia Code", "Fira Code", monospace
- Bold display (Archivo Black, Bebas Neue, Syne) → Impact, "Arial Black", sans-serif
- Classic serif (Book Antiqua) → "Book Antiqua", Palatino, "Palatino Linotype", serif

Choose the pairing that matches the MOOD of the content, not the same one every time.`);
  }

  if (colorSection) {
    parts.push(`### Reference: Design Guide Color Philosophy
${colorSection}`);
  }

  parts.push(`### Step 4: Verify uniqueness
Before finalizing, ask yourself:
- Would this palette look DIFFERENT from a page I just designed for a different topic?
- Is the primary color something other than blue, brown, or purple?
- Would the user be surprised (pleasantly) by this color choice?
- Does the font pairing match the industry, not just "safe defaults"?

If any answer is "no," go bolder. The user wants personality, not safety.`);

  return parts.join("\n\n");
}

function extractSection(text: string, startMarker: string, endMarker: string): string {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return "";
  const endIdx = text.indexOf(endMarker, startIdx);
  return endIdx === -1 ? text.slice(startIdx) : text.slice(startIdx, endIdx).trim();
}

// ---------------------------------------------------------------------------
// Guide summaries (shared by both prompts)
// ---------------------------------------------------------------------------

function getArchitectDesignSummary(): string {
  return `### Design Philosophy
You are a senior UI designer. Every page must look professionally designed, not like AI output.
Avoid "AI slop": purple gradients on white, cookie-cutter card grids, no personality.

Before designing, decide on:
- **Aesthetic direction**: minimal editorial? bold brutalist? warm organic? luxury dark-mode? Pick one and commit.
- **One memorable element**: unusual layout, clever animation, striking color, unexpected typography.
- **Audience**: the audience shapes the vibe. A SaaS dashboard ≠ a restaurant landing page.

When a user gives a simple prompt like "build me a landing page for a coffee shop," internally expand it:
- Pick an aesthetic (warm, editorial, slightly vintage)
- Pick ORIGINAL colors derived from the topic (coffee → think espresso browns, cream tones, warm gold — but pick your own unique hex values every time)
- Decide hero style (full-bleed image background, overlaid text)
- Choose layout approach (asymmetric sections, large visual areas)
- Add texture (subtle paper/grain noise overlay)
- Set animations (scroll-triggered reveals)
The user gives the "what," you decide the "how it should look and feel." Every project gets a fresh, unique palette.

### Typography Scale
Include these in the CSS custom properties:
\`\`\`
h1: clamp(2.5rem, 5vw, 4.5rem)    /* Hero headlines — BIG */
h2: clamp(1.75rem, 3vw, 3rem)     /* Section headings */
h3: clamp(1.25rem, 2vw, 1.75rem)  /* Card titles, subheadings */
body: 1rem - 1.125rem              /* 16-18px body text */
small: 0.875rem                     /* Captions, labels */
line-height: 1.1-1.2 for headings, 1.5-1.7 for body
letter-spacing: -0.02em to -0.04em for large headings (tighter = more premium)
\`\`\`

### Color Palettes
Pick a dominant (70%), secondary (25%), accent (5%). Ensure WCAG AA contrast (4.5:1 body, 3:1 large text).

**CRITICAL: Every project MUST have a unique palette derived from its specific content.** The palette should feel inevitable for the topic — like a designer hand-picked it for this exact business.

Derive colors from the CONTENT, not from defaults:
- Read the topic/industry from the user's request
- Think about what colors that industry evokes (coffee → deep browns; ocean resort → teals; cybersecurity → dark + neon)
- Pick a bg, primary, and accent that tell that specific story
- Never default to warm beige/brown/orange — that's only right for earthy/organic topics

**BANNED default combinations** (too commonly generated):
- Cream/beige bg (#faf7f2 etc.) + brown primary + gold/orange accent — unless the topic is explicitly earthy (coffee, bakery, farmhouse)
- White bg + blue primary + light blue accent — unless the topic is explicitly corporate/finance
- Any palette with all warm tones (beige + brown + orange + gold) — mix temperature

### Layout Patterns
1. **Split hero**: Content left, visual right (50/50 or 60/40)
2. **Full-bleed hero**: Edge-to-edge background with centered content overlay
3. **Bento grid**: Asymmetric grid with mixed card sizes (span-2, span-1)
4. **Staggered/offset**: Content blocks not perfectly aligned, adds dynamism
5. **Overlapping elements**: Cards/images that break grid lines, overlap sections
6. **Scroll-based reveal**: Content appears as you scroll

### Background Treatments (pick 1-2 per page)
Include these in shared CSS:
- **Subtle grid pattern**: linear-gradient with thin lines at 60px intervals
- **Noise texture overlay**: SVG feTurbulence filter at 0.03 opacity, fixed position
- **Gradient orb/blob**: 600px radial-gradient circle, blurred 80px, absolute positioned
- **Radial gradient on sections**: radial-gradient(ellipse at top, rgba(primary, 0.05), transparent 70%)
- **Background alternation**: alternate section backgrounds every 2-3 sections to create visual "chapters"

### Micro-Interactions (include in shared CSS)
- **Card hover**: translateY(-4px) + box-shadow 20px 40px rgba(0,0,0,0.1), transition 0.3s ease
- **Button hover**: translateY(-1px) + box-shadow 4px 12px rgba(primary, 0.3), transition 0.2s
- **Link underline**: pseudo-element width 0 → 100% on hover, transition 0.3s
- **Scroll animations**: data-animate elements start opacity:0 translateY(20px), animate to visible via IntersectionObserver. Include CSS fallback: elements become visible after 3s even if JS fails.
- **Stagger children**: transition-delay: calc(var(--index) * 100ms)

### Component Requirements
- **Hero**: Visually dominant headline (largest on page), subheading with lower contrast, clear CTA with hover, visual interest (gradient/image/pattern/animation), min 80vh. Every hero needs a "wow."
- **Navigation**: Sticky with backdrop-blur-md bg-white/80, logo left, CTA right, active state indicator, smooth transition on scroll (shrink, shadow, bg change)
- **Cards**: Subtle border OR shadow (not both heavy), rounded-xl to rounded-2xl, consistent padding, hover lift. Optional: subtle gradient border with pseudo-element
- **Buttons**: Primary filled + secondary outlined/ghost, generous padding (px-6 py-3 min). CRITICAL: Re-declare color, text-decoration:none, and font-family on :hover/:focus/:active — HubSpot overrides link hover styles
- **Footer**: Darker than page, multi-column (3-4 cols), stacked on mobile, subtle separator from main content

### Spacing
- Section padding: 80-128px vertical
- Content max-width: 1152-1280px centered
- Card padding: 24-32px, gap: 24-32px
- Between heading and body: 16-24px
- Generous whitespace = premium. Cramped = amateur.
- Mobile: always responsive, use clamp() for fluid sizing

### Quality Checklist
- [ ] Color palette has personality (not generic blue/purple on white)
- [ ] Typography scale is consistent (headings use clamp(), body 16-18px)
- [ ] Spacing is generous (sections have 80px+ padding)
- [ ] At least one "wow" element (animation, unusual layout, bold color)
- [ ] Backgrounds aren't flat (subtle pattern, gradient, or texture)
- [ ] Hover states exist (cards lift, buttons shift, links animate)
- [ ] Scroll animations present with CSS fallback
- [ ] Mobile responsive (works at 375px)
- [ ] Contrast ratios pass WCAG AA
- [ ] Page feels cohesive (one aesthetic direction, not a Frankenstein)

### Anti-Patterns

| Don't | Do Instead |
|-------|-----------|
| Purple gradient on white | Choose a palette with personality |
| Symmetric 3-col grids for everything | Mix layouts: bento, split, offset, overlapping |
| Flat white/gray backgrounds | Add subtle texture, gradient, or pattern |
| Tiny padding between sections | Use 80-128px for breathing room |
| All animations same speed | Stagger with increasing delays |
| Skip hover/focus states | Every interactive element needs feedback |
| Use \`<br>\` tags for spacing | Use proper margin/padding |
| Put everything in a shadowed card | Vary: full-bleed, contained, floating |`;
}

function getArchitectContentSummary(): string {
  return `### Mandatory Page Sections (generate all)
1. **Navigation Bar** — Logo, 4-5 nav links, CTA button, sticky on scroll
2. **Hero** — Badge/pill, primary headline, subheadline, primary + secondary CTA, trust signals, visual element
3. **Social Proof Bar** — Logo strip of 4-6 clients OR stats bar (compact, py-8)
4. **Features/Services** — Section label + headline, 3-6 cards with icon/title/description/metric
5. **How It Works** — 3-4 numbered steps with titles, descriptions, visuals, connected flow
6. **Testimonials** — At least 3 with full quotes, names, roles, ratings
7. **Pricing/Value** — Pricing tiers or key metrics in large text with context + CTA
8. **FAQ** — 4-6 real questions with specific, helpful answers
9. **Final CTA** — Strong headline, subtext, primary + secondary buttons, visually distinct
10. **Footer** — Brand name, 3-4 link columns with 3-5 links each, contact info, social icons, copyright

### Optional Sections (include 1-2 when they fit)
- Comparison table ("Us vs. Them")
- Case study highlight
- Team/About strip
- Blog/Resource teasers
- Partners/Integrations logo grid

### Headline Rules — The "Bar Test"
Every headline should pass this test: if you shouted it across a bar, would someone turn their head?

| Don't | Do Instead |
|-------|-----------|
| "Our Services" | "What We Actually Do" |
| "How It Works" | "Unclogged in 3 Steps" |
| "Pricing" | "Cheaper Than Your Uber Eats Habit" |
| "Testimonials" | "Don't Take Our Word For It" |
| "Get Started" | "Blocked Drain? Text Us a Photo." |
| "Features" | "Everything You Get, Nothing You Don't" |

### CTA Button Copy
Never use "Submit" or "Learn More." Tie CTAs to specific outcomes:
"Book Now — From €49 →" · "Start Free Trial · No Card Required" · "Get My Custom Quote in 10 Min" · "Join 2,000+ Happy Customers"

### Minimum Content Quantities

| Element | Min | Why |
|---------|-----|-----|
| Testimonials | 3 | One looks fake, two looks thin |
| Feature cards | 4 | Three is a wireframe |
| FAQ items | 4 | Fewer looks like hiding something |
| Process steps | 3 | Natural narrative arc |
| Stats/metrics | 3 | Singles look accidental |
| Footer columns | 3 | Fewer = side project |
| Nav links | 4-5 | Establishes depth |
| CTA repetitions | 3 | Hero, mid-page, closing |

### Business Type Content Templates

**Local Service** (plumber, electrician, cleaner): Hero = pain point + speed promise. Must-have: service area, response time, pricing. CTAs: phone, WhatsApp, booking. Stats: response time, jobs done, satisfaction.

**SaaS/Tech Product**: Hero = outcome-first ("Save 10hrs/week"). Must-have: feature grid, integration logos, product visual. CTAs: free trial, demo. Stats: performance, customer count, uptime.

**Restaurant/Food**: Hero = sensory/emotional ("Farm-to-table since 2019"). Must-have: menu highlights with prices, hours, location. CTAs: reserve, order, menu. Stats: years open, dishes served.

**E-commerce/DTC**: Hero = benefit + social proof ("Join 50K+ happy sleepers"). Must-have: features, comparison, guarantee. CTAs: shop, add to cart, "Try risk-free." Stats: units sold, return rate.

**Agency/Consultancy**: Hero = expertise + outcome ("Scaled 40+ brands past €1M"). Must-have: services, case studies, process. CTAs: book call, see cases, get proposal. Stats: clients, revenue, years.

### Content Density — Never Leave Empty Space
At every viewport-height (100vh), the user should see:
- At least one piece of **specific data** (number, price, time, rating)
- At least one piece of **social proof** (quote, logo, rating, customer count)
- At least one **visual element** (icon, illustration, decorative shape, gradient block)
- A clear sense of **what section they're in** (label + headline visible)

Every card must contain ALL of: icon/visual, title (3-6 words), description (2-3 sentences with specific detail), optional link/metric. Never generate a card that is just a title and one sentence.

### Content Rhythm & Visual Pacing
Alternate section density — don't make every section the same weight:
- HERO: Full, rich, attention-grabbing (100vh)
- TRUST BAR: Compact (py-8 to py-12)
- FEATURES: Dense, multi-card grid (tall section)
- HOW IT WORKS: Medium, 3-4 steps with breathing room
- TESTIMONIALS: Dense, 3+ cards
- PRICING: Medium, 2-3 focused cards
- FAQ: Compact (accordion saves space)
- FINAL CTA: Full width, bold, short (50vh max)
- FOOTER: Dense with links, compact

Alternate backgrounds every 2-3 sections to create visual "chapters." Sprinkle trust signals throughout (not just one section).

### Body Copy Rules
- Never write generic filler. Every sentence needs a SPECIFIC detail.
- Invent plausible specifics: neighborhood names, "48 hours" not "quickly", "€49" not "affordable"
- Keep paragraphs to 2-3 sentences max
- Aim for 6th-grade reading level
- Include section labels (UPPERCASE, letter-spacing 0.1em, accent color, 2-3 words) above every headline`;
}

function getArchitectHumanifySummary(): string {
  return `### Banned Punctuation
- **Em dashes (—)**: NEVER use. Biggest AI tell. Replace with periods, commas, or parentheses.
- **Semicolons**: Feel academic, not conversational. Use periods instead.
- **Exclamation marks**: One per page maximum. Zero is ideal for B2B.

### Banned Words
**HARD BANNED (always rewrite):**
delve, tapestry, multifaceted, utilize, harness, bolster, underscore, illuminate, facilitate, fostering, garner, pivotal, commence, endeavor, myriad, plethora, pertinent, aforementioned, wherein, henceforth, beacon, synergy, paradigm, bespoke, holistic, spearhead, embark, reimagine, cultivate, cornerstone

**SOFT BANNED (rewrite unless truly specific):**
seamless, cutting-edge, groundbreaking, game-changer, revolutionary, transformative, innovative, robust, comprehensive, foundational, nuanced, landscape (abstract), realm, catalyst, empower, elevate, unlock, streamline, optimize, curated, navigate (abstract)

### Banned Openers
"In today's", "In an era", "In the realm", "Whether you're", "Are you tired", "Imagine a world", "Picture this", "Here's the thing", "Let's face it", "Look no further", "Say goodbye to", "Gone are the days", "It's no secret", "At its core", "At the end of the day", "When it comes to"

### Banned Closers
"The future of [X] is here", "Your journey starts here", "Join the revolution", "Experience the difference", "See what's possible", "Ready to take the next step"

### Banned Structures
- "It's not about X, it's about Y" (second biggest AI tell after em dashes)
- "It's not just X, it's Y"
- "[X]. Here's why." / "[X]. And it matters."
- "Despite the challenges"
- Tricolon abuse ("Fast, reliable, revolutionary") — once per page max

### Positive Rules
- Be concrete, not abstract: "42 minutes" not "fast", "€29/month" not "affordable"
- Use plain short words: use > utilize, start > commence, help > facilitate
- Vary sentence length aggressively: mix 3-word, 12-word, and 25-word sentences
- Front-load the benefit in the first 5 words
- Write like you'd explain it in a bar — if you wouldn't say it holding a beer, rewrite it`;
}
