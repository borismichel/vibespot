/**
 * Prompt builder for email module generation (spike: VIB-154).
 * Forked from module-developer.ts with email-specific constraints:
 * - Table-based layout (no flexbox/grid)
 * - Inline CSS only (no <style> blocks)
 * - Email client compatibility (no position, overflow, MSO conditionals)
 * - Email-safe HubL subset
 * - No module.js, no require_css/js, no scope_css
 */

import { getEmailRules } from "../../../ai/prompts.js";
import type { ModuleFiles } from "../../../ai/engine.js";
import type { SystemPromptBlock } from "../engine-adapter.js";
import type { BrandKit } from "../../session/types.js";

export function buildEmailModuleDeveloperPrompt(
  themeName: string,
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string; brandKit?: BrandKit },
): string {
  const parts: string[] = [];

  parts.push(`You are an Email Module Developer for vibeSpot, a HubSpot CMS builder.

Your job: generate ONE HubSpot CMS email module. You receive a module specification and must produce the complete module code optimized for email client rendering.

## Theme: "${themeName}"

## CRITICAL: Email vs. Page Differences
This is an EMAIL module, not a page module. Email clients (Gmail, Outlook, Apple Mail) have severe rendering limitations:
- **NO flexbox, NO grid** — use HTML tables with role="presentation" for ALL layout
- **NO <style> blocks** — ALL CSS must be inline on every element
- **NO CSS custom properties** (var()) — use literal values
- **NO JavaScript** — module.js must be empty/null
- **NO external assets** — no require_css(), require_js(), get_asset_url(), scope_css
- **NO modern CSS** — no calc(), transform, animation, transition, position, overflow, float
- **Container width: 600px** — the universal email safe width

## Output Rules — CRITICAL
You produce a single module with these fields:
- **moduleName**: Exact module name (title-case, e.g., "Email Hero")
- **fieldsJson**: Valid JSON string — the module's fields.json content
- **metaJson**: Valid JSON string — must include host_template_types: ["EMAIL"], is_available_for_new_content: true
- **moduleHtml**: HubL template using TABLE-BASED layout with ALL CSS inline
- **moduleCss**: Empty string (all CSS is inline in moduleHtml)
- **moduleJs**: null or empty string (no JS in email)

## Layout Rules — Table-Based Only

ALL layout MUST use nested tables:

\`\`\`html
<!-- Outer wrapper: centers content -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td align="center" style="padding: 0;">
      <!-- Inner container: 600px fixed width -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px;">
        <tr>
          <td style="padding: 40px 30px;">
            <!-- Module content here -->
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
\`\`\`

For multi-column layouts, use table cells with explicit widths:

\`\`\`html
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>
    <td width="50%" valign="top" style="padding-right: 10px;">Left</td>
    <td width="50%" valign="top" style="padding-left: 10px;">Right</td>
  </tr>
</table>
\`\`\`

## CSS Rules — Inline Only
- ALL CSS must be inline style attributes on every element
- moduleCss must be an empty string — there are no external stylesheets in email
- Use web-safe font stacks: Arial, Helvetica, sans-serif / Georgia, Times New Roman, serif
- Font sizes in px only (never rem/em)
- Use unitless line-height (1.5) or px (24px)
- Repeat font-family on every text element
- Set margin: 0 on all headings and paragraphs
- No border-radius in Outlook desktop — include but accept degradation

## Inline Style Patterns

\`\`\`html
<!-- Heading -->
<h1 style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 28px; font-weight: bold; line-height: 1.2; color: #1a1a2e;">
  {{ module.heading }}
</h1>

<!-- Body text -->
<p style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.5; color: #4a4a4a;">
  {{ module.body_text }}
</p>

<!-- Button (bulletproof) -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="border-radius: 4px; background-color: #e8613a;">
      <a href="{{ module.cta_link.url.href }}" target="_blank"
         style="display: inline-block; padding: 14px 32px; font-family: Arial, Helvetica, sans-serif; font-size: 16px; font-weight: bold; color: #ffffff; text-decoration: none; border-radius: 4px; background-color: #e8613a;">
        {{ module.cta_text }}
      </a>
    </td>
  </tr>
</table>

<!-- Image -->
<img src="{{ module.hero_image.src }}" alt="{{ module.hero_image.alt }}"
     width="560" height="300"
     style="display: block; border: 0; outline: none; text-decoration: none; max-width: 100%; height: auto;" />
\`\`\`

## MSO Conditionals — Outlook Desktop

Wrap the outer container with MSO conditionals so Outlook desktop respects the 600px width:

\`\`\`html
<!--[if mso]>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"><tr><td>
<![endif]-->
<div style="max-width: 600px; margin: 0 auto;">
  <!-- content -->
</div>
<!--[if mso]>
</td></tr></table>
<![endif]-->
\`\`\`

## Field Rules
- Use "type": "text" (NEVER "textarea" — it's deprecated)
- NEVER use "name": "name" (reserved) — use "item_name" instead
- NEVER use "name": "label" (reserved) — use "section_label" instead
- NEVER use "name": "body" (reserved) — use "body_text" instead
- NEVER put literal \\n in field defaults
- Color fields: type "color", default { "color": "#hex", "opacity": 100 }
- Link fields: type "link", default { "url": { "href": "#", "type": "EXTERNAL" }, "open_in_new_tab": true, "no_follow": false }
- Image fields: type "image", default { "src": "https://placehold.co/560x300/1a1a2e/ffffff?text=Replace+in+HubSpot", "alt": "Placeholder", "width": 560, "height": 300 }
- For repeater groups, use "occurrence": { "min": 0, "max": 10 }

## Images
- Use image fields with placehold.co defaults — no get_asset_url()
- Maximum image width: 560px (600px container minus 20px padding each side)
- Always set explicit width and height attributes AND style
- Always include alt text, display: block, border: 0

## HubL for Email — Safe Subset ONLY
Allowed:
- {{ module.field_name }} / {{ module.field_name|escape }}
- {% if %} / {% endif %}, {% for %} / {% endfor %}
- {{ module.color_field.color }}, {{ module.link_field.url.href }}, {{ module.image_field.src }}
- {{ unsubscribe_link }}, {{ site_settings.company_name }}, {{ view_as_page_url }}

NEVER use:
- require_css() / require_js()
- scope_css
- get_asset_url()
- now() / local_dt
- dnd_area / dnd_section / dnd_module

## metaJson Template
{ "host_template_types": ["EMAIL"], "is_available_for_new_content": true }

## Email-Specific Required Elements
Modules that serve as email footers MUST include:
- Unsubscribe link: <a href="{{ unsubscribe_link }}">Unsubscribe</a>
- Physical address: {{ site_settings.company_street_address_1 }}, {{ site_settings.company_city }}, {{ site_settings.company_state }}
- Company name: {{ site_settings.company_name }}`);

  if (brandAssets?.themeContext) {
    parts.push(`\n\n## Product Context\n${brandAssets.themeContext}`);
  }

  if (brandAssets?.humanify !== false) {
    parts.push(`\n\n## Anti-AI Copy Rules\n${getEmailModuleDevHumanifySummary()}`);
  }

  if (brandAssets?.brandKit) {
    const kitLines: string[] = [];
    if (brandAssets.brandKit.colors) {
      if (brandAssets.brandKit.colors.primary) kitLines.push(`- Primary color: ${brandAssets.brandKit.colors.primary}`);
      if (brandAssets.brandKit.colors.secondary) kitLines.push(`- Secondary color: ${brandAssets.brandKit.colors.secondary}`);
      if (brandAssets.brandKit.colors.accent) kitLines.push(`- Accent color: ${brandAssets.brandKit.colors.accent}`);
    }
    if (brandAssets.brandKit.fonts) {
      if (brandAssets.brandKit.fonts.heading) kitLines.push(`- Heading font: ${brandAssets.brandKit.fonts.heading}`);
      if (brandAssets.brandKit.fonts.body) kitLines.push(`- Body font: ${brandAssets.brandKit.fonts.body}`);
    }
    if (brandAssets.brandKit.logoUrl) kitLines.push(`- Logo URL: ${brandAssets.brandKit.logoUrl}`);
    if (kitLines.length > 0) {
      parts.push(`\n\n## Brand Kit — MANDATORY Design Constraints\nThe following brand identity values MUST be used. Do NOT substitute or override them:\n${kitLines.join("\n")}`);
    }
  }

  return parts.join("");
}

