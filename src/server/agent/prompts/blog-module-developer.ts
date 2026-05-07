/**
 * Prompt builder for blog module generation (VIB-160).
 * Forked from module-developer.ts with blog-specific context:
 * - HubSpot blog variables (content.post_body, content.author, etc.)
 * - Reading-optimized typography and spacing
 * - Blog listing loop patterns ({% for content in contents %})
 * - Pagination, tag filtering, related posts
 */

import { getBlogRules } from "../../../ai/prompts.js";
import {
  getConversionGuide,
  getHubspotRules,
} from "../../../ai/prompts.js";
import type { ModuleFiles } from "../../../ai/engine.js";
import type { SystemPromptBlock } from "../engine-adapter.js";

export function buildBlogModuleDeveloperPrompt(
  themeName: string,
  sharedCss: string,
  guidesNeeded?: string[],
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string },
): string {
  const parts: string[] = [];

  parts.push(`You are a Blog Module Developer for vibeSpot, a HubSpot CMS builder.

Your job: generate ONE HubSpot CMS blog module. You receive a module specification and must produce the complete module code optimized for blog templates.

## Theme: "${themeName}"

## CRITICAL: Blog Template Context
This is a BLOG module. Blog modules are used in HubSpot blog post and blog listing templates. They differ from page modules in these key ways:
- **Blog post modules** use HubSpot blog variables (\`{{ content.post_body }}\`, \`{{ content.author }}\`, \`{{ content.tag_list }}\`, etc.)
- **Blog listing modules** use \`{% for content in contents %}\` to loop over posts
- **Reading-optimized design** — wider line heights, constrained content width (680-720px), generous spacing
- **host_template_types** must be \`["BLOG_POST"]\`, \`["BLOG_LISTING"]\`, or \`["BLOG_POST", "BLOG_LISTING"]\`

## Output Rules — CRITICAL
You produce a single module with these fields:
- **moduleName**: Exact module name (kebab-case, e.g., "blog-post-header")
- **fieldsJson**: Valid JSON string — the module's fields.json content
- **metaJson**: Valid JSON string — must include the correct host_template_types and is_available_for_new_content: true
- **moduleHtml**: HubL template using blog variables where appropriate
- **moduleCss**: Vanilla CSS (no Tailwind, no Sass, no CDN imports)
- **moduleJs**: Optional vanilla JS wrapped in IIFE, or null

## CSS Rules
- All CSS classes must use prefix "${themeName}-"
- Use BEM naming: ${themeName}-moduleName__element--modifier
- Reference the theme's CSS custom properties (shown below)
- No CDN imports (@import url(), external <link> tags)
- Use system font stacks — no Google Fonts

## Reading-Optimized Design Tokens
Blog modules should use these design principles:
- Body text: 18-20px for long-form readability
- Line height: 1.6-1.8 for body copy
- Content width: 680-720px max for article body
- Generous paragraph spacing: 1.5em between paragraphs
- Clear heading hierarchy with adequate spacing
- High contrast for body text (WCAG AA minimum)

## Shared CSS (use these variables)
\`\`\`css
${sharedCss || "/* No shared CSS yet — create appropriate custom properties */"}
\`\`\`

## HubSpot Blog Variables — Use These

### Blog Post Variables
\`\`\`
{{ content.name }}                    — Post title
{{ content.post_body }}               — Full post body HTML
{{ content.featured_image }}          — Featured image URL
{{ content.featured_image_alt_text }} — Featured image alt text
{{ content.publish_date }}            — Publish date
{{ content.blog_post_author }}        — Author name
{{ content.author.display_name }}     — Author display name
{{ content.author.avatar }}           — Author avatar URL
{{ content.author.bio }}              — Author bio
{{ content.tag_list }}                — Tags (iterable)
{{ content.topic_list }}              — Topics (iterable)
{{ content.absolute_url }}            — Canonical URL
{{ content.meta_description }}        — Excerpt / meta description
\`\`\`

### Blog Listing Variables
\`\`\`html
{% for content in contents %}
  {{ content.name }}                  — Post title
  {{ content.absolute_url }}          — Post URL
  {{ content.featured_image }}        — Featured image
  {{ content.meta_description }}      — Excerpt
  {{ content.publish_date }}          — Date
  {{ content.blog_post_author }}      — Author
{% endfor %}

{{ group.public_title }}              — Blog name
{{ group.description }}               — Blog description
\`\`\`

### Date Formatting
\`\`\`html
{{ content.publish_date|datetimeformat('%B %d, %Y') }}
\`\`\`

### Pagination (for listing modules)
\`\`\`html
{% if last_page_num > 1 %}
  {% if current_page_num > 1 %}
    <a href="{{ blog_page_link(current_page_num - 1) }}">Previous</a>
  {% endif %}
  {% for page_num in range(1, last_page_num + 1) %}
    {% if page_num == current_page_num %}
      <span>{{ page_num }}</span>
    {% else %}
      <a href="{{ blog_page_link(page_num) }}">{{ page_num }}</a>
    {% endif %}
  {% endfor %}
  {% if current_page_num < last_page_num %}
    <a href="{{ blog_page_link(current_page_num + 1) }}">Next</a>
  {% endif %}
{% endif %}
\`\`\`

### Tag Filtering
\`\`\`html
{% set topics = blog_topics(group.id, 250) %}
{% for topic in topics %}
  <a href="{{ blog_tag_url(group.id, topic.slug) }}">{{ topic.name }}</a>
{% endfor %}
\`\`\`

### Related Posts
\`\`\`html
{% set recent = blog_recent_posts(group.id, 3) %}
{% for post in recent %}
  {% if post.absolute_url != content.absolute_url %}
    <a href="{{ post.absolute_url }}">{{ post.name }}</a>
  {% endif %}
{% endfor %}
\`\`\`

## Field Rules
- Use "type": "text" (NEVER "textarea" — it's deprecated)
- NEVER use "name": "name" (reserved) — use "item_name" instead
- NEVER use "name": "label" (reserved) — use "section_label" instead
- NEVER use "name": "body" (reserved) — use "body_text" instead
- NEVER put literal \\n in field defaults
- Wrap style fields in a "styles" group with "tab": "STYLE"
- Color fields: type "color", default { "color": "#hex", "opacity": 100 }
- Link fields: type "link", default { "url": { "href": "#", "type": "EXTERNAL" }, "open_in_new_tab": true, "no_follow": false }
- Image fields: type "image", default { "src": "https://placehold.co/800x450/1a1a2e/ffffff?text=Replace+in+HubSpot", "alt": "Placeholder", "width": 800, "height": 450 }
- For repeater groups, use "occurrence": { "min": 0, "max": 10 }

## metaJson Templates

For blog post modules:
{ "host_template_types": ["BLOG_POST"], "is_available_for_new_content": true }

For blog listing modules:
{ "host_template_types": ["BLOG_LISTING"], "is_available_for_new_content": true }

For modules usable in both:
{ "host_template_types": ["BLOG_POST", "BLOG_LISTING"], "is_available_for_new_content": true }

## Module Type Detection
Determine the correct host_template_types from the module specification:
- Modules with "listing", "grid", "archive", "index", "pagination", "topic-filter", "category" in the name/description → BLOG_LISTING
- Modules with "post-body", "post-header", "author-bio", "related-posts", "comments", "share" in the name/description → BLOG_POST
- Generic modules like "newsletter-signup", "sidebar" → both ["BLOG_POST", "BLOG_LISTING"]

## Key Patterns

### Blog Post Body Wrapper
The blog post body module wraps \`{{ content.post_body }}\` with reading-optimized styles:
\`\`\`html
<article class="${themeName}-post-body">
  <div class="${themeName}-post-body__content">
    {{ content.post_body }}
  </div>
</article>
\`\`\`

### Post Card (for listing)
\`\`\`html
{% for content in contents %}
  <article class="${themeName}-post-card">
    {% if content.featured_image %}
      <img src="{{ content.featured_image }}" alt="{{ content.featured_image_alt_text }}"
           class="${themeName}-post-card__image" loading="lazy" />
    {% endif %}
    <div class="${themeName}-post-card__content">
      <span class="${themeName}-post-card__date">
        {{ content.publish_date|datetimeformat('%B %d, %Y') }}
      </span>
      <h2 class="${themeName}-post-card__title">
        <a href="{{ content.absolute_url }}">{{ content.name }}</a>
      </h2>
      <p class="${themeName}-post-card__excerpt">{{ content.meta_description|truncate(160) }}</p>
      <span class="${themeName}-post-card__author">{{ content.blog_post_author }}</span>
    </div>
  </article>
{% endfor %}
\`\`\``);

  if (brandAssets?.themeContext) {
    parts.push(`\n\n## Product Context\n${brandAssets.themeContext}`);
  }

  if (brandAssets?.humanify !== false) {
    parts.push(`\n\n## Anti-AI Copy Rules\n${getBlogModuleDevHumanifySummary()}`);
  }

  // Add conversion guide and HubSpot rules if needed
  const guides: string[] = [];
  if (guidesNeeded?.includes("conversion")) {
    try {
      const conv = getConversionGuide();
      if (conv) guides.push(`## Conversion Guide\n${conv}`);
    } catch { /* ignore */ }
  }
  if (guidesNeeded?.includes("hubspot_rules")) {
    try {
      const rules = getHubspotRules();
      if (rules) guides.push(`## HubSpot Rules\n${rules}`);
    } catch { /* ignore */ }
  }
  if (guides.length > 0) {
    parts.push(`\n\n${guides.join("\n\n")}`);
  }

  return parts.join("");
}

