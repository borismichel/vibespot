/**
 * Figma-to-HubSpot conversion pipeline.
 *
 * Bypasses the full agentic pipeline (Intent → Architect → Developer → QA).
 * The Figma extraction already provides the design system and module breakdown —
 * the AI's only job is to translate each section into HubL.
 *
 * Steps:
 *  1. Generate shared CSS deterministically from design tokens (no AI)
 *  2. Map FigmaSections → ModuleSpecs deterministically (no AI)
 *  3. Convert each module in parallel via callAgent() (AI: translation only)
 *  4. Validate & auto-fix via existing validator
 */

import { basename } from "node:path";
import type { ModuleFiles } from "../../ai/engine.js";
import type {
  FigmaExtraction,
  FigmaSection,
  FigmaAsset,
  FigmaDesignTokens,
  FigmaTextBlock,
} from "../figma/types.js";
import type { AgentEngine, SystemPromptBlock } from "./engine-adapter.js";
import { callAgent } from "./engine-adapter.js";
import type { PipelineEvent, PipelineResult, ModuleSpec } from "./types.js";
import { createConcurrencyLimiter } from "./types.js";
import {
  buildModuleDeveloperPrompt,
  buildModuleDeveloperPromptBlocks,
  MODULE_DEVELOPER_SCHEMA,
} from "./prompts/module-developer.js";
import { validateModules } from "./stages/validator.js";
import { log } from "../log.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runFigmaConversion(
  extraction: FigmaExtraction,
  themeName: string,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  concurrency: number,
  onEvent: (event: PipelineEvent) => void,
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string },
  useAssets?: boolean,
): Promise<PipelineResult> {
  const startTime = Date.now();

  // Step 1: Generate shared CSS from design tokens (deterministic)
  onEvent({ type: "agent_step", step: "designing", label: "Building design system from Figma tokens..." });
  const { sharedCss, sharedJs } = generateSharedCss(extraction.designTokens, themeName);
  onEvent({ type: "design_system_ready", sharedCss, sharedJs, aesthetic: "Figma import" });
  onEvent({ type: "agent_decision", step: "designing", decision: `Generated CSS variables and utility classes from ${extraction.designTokens.colors.length} colors, ${extraction.designTokens.typography.length} typography styles` });

  // Step 2: Map sections to module specs (deterministic)
  const { specs, moduleOrder } = mapSectionsToSpecs(extraction.sections, extraction.assets, themeName);
  onEvent({ type: "blueprint_ready", moduleOrder, sharedCss, sharedJs });
  onEvent({ type: "agent_decision", step: "designing", decision: `Mapped ${specs.length} Figma sections to modules: ${moduleOrder.join(", ")}` });

  // Step 3: Convert each module in parallel (AI translation)
  onEvent({ type: "agent_step", step: "developing", label: `Converting ${specs.length} modules...` });

  const isAnthropicEngine = engine === "anthropic-api" || engine === "claude-oauth";
  const systemPrompt = buildModuleDeveloperPrompt(themeName, sharedCss, ["hubspot_rules", "conversion"], brandAssets);
  const systemBlocks: SystemPromptBlock[] | undefined = isAnthropicEngine
    ? buildModuleDeveloperPromptBlocks(themeName, sharedCss, ["hubspot_rules", "conversion"], brandAssets)
    : undefined;

  const limit = createConcurrencyLimiter(concurrency);
  const total = specs.length;

  const promises = specs.map((spec, index) => {
    const section = extraction.sections[index];
    return limit(async (): Promise<{ moduleName: string; module?: ModuleFiles; error?: string }> => {
      onEvent({ type: "module_progress", module: spec.name, status: "generating", current: index + 1, total });

      const userContent = buildFigmaModuleMessage(section, spec, extraction.assets, themeName, useAssets !== false);

      let lastError = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) {
            log.warn("figma-pipeline", `${spec.name}: retrying (attempt ${attempt + 1})`);
            onEvent({ type: "module_progress", module: spec.name, status: "retrying", current: index + 1, total });
          }

          const result = await callAgent(engine, apiKey, model, {
            systemPrompt,
            systemBlocks,
            messages: [{ role: "user", content: userContent }],
            structuredOutput: {
              schema: MODULE_DEVELOPER_SCHEMA as unknown as Record<string, unknown>,
              name: "module_output",
            },
            maxTokens: 16000,
          });

          if (result.type !== "structured") {
            throw new Error("No structured output returned");
          }

          const data = result.data as Record<string, unknown>;
          const module: ModuleFiles = {
            moduleName: spec.name,
            fieldsJson: typeof data.fieldsJson === "string" ? data.fieldsJson : JSON.stringify(data.fieldsJson, null, 2),
            metaJson: typeof data.metaJson === "string" ? data.metaJson : JSON.stringify(data.metaJson, null, 2),
            moduleHtml: String(data.moduleHtml || ""),
            moduleCss: String(data.moduleCss || ""),
            moduleJs: data.moduleJs ? String(data.moduleJs) : undefined,
          };

          onEvent({ type: "module_progress", module: spec.name, status: "complete", current: index + 1, total, moduleFiles: module });
          return { moduleName: spec.name, module };
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          log.error("figma-pipeline", `Failed: ${spec.name} (attempt ${attempt + 1}): ${lastError}`);
        }
      }

      onEvent({ type: "module_progress", module: spec.name, status: "failed", current: index + 1, total });
      return { moduleName: spec.name, error: lastError };
    });
  });

  const settled = await Promise.allSettled(promises);
  const results = settled.map((r) =>
    r.status === "fulfilled" ? r.value : { moduleName: "unknown", error: String(r.reason) },
  );

  const successModules = results.filter((r) => r.module).map((r) => r.module!);
  const failedNames = results.filter((r) => r.error).map((r) => r.moduleName);

  // Step 4: Validate & auto-fix
  const validated = validateModules(successModules, themeName, onEvent);
  const finalModules = validated.map((v) => v.module);

  const durationMs = Date.now() - startTime;
  const durationSec = Math.round(durationMs / 1000);

  if (failedNames.length > 0) {
    onEvent({ type: "pipeline_partial", succeeded: finalModules.map((m) => m.moduleName), failed: failedNames, durationMs });
  } else {
    onEvent({ type: "pipeline_complete", modulesGenerated: finalModules.length, modulesUnchanged: 0, durationMs });
  }

  return {
    modules: finalModules,
    moduleOrder,
    sharedCss,
    sharedJs,
    assistantMessage: `Imported ${finalModules.length} modules from Figma design "${extraction.fileName}" in ${durationSec}s.`,
    stats: {
      modulesGenerated: finalModules.length,
      modulesUnchanged: 0,
      modulesFailed: failedNames.length,
      durationMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 1: Deterministic CSS from design tokens
// ---------------------------------------------------------------------------

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function generateSharedCss(tokens: FigmaDesignTokens, themeName: string): { sharedCss: string; sharedJs: string } {
  const vars: string[] = [];
  const t = themeName;

  // --- Colors ---
  const colors = [...tokens.colors].sort((a, b) => b.occurrences - a.occurrences);
  const bgColors = colors.filter((c) => c.usage === "background" || c.usage === "fill");
  const textColors = colors.filter((c) => c.usage === "text");

  // Auto-detect dark/light theme from most common fill color
  const primaryBg = bgColors[0] || colors[0];
  const isDark = primaryBg ? hexToHsl(primaryBg.hex).l < 0.4 : false;

  if (primaryBg) vars.push(`  --${t}-color-bg: ${primaryBg.hex}`);
  const primaryText = textColors[0] || (isDark ? colors.find((c) => hexToHsl(c.hex).l > 0.7) : colors.find((c) => hexToHsl(c.hex).l < 0.3));
  if (primaryText) vars.push(`  --${t}-color-text: ${primaryText.hex}`);

  // Primary = most-used non-bg, non-text color
  const usedHexes = new Set([primaryBg?.hex, primaryText?.hex].filter(Boolean));
  const remaining = colors.filter((c) => !usedHexes.has(c.hex));
  if (remaining[0]) { vars.push(`  --${t}-color-primary: ${remaining[0].hex}`); usedHexes.add(remaining[0].hex); }
  if (remaining[1]) { vars.push(`  --${t}-color-accent: ${remaining[1].hex}`); usedHexes.add(remaining[1].hex); }

  // Additional named colors
  const extras = remaining.filter((c) => !usedHexes.has(c.hex)).slice(0, 6);
  extras.forEach((c, i) => vars.push(`  --${t}-color-${i + 1}: ${c.hex}`));

  // Surface/border derived
  if (primaryBg) {
    const bgL = hexToHsl(primaryBg.hex).l;
    vars.push(`  --${t}-color-surface: ${isDark ? lighten(primaryBg.hex, 0.05) : darken(primaryBg.hex, 0.03)}`);
    vars.push(`  --${t}-color-border: ${isDark ? lighten(primaryBg.hex, 0.15) : darken(primaryBg.hex, 0.12)}`);
    void bgL; // used in isDark calculation
  }

  // --- Typography ---
  const headingFonts = tokens.typography.filter((t) => t.role === "heading" || t.role === "subheading");
  const bodyFonts = tokens.typography.filter((t) => t.role === "body" || t.role === "label" || t.role === "caption");
  const displayFamily = headingFonts[0]?.fontFamily || bodyFonts[0]?.fontFamily || "system-ui";
  const bodyFamily = bodyFonts[0]?.fontFamily || displayFamily;

  vars.push(`  --${t}-font-display: "${displayFamily}", system-ui, sans-serif`);
  vars.push(`  --${t}-font-body: "${bodyFamily}", system-ui, sans-serif`);

  // Size scale from actual Figma values
  const headingSizes = headingFonts.sort((a, b) => b.fontSize - a.fontSize);
  if (headingSizes[0]) vars.push(`  --${t}-size-h1: ${headingSizes[0].fontSize}px`);
  if (headingSizes[1]) vars.push(`  --${t}-size-h2: ${headingSizes[1].fontSize}px`);
  if (headingSizes[2]) vars.push(`  --${t}-size-h3: ${headingSizes[2].fontSize}px`);
  const bodySize = bodyFonts.sort((a, b) => b.occurrences - a.occurrences)[0];
  if (bodySize) vars.push(`  --${t}-size-body: ${bodySize.fontSize}px`);

  // --- Spacing ---
  const spacingValues = [...new Set(tokens.spacing.map((s) => s.value))].sort((a, b) => a - b);
  const spaceNames = ["xs", "sm", "md", "lg", "xl", "2xl", "section"];
  spacingValues.slice(0, spaceNames.length).forEach((v, i) => {
    vars.push(`  --${t}-space-${spaceNames[i]}: ${v}px`);
  });

  // --- Effects ---
  const shadows = tokens.effects.filter((e) => e.type === "shadow");
  const radii = tokens.effects.filter((e) => e.type === "radius");
  if (shadows[0]) vars.push(`  --${t}-shadow: ${shadows[0].cssValue}`);
  radii.sort((a, b) => parseFloat(a.cssValue) - parseFloat(b.cssValue));
  if (radii[0]) vars.push(`  --${t}-radius: ${radii[0].cssValue}`);
  if (radii[1]) vars.push(`  --${t}-radius-lg: ${radii[1].cssValue}`);

  // Assemble CSS
  const rootBlock = `:root {\n${vars.join(";\n")};\n}`;

  const utilityClasses = `
/* Reset */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--${t}-font-body);
  font-size: var(--${t}-size-body, 16px);
  color: var(--${t}-color-text);
  background: var(--${t}-color-bg);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

.${t}-container {
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 var(--${t}-space-md, 24px);
}

.${t}-section {
  padding: var(--${t}-space-section, 80px) 0;
}

.${t}-section--dark {
  background: var(--${t}-color-text, #1a1a2e);
  color: var(--${t}-color-bg, #ffffff);
}

.${t}-grid { display: grid; gap: var(--${t}-space-md, 24px); }
.${t}-grid--2 { grid-template-columns: repeat(2, 1fr); }
.${t}-grid--3 { grid-template-columns: repeat(3, 1fr); }
.${t}-grid--4 { grid-template-columns: repeat(4, 1fr); }

.${t}-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 28px;
  border-radius: var(--${t}-radius, 8px);
  font-family: var(--${t}-font-body);
  font-size: var(--${t}-size-body, 16px);
  font-weight: 600;
  text-decoration: none;
  border: none;
  cursor: pointer;
  transition: opacity 0.2s, transform 0.2s;
}
.${t}-btn:hover { opacity: 0.9; transform: translateY(-1px); }
.${t}-btn--primary {
  background: var(--${t}-color-primary);
  color: var(--${t}-color-bg, #fff);
}
.${t}-btn--secondary {
  background: transparent;
  border: 2px solid var(--${t}-color-primary);
  color: var(--${t}-color-primary);
}

.${t}-card {
  background: var(--${t}-color-surface, var(--${t}-color-bg));
  border: 1px solid var(--${t}-color-border, transparent);
  border-radius: var(--${t}-radius, 8px);
  padding: var(--${t}-space-md, 24px);
  transition: transform 0.2s, box-shadow 0.2s;
}
.${t}-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--${t}-shadow, 0 8px 24px rgba(0,0,0,0.1));
}

/* Responsive — tablet */
@media (max-width: 1023px) {
  .${t}-grid--3, .${t}-grid--4 { grid-template-columns: repeat(2, 1fr); }
}

/* Responsive — mobile */
@media (max-width: 767px) {
  .${t}-grid--2, .${t}-grid--3, .${t}-grid--4 { grid-template-columns: 1fr; }
  .${t}-section { padding: var(--${t}-space-lg, 48px) 0; }
  .${t}-container { padding: 0 var(--${t}-space-sm, 16px); }
  h1 { font-size: 2rem; }
  h2 { font-size: 1.5rem; }
  h3 { font-size: 1.25rem; }
}`;

  const sharedCss = rootBlock + "\n" + utilityClasses;

  const sharedJs = `(function() {
  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  document.querySelectorAll('[data-animate]').forEach(function(el) { observer.observe(el); });
})();`;

  return { sharedCss, sharedJs };
}

function lighten(hex: string, amount: number): string {
  return adjustLightness(hex, amount);
}
function darken(hex: string, amount: number): string {
  return adjustLightness(hex, -amount);
}
function adjustLightness(hex: string, amount: number): string {
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  r = Math.min(255, Math.max(0, Math.round(r + 255 * amount)));
  g = Math.min(255, Math.max(0, Math.round(g + 255 * amount)));
  b = Math.min(255, Math.max(0, Math.round(b + 255 * amount)));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Step 2: Map FigmaSections → ModuleSpecs
// ---------------------------------------------------------------------------

function toKebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .toLowerCase();
}

function mapSectionsToSpecs(
  sections: FigmaSection[],
  assets: FigmaAsset[],
  themeName: string,
): { specs: ModuleSpec[]; moduleOrder: string[] } {
  const usedNames = new Set<string>();
  const specs: ModuleSpec[] = [];

  for (const section of sections) {
    let name = toKebabCase(section.name);
    // Deduplicate
    if (usedNames.has(name)) {
      let suffix = 2;
      while (usedNames.has(`${name}-${suffix}`)) suffix++;
      name = `${name}-${suffix}`;
    }
    usedNames.add(name);

    // Build content brief from text blocks
    const contentBrief = buildContentBrief(section.textContent);

    // Build layout notes from section properties
    const layoutNotes = buildLayoutNotes(section, assets, themeName);

    // Infer description from section name and content
    const description = `Figma section "${section.name}" — ${section.width}x${section.height}px, ${section.textContent.length} text elements, ${section.children.length} children`;

    specs.push({ name, description, contentBrief, layoutNotes });
  }

  return { specs, moduleOrder: specs.map((s) => s.name) };
}

function buildContentBrief(textBlocks: FigmaTextBlock[]): string {
  const grouped: Record<string, string[]> = {};
  for (const block of textBlocks) {
    const role = block.role;
    if (!grouped[role]) grouped[role] = [];
    grouped[role].push(block.text);
  }

  const parts: string[] = [];
  const roleOrder = ["headline", "subheadline", "body", "cta", "label", "caption"];
  for (const role of roleOrder) {
    if (!grouped[role]) continue;
    for (const text of grouped[role]) {
      parts.push(`**${role}** (use as field default): "${text}"`);
    }
  }
  return parts.join("\n");
}

function buildLayoutNotes(section: FigmaSection, assets: FigmaAsset[], themeName: string): string {
  const lines: string[] = [];

  lines.push(`Dimensions: ${section.width}x${section.height}px`);
  if (section.backgroundColor) lines.push(`Background: ${section.backgroundColor}`);
  if (section.layoutMode) lines.push(`Layout: ${section.layoutMode}`);
  if (section.itemSpacing) lines.push(`Gap: ${section.itemSpacing}px`);
  if (section.paddingTop || section.paddingRight || section.paddingBottom || section.paddingLeft) {
    lines.push(`Padding: ${section.paddingTop || 0}px ${section.paddingRight || 0}px ${section.paddingBottom || 0}px ${section.paddingLeft || 0}px`);
  }

  // Children structure
  if (section.children.length > 0) {
    lines.push(`\nChildren (${section.children.length}):`);
    for (const child of section.children) {
      let desc = `  - ${child.type} "${child.name}" (${child.width}x${child.height})`;
      if (child.layoutMode) desc += ` [${child.layoutMode}]`;
      if (child.childCount > 0) desc += ` [${child.childCount} children]`;
      if (child.characters) desc += ` text: "${child.characters.slice(0, 60)}"`;
      lines.push(desc);
    }
  }

  // Available assets
  if (assets.length > 0) {
    lines.push(`\nAvailable image assets:`);
    for (const asset of assets) {
      const filename = basename(asset.localPath);
      lines.push(`  - get_asset_url("${themeName}/assets/${filename}") — ${asset.name}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Step 3: Per-module user message (translation-focused)
// ---------------------------------------------------------------------------

function buildFigmaModuleMessage(
  section: FigmaSection,
  spec: ModuleSpec,
  assets: FigmaAsset[],
  themeName: string,
  useAssets: boolean,
): string {
  const parts: string[] = [];

  parts.push(`## Figma Design Translation

TRANSLATE this Figma section into a HubSpot CMS module. This is a CONVERSION, not creation.
- Use the EXACT text content from the design as field default values
- Match the colors, spacing, and layout from the design tokens in the shared CSS
- Do NOT invent new content — every word comes from the Figma design
- Reference the shared CSS custom properties (--${themeName}-*) for all styling

### Responsive Requirements
The Figma design shows the DESKTOP layout. You MUST add responsive CSS:
- Use the shared utility classes (${themeName}-container, ${themeName}-grid, ${themeName}-section)
- Add a \`@media (max-width: 767px)\` block in moduleCss for mobile overrides:
  - Stack horizontal layouts vertically (flex-direction: column)
  - Make multi-column grids single-column
  - Reduce font sizes for headings (scale down ~20-30%)
  - Reduce section padding (roughly halve large values)
  - Make images full-width (width: 100%)
  - Hide purely decorative elements if they break mobile layout
- Add a \`@media (max-width: 1023px)\` block for tablet if the layout has 3+ columns

## Section: "${section.name}" (${section.width}x${section.height}px)`);

  if (section.backgroundColor) {
    parts.push(`Background: ${section.backgroundColor}`);
  }

  // Layout
  if (section.layoutMode || section.itemSpacing || section.paddingTop) {
    parts.push(`\n### Layout`);
    if (section.layoutMode) parts.push(`Direction: ${section.layoutMode}`);
    if (section.itemSpacing) parts.push(`Gap: ${section.itemSpacing}px`);
    if (section.paddingTop || section.paddingRight || section.paddingBottom || section.paddingLeft) {
      parts.push(`Padding: ${section.paddingTop || 0}px ${section.paddingRight || 0}px ${section.paddingBottom || 0}px ${section.paddingLeft || 0}px`);
    }
  }

  // Text content — the core of fidelity
  if (section.textContent.length > 0) {
    parts.push(`\n### Text Content — USE THESE AS FIELD DEFAULTS`);
    for (const block of section.textContent) {
      parts.push(`- **${block.role}** (${block.fontSize}px, weight ${block.fontWeight}): "${block.text}"`);
    }
  }

  // Children structure
  if (section.children.length > 0) {
    parts.push(`\n### Structure (${section.children.length} children)`);
    for (const child of section.children) {
      let desc = `- ${child.type} "${child.name}" (${child.width}x${child.height})`;
      if (child.layoutMode) desc += ` layout: ${child.layoutMode}`;
      if (child.childCount > 0) desc += `, ${child.childCount} children`;
      if (child.characters) desc += `\n  text: "${child.characters.slice(0, 100)}"`;
      parts.push(desc);
    }
  }

  // Image handling
  if (assets.length > 0) {
    if (useAssets) {
      parts.push(`\n### Available Image Assets — USE get_asset_url()`);
      parts.push(`Images are uploaded as theme assets. Reference them with get_asset_url():`);
      for (const asset of assets) {
        const filename = basename(asset.localPath);
        parts.push(`- \`get_asset_url("${themeName}/assets/${filename}")\` — ${asset.name}`);
      }
    } else {
      parts.push(`\n### Images — USE IMAGE FIELDS WITH PLACEHOLDERS`);
      parts.push(`Do NOT use get_asset_url(). Instead, create "image" type fields in fields.json for each image.`);
      parts.push(`Set a descriptive default.src (e.g. "https://placehold.co/600x400?text=Hero+Image") and default.alt text.`);
      parts.push(`In the module HTML, use: {{ module.field_name.src }} and {{ module.field_name.alt }}`);
      parts.push(`This gives content editors full control to replace images in HubSpot.`);
      for (const asset of assets) {
        parts.push(`- "${asset.name}" — create an image field for this`);
      }
    }
  }

  // Module spec summary
  parts.push(`\n## Module Specification
- **Name**: ${spec.name}
- **Description**: ${spec.description}`);

  return parts.join("\n");
}