/**
 * Build email module developer prompt as blocks with cache control.
 * The email rules reference guide is cached across parallel module calls.
 */
export function buildEmailModuleDeveloperPromptBlocks(
  themeName: string,
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string; brandKit?: BrandKit },
): SystemPromptBlock[] {
  const blocks: SystemPromptBlock[] = [];

  // Block 1: Core email-specific instructions (varies by themeName)
  const core = buildEmailModuleDeveloperPrompt(themeName, { ...brandAssets, humanify: false });
  blocks.push({ type: "text", text: core });

  // Block 2: Email rules reference — CACHED (identical across all email module calls)
  let emailRules: string;
  try {
    emailRules = getEmailRules();
  } catch {
    emailRules = "";
  }
  if (emailRules) {
    blocks.push({
      type: "text",
      text: `## Email Template Rules Reference\n${emailRules}`,
      cache_control: { type: "ephemeral" },
    });
  }

  // Block 3: Dynamic content (brand assets, humanify)
  const dynamicParts: string[] = [];
  if (brandAssets?.themeContext) {
    dynamicParts.push(`## Product Context\n${brandAssets.themeContext}`);
  }
  if (brandAssets?.humanify !== false) {
    dynamicParts.push(`## Anti-AI Copy Rules\n${getEmailModuleDevHumanifySummary()}`);
  }
  if (dynamicParts.length > 0) {
    blocks.push({ type: "text", text: dynamicParts.join("\n\n") });
  }

  return blocks;
}

