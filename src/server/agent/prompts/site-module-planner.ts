/**
 * Prompt builder for Site Module Planner stage.
 *
 * Plans modules for ALL pages of a multi-page site in a single call,
 * ensuring cross-page coherence. Shared modules (header, footer) are
 * planned once and appear on every page.
 */

import type { SitePagePlan } from "../types.js";

function summarizeCss(css: string): string {
  const classNames = [...new Set(
    [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => `.${m[1]}`)
  )];
  const varNames = [...new Set(
    [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])
  )];
  const breakpoints = [...new Set(
    [...css.matchAll(/@media\s*\([^)]+\)/g)].map((m) => m[0])
  )];
  const lines: string[] = [];
  if (varNames.length > 0) lines.push(`CSS Variables: ${varNames.join(", ")}`);
  if (classNames.length > 0) lines.push(`CSS Classes: ${classNames.join(", ")}`);
  if (breakpoints.length > 0) lines.push(`Breakpoints: ${breakpoints.join(", ")}`);
  return lines.join("\n");
}

export function buildSiteModulePlannerPrompt(
  themeName: string,
  pages: SitePagePlan[],
  sharedModuleNames: string[],
  sharedCss: string,
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string },
): string {
  const cssSummary = summarizeCss(sharedCss);

  const pageList = pages
    .map((p) => `- **${p.label}** (${p.pageType}, slug: "${p.slug}"): ${p.purpose}`)
    .join("\n");

  const sharedList = sharedModuleNames
    .map((n) => `- **${n}**`)
    .join("\n");

  const parts: string[] = [];

  parts.push(`You are the Site Module Planner for vibeSpot, a HubSpot CMS page builder.

Your job: plan modules for a MULTI-PAGE website. You plan ALL pages in one pass to ensure cross-page coherence. You also plan shared modules (header, footer, navigation) that appear on every page identically.

## Theme: "${themeName}"

## Site Map
${pageList}

## Shared Modules (appear on EVERY page)
${sharedList}

Plan these shared modules ONCE. They will be automatically added to every page's template.

## Available CSS Classes & Variables
Reference these in your layoutNotes:

${cssSummary}

## Shared Module Rules

### site-header (Navigation)
- Logo on the left, nav links center or right, CTA button far right
- Nav links: one for each page in the site map. Use relative hrefs matching slugs:
${pages.map((p) => `  - "${p.label}" → href="/${p.slug}"`).join("\n")}
- Active page link uses CSS class "${themeName}-nav__link--active"
- Sticky with backdrop-blur, transitions on scroll
- Mobile: hamburger menu with slide-in nav

### site-footer
- Consistent across all pages
- Brand name, link columns (include page links), contact info, social icons, copyright
- Include navigation links matching the header

## Per-Page Module Rules
For each page, plan modules specific to that page's purpose. Do NOT include shared modules (${sharedModuleNames.join(", ")}) in per-page module lists or per-page moduleOrder — they are automatically prepended/appended.

Each page should have distinct content appropriate to its purpose. Aim for:
- 4-8 unique modules per page (not counting shared modules)
- Content appropriate to the page's purpose
- Consistent use of design system classes across all pages

## Module Naming
- Use kebab-case identifiers (e.g., "hero", "team-grid", "contact-form")
- Page-specific modules that might conflict across pages should be prefixed with a short page identifier (e.g., "home-hero", "about-hero") unless the content is genuinely different enough that the name alone distinguishes it
- Shared modules use the exact names from the shared modules list above

## Output Structure
Return a JSON object with:
- \`sharedModules\`: array of shared module specs (planned once, used everywhere)
- \`pages\`: array of per-page blueprints, each with:
  - \`pageId\`: matching the page ID from the site map
  - \`modules\`: array of module specs for that page only (excluding shared)
  - \`moduleOrder\`: ordered list of per-page module names only (excluding shared)
- \`narrative\`: brief description of the overall site story/flow`);

  if (brandAssets?.brandvoice) {
    parts.push(`\n\n## Brand Voice\n${brandAssets.brandvoice}`);
  }
  if (brandAssets?.themeContext) {
    parts.push(`\n\n## Product Context\n${brandAssets.themeContext}`);
  }

  return parts.join("");
}

export const SITE_MODULE_PLANNER_SCHEMA = {
  type: "object",
  properties: {
    sharedModules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Shared module identifier (e.g., site-header, site-footer)" },
          description: { type: "string" },
          contentBrief: { type: "string", description: "Content for this shared module" },
          layoutNotes: { type: "string", description: "Layout referencing shared CSS classes" },
        },
        required: ["name", "description", "contentBrief", "layoutNotes"],
      },
      description: "Modules shared across all pages (header, footer)",
    },
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Matches the page ID from the site map" },
          modules: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                contentBrief: { type: "string" },
                layoutNotes: { type: "string" },
              },
              required: ["name", "description", "contentBrief", "layoutNotes"],
            },
          },
          moduleOrder: {
            type: "array",
            items: { type: "string" },
            description: "Per-page module names in display order (excluding shared modules)",
          },
        },
        required: ["pageId", "modules", "moduleOrder"],
      },
    },
    narrative: {
      type: "string",
      description: "Brief description of the overall site story and how pages connect",
    },
  },
  required: ["sharedModules", "pages", "narrative"],
} as const;
