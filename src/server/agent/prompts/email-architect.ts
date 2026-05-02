/**
 * Prompt builders for Stage 2 (Email): Design Tokens + Module Planner.
 *
 * Email templates cannot use CSS custom properties, external stylesheets,
 * flexbox, grid, or JavaScript. The "design system" for email is a set of
 * inline-safe style tokens (colors, fonts, sizes) that module developers
 * reference directly in inline styles.
 */

import type { SystemPromptBlock } from "../engine-adapter.js";
import type { BrandKit } from "../../session/types.js";

function formatBrandKitConstraints(kit?: BrandKit): string {
  if (!kit) return "";
  const lines: string[] = [];
  if (kit.colors) {
    if (kit.colors.primary) lines.push(`- Primary color: ${kit.colors.primary}`);
    if (kit.colors.secondary) lines.push(`- Secondary color: ${kit.colors.secondary}`);
    if (kit.colors.accent) lines.push(`- Accent color: ${kit.colors.accent}`);
  }
  if (kit.fonts) {
    if (kit.fonts.heading) lines.push(`- Heading font: ${kit.fonts.heading}`);
    if (kit.fonts.body) lines.push(`- Body font: ${kit.fonts.body}`);
  }
  if (kit.logoUrl) lines.push(`- Logo URL: ${kit.logoUrl}`);
  if (lines.length === 0) return "";
  return `\n\n## Brand Kit — MANDATORY Design Constraints\nThe following brand identity values MUST be used. Do NOT substitute or override them:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Stage 2a: Email Design Tokens
// ---------------------------------------------------------------------------

export function buildEmailDesignSystemPrompt(
  themeName: string,
  brandAssets?: { styleguide?: string; brandvoice?: string; themeContext?: string; brandKit?: BrandKit },
): string {
  const parts: string[] = [];

  parts.push(`You are the Email Design Token Architect for vibeSpot, a HubSpot email template builder.

Your job: create a complete set of inline-safe design tokens for an email template. Email clients do NOT support CSS custom properties (var()), external stylesheets, flexbox, grid, or JavaScript. All styling must be inline.

You produce a token map (colors, fonts, sizes) and a style guide string that downstream email module developers will reference when writing inline styles.

## Theme: "${themeName}"

## Output Requirements

### cssVariables
A flat object mapping token names to literal CSS values. These are NOT CSS custom properties — they are a reference map for module developers to copy into inline styles. Use descriptive names:

**Colors** (choose original values that fit the topic — no default palette):
- bg-color: email body background
- content-bg: main content area background
- text-color: primary text color
- text-muted: secondary text color
- text-light: light text for footers
- heading-color: heading text color
- primary-color: primary brand/CTA color
- primary-hover: darker primary for button states
- accent-color: accent/highlight color
- border-color: divider/border color
- footer-bg: footer background color

**Typography** (web-safe stacks only — pick the pairing that fits the mood):
- font-heading: heading font stack
- font-body: body font stack
- size-h1: main heading size in px (e.g., "28px")
- size-h2: section heading size in px (e.g., "22px")
- size-h3: subheading size in px (e.g., "18px")
- size-body: body text size in px (e.g., "16px")
- size-small: small/footer text size in px (e.g., "13px")
- line-height: body line height (e.g., "1.5")

**Spacing** (px only):
- content-width: email content width (always "600")
- padding-section: vertical section padding (e.g., "40")
- padding-cell: cell padding (e.g., "20")
- padding-button: button padding (e.g., "14px 32px")

### sharedCss
For email, this MUST be an empty string "". Email modules use inline styles only.

### sharedJs
MUST be omitted or empty string. No JavaScript in email.

### aesthetic
Brief description of the chosen email design direction (e.g., "clean professional with warm coral accents").

## Email Design Rules — CRITICAL

### Font Strategy
Use ONLY web-safe font stacks. These are the only fonts guaranteed across email clients:

| Style | Stack |
|-------|-------|
| Sans-serif | Arial, Helvetica, sans-serif |
| Serif | Georgia, "Times New Roman", Times, serif |
| Modern sans | Verdana, Geneva, sans-serif |
| Compact | Tahoma, Geneva, sans-serif |
| Monospace | "Courier New", Courier, monospace |

Do NOT use: system-ui, -apple-system, Segoe UI, Inter, or any Google Fonts.

### Color Rules
- Use hex colors only (no rgb(), hsl(), or named colors)
- Ensure WCAG AA contrast (4.5:1 for body text, 3:1 for large text)
- CTA buttons need high contrast against both email body and content area backgrounds
- Consider dark mode: some clients invert colors. Use medium-contrast ratios that work inverted.

### Size Rules
- All font sizes in px (never rem, em, or clamp())
- Line heights as unitless numbers (1.5) or px values
- Container width always 600px
- Padding/margin in px only
- Button padding generous: at least 12px vertical, 28px horizontal

### What NOT to generate
- No CSS custom properties (var())
- No calc(), clamp(), or CSS functions
- No @media queries (module developers may add progressive enhancement)
- No animation, transition, or transform values
- No box-shadow or text-shadow (poor email support)
- No flexbox or grid references
- No external font imports`);

  parts.push(`\n\n## Email Design Guide\n${getEmailDesignSummary()}`);

  if (brandAssets?.styleguide) {
    parts.push(`\n\n## Brand Style Guide\n${brandAssets.styleguide}`);
  }
  if (brandAssets?.themeContext) {
    parts.push(`\n\n## Product Context\n${brandAssets.themeContext}`);
  }

  const kitBlock = formatBrandKitConstraints(brandAssets?.brandKit);
  if (kitBlock) {
    parts.push(kitBlock);
  } else if (!brandAssets?.styleguide) {
    parts.push(`\n\n## No Brand Provided — Be Creative
No brand colors or fonts have been set. Invent an original color palette that fits the email's topic and audience. Do NOT fall back to generic grays and blues. Choose web-safe font pairings (heading + body) that match the mood — vary between serif, sans-serif, and other stacks based on what fits.`);
  }

  return parts.join("");
}