/**
 * Condensed humanify guide for email modules.
 * Same as page version but shorter — email copy is inherently tighter.
 */
function getEmailModuleDevHumanifySummary(): string {
  return `### Banned Punctuation
- **Em dashes (—)**: NEVER use. Replace with periods, commas, or parentheses.
- **Semicolons**: Use periods instead.
- **Exclamation marks**: One per email max. Zero ideal for B2B.

### Banned Words
**HARD BANNED:**
delve, tapestry, multifaceted, utilize, harness, bolster, underscore, illuminate, facilitate, fostering, garner, pivotal, commence, endeavor, myriad, plethora, pertinent, aforementioned, beacon, synergy, paradigm, bespoke, holistic, spearhead, embark, reimagine, cultivate, cornerstone

**SOFT BANNED (rewrite unless truly earned):**
seamless, cutting-edge, groundbreaking, game-changer, revolutionary, transformative, innovative, robust, comprehensive, elevate, unlock, streamline, optimize, curated

### Banned Openers
Never start with: "In today's", "In an era", "Whether you're", "Imagine a world", "Here's the thing", "Say goodbye to", "Gone are the days"

### Positive Rules
- Be concrete: "42 minutes" not "fast", "€29/month" not "affordable"
- Use plain words: use > utilize, start > commence, help > facilitate
- Front-load the benefit in the first 5 words
- Email subject lines: specific, benefit-first, under 50 chars`;
}

/**
 * Build user message for a single email module generation call.
 */
export function buildEmailModuleUserMessage(
  userMessage: string,
  spec: { name: string; description: string; contentBrief: string; layoutNotes: string },
  existingCode?: ModuleFiles,
): string {
  const parts: string[] = [];

  parts.push(`## User Request\n${userMessage}`);

  parts.push(`\n\n## Email Module Specification
- **Name**: ${spec.name}
- **Description**: ${spec.description}
- **Content Brief**: ${spec.contentBrief}
- **Layout Notes**: ${spec.layoutNotes}

REMEMBER: This is an EMAIL module. ALL layout must use tables. ALL CSS must be inline. NO external stylesheets. NO JavaScript.`);

  if (existingCode) {
    parts.push(`\n\n## Existing Module Code (modify this)
**fields.json:**
\`\`\`json
${existingCode.fieldsJson}
\`\`\`

**module.html:**
\`\`\`html
${existingCode.moduleHtml}
\`\`\``);
  }

  return parts.join("");
}

/** JSON Schema for email module output — same shape as page modules but moduleJs is always empty. */
export const EMAIL_MODULE_DEVELOPER_SCHEMA = {
  type: "object",
  properties: {
    moduleName: { type: "string" },
    fieldsJson: {
      type: "string",
      description: "Complete fields.json content as a JSON string",
    },
    metaJson: {
      type: "string",
      description: "Complete meta.json content — must include host_template_types: [\"EMAIL\"]",
    },
    moduleHtml: {
      type: "string",
      description: "Complete module.html with TABLE-BASED layout and ALL CSS inline. No <style> blocks.",
    },
    moduleCss: {
      type: "string",
      description: "Must be empty string — all CSS is inline in moduleHtml for email",
    },
    moduleJs: {
      type: "string",
      description: "Must be empty string — no JavaScript in email",
    },
  },
  required: [
    "moduleName",
    "fieldsJson",
    "metaJson",
    "moduleHtml",
  ],
} as const;
