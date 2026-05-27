/**
 * Prompt builder for Stage 3: Module Developer.
 * Output format rules (~2K) + conversion guide (~20K) + HubSpot rules (~20K) = ~42K tokens.
 * Design/content guides excluded — those decisions were made in Stage 2.
 */

import {
  getConversionGuide,
  getHubspotRules,
} from "../../../ai/prompts.js";
import type { ModuleFiles } from "../../../ai/engine.js";
import type { SystemPromptBlock } from "../engine-adapter.js";

import { renderStagePrompt } from "./registry.js";

export function buildModuleDeveloperPrompt(
  themeName: string,
  sharedCss: string,
  guidesNeeded?: string[],
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string },
): string {
  const parts: string[] = [];

  parts.push(renderStagePrompt("module-developer", { themeName }));

  if (sharedCss) {
    parts.push(`\n\n## Theme Shared CSS (use these custom properties)\n\`\`\`css\n${sharedCss}\n\`\`\``);
  }

  if (!guidesNeeded || guidesNeeded.includes("hubspot_rules")) {
    parts.push(`\n\n## HubSpot CMS Rules\n${getHubspotRules()}`);
  }

  if (!guidesNeeded || guidesNeeded.includes("conversion")) {
    parts.push(`\n\n## Conversion Guide\n${getConversionGuide()}`);
  }

  if (brandAssets?.themeContext) {
    parts.push(`\n\n## Product Context\n${brandAssets.themeContext}`);
  }

  if (brandAssets?.humanify !== false && guidesNeeded?.includes("humanify")) {
    parts.push(`\n\n## Anti-AI Copy Rules\n${getModuleDevHumanifySummary()}`);
  }

  return parts.join("");
}

/**
 * Build the module developer prompt as an array of blocks with cache control.
 * Static reference guides (conversion guide + HubSpot rules) are marked for caching.
 * These are identical across all parallel module generation calls in a batch.
 */
export function buildModuleDeveloperPromptBlocks(
  themeName: string,
  sharedCss: string,
  guidesNeeded?: string[],
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string },
): SystemPromptBlock[] {
  const blocks: SystemPromptBlock[] = [];

  // Block 1: Core instructions (varies by themeName + sharedCss)
  let core = buildModuleDeveloperPrompt(themeName, "", [], brandAssets ? { ...brandAssets, humanify: false } : undefined);
  if (sharedCss) {
    core += `\n\n## Theme Shared CSS (use these custom properties)\n\`\`\`css\n${sharedCss}\n\`\`\``;
  }
  blocks.push({ type: "text", text: core });

  // Block 2: Reference guides — CACHED (identical across all module calls)
  const guideParts: string[] = [];
  if (!guidesNeeded || guidesNeeded.includes("hubspot_rules")) {
    guideParts.push(`## HubSpot CMS Rules\n${getHubspotRules()}`);
  }
  if (!guidesNeeded || guidesNeeded.includes("conversion")) {
    guideParts.push(`## Conversion Guide\n${getConversionGuide()}`);
  }
  if (guideParts.length > 0) {
    blocks.push({ type: "text", text: guideParts.join("\n\n"), cache_control: { type: "ephemeral" } });
  }

  // Block 3: Dynamic content (brand assets, humanify)
  const dynamicParts: string[] = [];
  if (brandAssets?.themeContext) {
    dynamicParts.push(`## Product Context\n${brandAssets.themeContext}`);
  }
  if (brandAssets?.humanify !== false && guidesNeeded?.includes("humanify")) {
    dynamicParts.push(`## Anti-AI Copy Rules\n${getModuleDevHumanifySummary()}`);
  }
  if (dynamicParts.length > 0) {
    blocks.push({ type: "text", text: dynamicParts.join("\n\n") });
  }

  return blocks;
}

/**
 * Condensed humanify guide for Stage 3 (~2K chars).
 * Keeps: banned punctuation, full banned word list, banned openers/closers/structures,
 * positive rules, testimonial rules. Drops: full examples, explanations, sniff test.
 */