/**
 * Build blog module developer prompt as blocks with cache control.
 * The blog rules reference guide is cached across parallel module calls.
 */
export function buildBlogModuleDeveloperPromptBlocks(
  themeName: string,
  sharedCss: string,
  guidesNeeded?: string[],
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string },
): SystemPromptBlock[] {
  const blocks: SystemPromptBlock[] = [];

  // Block 1: Core blog-specific instructions (varies by themeName + sharedCss)
  const core = buildBlogModuleDeveloperPrompt(themeName, sharedCss, undefined, { ...brandAssets, humanify: false });
  blocks.push({ type: "text", text: core });

  // Block 2: Blog rules reference — CACHED (identical across all blog module calls)
  let blogRules: string;
  try {
    blogRules = getBlogRules();
  } catch {
    blogRules = "";
  }
  if (blogRules) {
    blocks.push({
      type: "text",
      text: `## Blog Template Rules Reference\n${blogRules}`,
      cache_control: { type: "ephemeral" },
    });
  }

  // Block 3: Conversion guide + HubSpot rules — CACHED
  const cachedGuides: string[] = [];
  if (guidesNeeded?.includes("conversion")) {
    try {
      const conv = getConversionGuide();
      if (conv) cachedGuides.push(`## Conversion Guide\n${conv}`);
    } catch { /* ignore */ }
  }
  if (guidesNeeded?.includes("hubspot_rules")) {
    try {
      const rules = getHubspotRules();
      if (rules) cachedGuides.push(`## HubSpot Rules\n${rules}`);
    } catch { /* ignore */ }
  }
  if (cachedGuides.length > 0) {
    blocks.push({
      type: "text",
      text: cachedGuides.join("\n\n"),
      cache_control: { type: "ephemeral" },
    });
  }

  // Block 4: Dynamic content (brand assets, humanify)
  const dynamicParts: string[] = [];
  if (brandAssets?.themeContext) {
    dynamicParts.push(`## Product Context\n${brandAssets.themeContext}`);
  }
  if (brandAssets?.humanify !== false) {
    dynamicParts.push(`## Anti-AI Copy Rules\n${getBlogModuleDevHumanifySummary()}`);
  }
  if (dynamicParts.length > 0) {
    blocks.push({ type: "text", text: dynamicParts.join("\n\n") });
  }

  return blocks;
}