export function buildEmailDesignSystemPromptBlocks(
  themeName: string,
  brandAssets?: { styleguide?: string; brandvoice?: string; themeContext?: string; brandKit?: BrandKit },
): SystemPromptBlock[] {
  const full = buildEmailDesignSystemPrompt(themeName);
  const marker = "\n\n## Email Design Guide\n";
  const markerIdx = full.indexOf(marker);

  if (markerIdx === -1) {
    return [{ type: "text", text: full }];
  }

  const corePart = full.slice(0, markerIdx);
  const designGuide = `## Email Design Guide\n${getEmailDesignSummary()}`;

  const blocks: SystemPromptBlock[] = [
    { type: "text", text: corePart },
    { type: "text", text: designGuide, cache_control: { type: "ephemeral" } },
  ];

  const dynamicParts: string[] = [];
  if (brandAssets?.styleguide) dynamicParts.push(`## Brand Style Guide\n${brandAssets.styleguide}`);
  if (brandAssets?.themeContext) dynamicParts.push(`## Product Context\n${brandAssets.themeContext}`);
  const kitBlock = formatBrandKitConstraints(brandAssets?.brandKit);
  if (kitBlock) {
    dynamicParts.push(kitBlock);
  } else if (!brandAssets?.styleguide) {
    dynamicParts.push(`## No Brand Provided — Be Creative
No brand colors or fonts have been set. Invent an original color palette that fits the email's topic and audience. Do NOT fall back to generic grays and blues. Choose web-safe font pairings (heading + body) that match the mood — vary between serif, sans-serif, and other stacks based on what fits.`);
  }
  if (dynamicParts.length > 0) {
    blocks.push({ type: "text", text: dynamicParts.join("\n\n") });
  }

  return blocks;
}