function getModuleDevHumanifySummary(): string {
  return `### Banned Punctuation
- **Em dashes (—)**: NEVER use. Replace with periods, commas, or parentheses. Hyphens for compounds fine.
- **Semicolons**: Use periods instead in marketing copy.
- **Exclamation marks**: One per page max. Zero ideal for B2B.

### Banned Words
**HARD BANNED:**
delve, tapestry, multifaceted, utilize, harness, bolster, underscore, illuminate, facilitate, fostering, garner, pivotal, commence, endeavor, myriad, plethora, pertinent, aforementioned, wherein, henceforth, beacon, synergy, paradigm, bespoke, holistic, spearhead, embark, reimagine, cultivate, cornerstone

**SOFT BANNED (rewrite unless truly earned):**
seamless, cutting-edge, groundbreaking, game-changer, revolutionary, transformative, innovative, robust, comprehensive, foundational, nuanced, landscape (abstract), realm, catalyst, empower, elevate, unlock, streamline, optimize, curated, navigate (abstract)

### Banned Openers
Never start a heading or paragraph with: "In today's", "In an era", "In the realm", "Whether you're", "Are you tired", "Imagine a world", "Picture this", "Here's the thing", "Let's face it", "Look no further", "Say goodbye to", "Gone are the days", "It's no secret", "At its core", "At the end of the day", "When it comes to"

### Banned Closers
Never end with: "The future of [X] is here", "Your journey starts here", "Join the revolution", "Experience the difference", "See what's possible", "Ready to take the next step"

### Banned Structures
- "It's not about X, it's about Y" — just state Y
- "It's not just X, it's Y" — just state Y
- "[X]. Here's why." / "[X]. And it matters."
- "Despite the challenges"
- Tricolon abuse ("Fast, reliable, revolutionary") — max once per page

### Positive Writing Rules
- Be concrete: "42 minutes" not "fast", "€29/month" not "affordable", "2,847 teams" not "thousands"
- Use plain words: use > utilize, start > commence, help > facilitate, enough > sufficient
- Vary sentence length: mix 3-word, 12-word, and 25-word sentences
- Front-load the benefit in the first 5 words
- Write like you'd say it in a bar. If you wouldn't say it holding a beer, rewrite it.
- One adjective per noun max. Zero is often better.

### Testimonial Rules
- Include a specific problem that was solved
- Include a concrete detail (time saved, money saved, specific task)
- Keep slightly imperfect (fragments OK, mild hedging like "honestly didn't think")
- Full names, specific roles (not "John D., CEO")
- Never start with "This product is..." — start with the person's situation
- Vary length and voice across testimonials`;
}

/**
 * Build the user message for a single module generation call.
 */
export function buildModuleUserMessage(
  userMessage: string,
  spec: { name: string; description: string; contentBrief: string; layoutNotes: string },
  existingCode?: ModuleFiles,
): string {
  const parts: string[] = [];

  parts.push(`## User Request\n${userMessage}`);

  parts.push(`\n\n## Module Specification
- **Name**: ${spec.name}
- **Description**: ${spec.description}
- **Content Brief**: ${spec.contentBrief}
- **Layout Notes**: ${spec.layoutNotes}`);

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

    if (existingCode.moduleJs) {
      parts.push(`\n**module.js:**
\`\`\`js
${existingCode.moduleJs}
\`\`\``);
    }
  }

  return parts.join("");
}

/** JSON Schema for a single ModuleFiles (used for structured output). */
export const MODULE_DEVELOPER_SCHEMA = {
  type: "object",
  properties: {
    moduleName: { type: "string" },
    fieldsJson: {
      type: "string",
      description: "Complete fields.json content as a JSON string",
    },
    metaJson: {
      type: "string",
      description: "Complete meta.json content as a JSON string",
    },
    moduleHtml: {
      type: "string",
      description: "Complete module.html HubL template content",
    },
    moduleCss: {
      type: "string",
      description: "Complete module.css vanilla CSS content",
    },
    moduleJs: {
      type: "string",
      description: "Optional module.js vanilla JS content, or empty string if not needed",
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