function getBlogModuleDevHumanifySummary(): string {
  return `### Banned Punctuation
- **Em dashes (—)**: NEVER use. Replace with periods, commas, or parentheses.
- **Semicolons**: Use periods instead.
- **Exclamation marks**: Maximum one per page. Zero ideal for B2B.

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
- Blog headlines: specific, benefit-first, no clickbait`;
}

/**
 * Build user message for a single blog module generation call.
 */
export function buildBlogModuleUserMessage(
  userMessage: string,
  spec: { name: string; description: string; contentBrief: string; layoutNotes: string },
  existingCode?: ModuleFiles,
): string {
  const parts: string[] = [];

  parts.push(`## User Request\n${userMessage}`);

  parts.push(`\n\n## Blog Module Specification
- **Name**: ${spec.name}
- **Description**: ${spec.description}
- **Content Brief**: ${spec.contentBrief}
- **Layout Notes**: ${spec.layoutNotes}

REMEMBER: This is a BLOG module. Use HubSpot blog variables where appropriate (content.post_body, content.author, content.tag_list, etc.). Set the correct host_template_types in meta.json (BLOG_POST, BLOG_LISTING, or both).`);

  if (existingCode) {
    parts.push(`\n\n## Existing Module Code (modify this)
**fields.json:**
\`\`\`json
${existingCode.fieldsJson}
\`\`\`

**module.html:**
\`\`\`html
${existingCode.moduleHtml}
\`\`\`

**module.css:**
\`\`\`css
${existingCode.moduleCss}
\`\`\``);
  }

  return parts.join("");
}

/** JSON Schema for blog module output — same shape as page modules with blog-specific meta. */
export const BLOG_MODULE_DEVELOPER_SCHEMA = {
  type: "object",
  properties: {
    moduleName: { type: "string" },
    fieldsJson: {
      type: "string",
      description: "Complete fields.json content as a JSON string",
    },
    metaJson: {
      type: "string",
      description: 'Complete meta.json content — must include host_template_types with "BLOG_POST" and/or "BLOG_LISTING"',
    },
    moduleHtml: {
      type: "string",
      description: "Complete module.html using HubSpot blog variables where appropriate",
    },
    moduleCss: {
      type: "string",
      description: "Complete module.css with reading-optimized styles",
    },
    moduleJs: {
      type: "string",
      description: "Optional module.js (vanilla JS in IIFE) or empty string",
    },
  },
  required: [
    "moduleName",
    "fieldsJson",
    "metaJson",
    "moduleHtml",
    "moduleCss",
  ],
} as const;