export const EMAIL_DESIGN_SYSTEM_SCHEMA = {
  type: "object",
  properties: {
    cssVariables: {
      type: "object",
      description: "Token name → literal CSS value map. NOT CSS custom properties. These are reference values for inline styles (e.g., 'bg-color': '#f4f4f4', 'font-body': 'Arial, Helvetica, sans-serif').",
    },
    sharedCss: {
      type: "string",
      description: "MUST be empty string for email templates. Email uses inline styles only.",
    },
    sharedJs: {
      type: "string",
      description: "MUST be empty string for email templates. No JavaScript in email.",
    },
    aesthetic: {
      type: "string",
      description: "Brief description of the chosen email design direction.",
    },
  },
  required: ["cssVariables", "sharedCss", "aesthetic"],
} as const;

// ---------------------------------------------------------------------------
// Stage 2b: Email Module Planner
// ---------------------------------------------------------------------------

export function buildEmailModulePlannerPrompt(
  themeName: string,
  designTokens: Record<string, string>,
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string; brandKit?: BrandKit },
  guidesNeeded?: string[],
): string {
  const parts: string[] = [];

  const tokenSummary = Object.entries(designTokens)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  parts.push(`You are the Email Module Planner for vibeSpot, a HubSpot email template builder.

Your job: plan the modules (sections) for an email template. You define what each section contains and how it should look. You do NOT write module code — downstream Email Module Developers handle that.

The Design Tokens have already been created. Your module plans MUST reference these tokens for consistent styling.

## Theme: "${themeName}"

## Design Tokens
These literal values will be used in inline styles by module developers:

${tokenSummary}

## Email Structure Rules

### Standard Email Sections
Plan modules from this list (use what fits the email type):

1. **preheader** — Hidden preview text for inbox (always include)
2. **header** — Logo, optional nav links (keep simple)
3. **hero** — Main headline, hero image or illustration, primary CTA
4. **body-content** — Main message text, product details, or story
5. **features** / **highlights** — 2-3 feature cards or product highlights
6. **cta-block** — Standalone call-to-action section
7. **testimonial** — Customer quote or social proof
8. **footer** — Unsubscribe link, physical address, social links (required by law)

### Module Planning Rules
- Every email MUST have: preheader, header, at least one content section, footer
- Footer MUST include unsubscribe link and physical address (CAN-SPAM/GDPR)
- Keep emails focused: 3-6 modules total (shorter emails perform better)
- Each module is a self-contained table-based section
- Module names: kebab-case identifiers (e.g., "hero", "feature-grid", "cta-block")

### Content Briefs
- Be specific about copy: write actual headlines, body text, CTA labels
- Include placeholder image dimensions (e.g., "hero image 600x300")
- Specify button copy with action verbs ("Shop the Collection", "Read the Full Story")

### Layout Notes
- All layouts are table-based (no flexbox/grid)
- Reference design tokens by name (e.g., "Use primary-color for CTA background")
- Specify alignment (center, left) and padding values
- For multi-column sections: describe as "2-column table layout" or "3-column table layout"
- Max content width: 600px (email standard)

## Output Rules

### modules array
Each module needs: name, description, contentBrief, layoutNotes

### moduleOrder
List all module names in display order (top to bottom)

### narrative
One sentence describing the email's purpose and flow`);

  if (!guidesNeeded || guidesNeeded.includes("content")) {
    parts.push(`\n\n## Email Content Guide\n${getEmailContentSummary()}`);
  }

  if (brandAssets?.brandvoice) {
    parts.push(`\n\n## Brand Voice\n${brandAssets.brandvoice}`);
  }
  if (brandAssets?.themeContext) {
    parts.push(`\n\n## Product Context\n${brandAssets.themeContext}`);
  }
  if (brandAssets?.humanify !== false && guidesNeeded?.includes("humanify")) {
    parts.push(`\n\n## Anti-AI Copy Rules\n${getEmailHumanifySummary()}`);
  }

  const kitBlock2 = formatBrandKitConstraints(brandAssets?.brandKit);
  if (kitBlock2) parts.push(kitBlock2);

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Guide summaries
// ---------------------------------------------------------------------------

function getEmailDesignSummary(): string {
  return `### Email Design Philosophy
Design for the inbox, not the browser. Email templates must look clean and professional in Gmail, Outlook, Apple Mail, and Yahoo Mail simultaneously.

### Color Strategy
- **Background**: light gray (#f4f4f4 to #eeeeee) for email body, white (#ffffff) for content area
- **Text**: dark but not pure black (#333333 body, #1a1a1a headings) — pure black on white strains eyes
- **CTA buttons**: high-saturation brand color, minimum 44px touch target height
- **Dividers**: light borders (#e0e0e0 to #dddddd), 1px solid

### Typography Strategy
- Headings: 24-32px, bold, short line length (max 8 words)
- Body: 15-17px (16px is the sweet spot), line-height 1.5-1.6
- Small/legal: 12-13px, muted color
- Button text: 15-17px, bold, uppercase optional

### Layout Strategy
- 600px container (fits all clients including Outlook desktop)
- Single-column for mobile friendliness (stacks naturally)
- 2-column max for feature grids (stack to 1-col on mobile)
- Generous padding: 40-60px vertical between sections, 20-30px horizontal
- White space is your friend — cramped emails get deleted

### CTA Button Design
- Minimum 44px height (touch target)
- 14-16px vertical padding, 28-40px horizontal
- Rounded corners via border-radius (degrades gracefully in Outlook)
- VML fallback for Outlook (module developer handles this)
- One primary CTA per email (secondary CTAs as text links)

### Image Guidelines
- Hero images: 600px wide, 2:1 to 3:1 aspect ratio
- Always include alt text (images blocked by default in many clients)
- Use display:block to prevent gaps in Outlook
- Product images: consistent sizing within a row`;
}

function getEmailContentSummary(): string {
  return `### Email Types and Structure

**Welcome / Onboarding Email**
- Warm greeting with first-name personalization
- 1-2 sentence value reminder (why they signed up)
- 3 numbered getting-started steps
- Single primary CTA
- Tone: friendly, concise, action-oriented

**Product Announcement**
- Bold headline announcing the update
- Hero image or product screenshot
- 3-4 key benefits (not features — what it means for them)
- Primary CTA to try/see the feature
- Tone: excited but not breathless

**Newsletter / Digest**
- Curated 3-5 content pieces with thumbnails
- Brief summary (2-3 sentences) per item
- "Read more" links per item + one main CTA
- Tone: informative, scannable

**Event Invitation**
- Event name, date, time, location (prominent)
- 2-3 sentence description of value
- Speaker/host info if applicable
- Single "Register" / "RSVP" CTA
- Tone: professional, creates urgency without hype

**Re-engagement**
- Acknowledge the absence directly ("We miss you")
- Highlight what they're missing (new features, content)
- Incentive if applicable (discount, free resource)
- Single "Come back" CTA
- Tone: genuine, no guilt-tripping

### Subject Line & Preheader
- Subject: 6-10 words, specific benefit or curiosity gap
- Preheader: extends the subject line, 40-90 characters
- Do NOT repeat the subject line in the preheader

### Email Copy Rules
- Front-load the key message in the first 2 sentences
- One idea per paragraph, 2-3 sentences max
- Use "you" more than "we"
- Specific > vague: "saves 3 hours/week" beats "saves time"
- CTA copy = verb + benefit: "Start Your Trial", "See the Results"`;
}

function getEmailHumanifySummary(): string {
  return `### Email-Specific Anti-AI Rules
- No em dashes (—) in email copy. Period.
- No "I hope this email finds you well"
- No "In today's fast-paced world"
- No "We're thrilled/excited/delighted to announce"
- Open with the point, not a preamble
- One exclamation mark per email maximum
- Avoid tricolon structures ("Fast, reliable, secure")
- Write like a colleague, not a press release
- Every sentence must earn its place — if removing it doesn't hurt, remove it`;
}
