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

import { renderStagePrompt } from "./registry.js";

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

  const navHrefs = pages
    .map((p) => `  - "${p.label}" → href="/${p.slug}"`)
    .join("\n");

  parts.push(
    renderStagePrompt("site-module-planner", {
      themeName,
      siteMap: pageList,
      sharedList,
      cssSummary,
      navHrefs,
      sharedModuleNamesCsv: sharedModuleNames.join(", "),
    }),
  );

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
