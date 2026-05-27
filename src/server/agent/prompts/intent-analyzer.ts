/**
 * Prompt builder for Stage 1: Intent Analyzer.
 * ~1.5K tokens — intent classification rules only. No guides.
 */

import { renderStagePrompt } from "./registry.js";

export function buildIntentAnalyzerPrompt(
  themeName: string,
  moduleNames: string[],
  libraryModuleNames: { name: string; usedIn: string[] }[],
  themeContext?: string,
  siteContext?: { activePageLabel?: string; pages?: { id: string; label: string; moduleCount: number }[] },
): string {
  const moduleList =
    moduleNames.length > 0
      ? `Current template modules (in page order):\n${moduleNames.map((n, i) => `${i + 1}. ${n}`).join("\n")}`
      : "No modules yet (new page).";

  const libraryList =
    libraryModuleNames.length > 0
      ? `\n\nModule library (reusable from other templates):\n${libraryModuleNames.map((m) => `- ${m.name} (used in: ${m.usedIn.join(", ")})`).join("\n")}`
      : "";

  const contextSection = themeContext
    ? `\n\n## Product Context\n${themeContext}`
    : "";

  const siteSection = siteContext?.pages && siteContext.pages.length > 1
    ? `\n\n## Multi-Page Site Context\nThis is a multi-page site. Currently editing: **${siteContext.activePageLabel || "unknown"}**\nAll pages:\n${siteContext.pages.map((p) => `- ${p.label} (${p.id}, ${p.moduleCount} modules)`).join("\n")}\n\nThe user's message applies to the current page unless they reference another page by name or say "all pages" / "every page" / "the whole site".`
    : "";

  const contextData = `${moduleList}${libraryList}${contextSection}${siteSection}`;

  return renderStagePrompt("intent-analyzer", { themeName, contextData });
}

/** JSON Schema for PipelinePlan (used for structured output). */
export const INTENT_ANALYZER_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: [
        "create",
        "create_site",
        "modify",
        "add",
        "remove",
        "rearrange",
        "style_change",
        "question",
      ],
    },
    contentType: {
      type: "string",
      enum: ["page", "email", "blog"],
      description: 'Content type: "page" (default), "email" for email templates, or "blog" for blog templates',
    },
    affectedModules: {
      type: "array",
      items: { type: "string" },
      description: "Names of existing modules that need changes",
    },
    unchangedModules: {
      type: "array",
      items: { type: "string" },
      description: "Names of existing modules that stay as-is",
    },
    newModules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          position: { type: "number" },
        },
        required: ["name", "description", "position"],
      },
      description: "New modules to create",
    },
    reuseModules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          sourceTemplate: { type: "string" },
          position: { type: "number" },
        },
        required: ["name", "sourceTemplate", "position"],
      },
      description: "Modules to copy from the library (immutable structure)",
    },
    guidesNeeded: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "design",
          "content",
          "conversion",
          "hubspot_rules",
          "humanify",
        ],
      },
    },
    designSystemChanges: {
      type: "boolean",
      description: "True if shared CSS / design system needs regeneration",
    },
    answer: {
      type: "string",
      description:
        'For "question" intent only — the answer to return directly',
    },
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Kebab-case page ID (e.g. wp-home)" },
          label: { type: "string", description: "Human-readable page name" },
          pageType: { type: "string", enum: ["landing_page", "website_page", "blog_post"] },
          purpose: { type: "string", description: "One-sentence page purpose" },
          slug: { type: "string", description: "URL path without leading /" },
        },
        required: ["id", "label", "pageType", "purpose", "slug"],
      },
      description: 'For "create_site" intent — list of pages to generate',
    },
    sharedModules: {
      type: "array",
      items: { type: "string" },
      description: 'For "create_site" intent — module names shared across all pages (e.g. site-header, site-footer)',
    },
  },
  required: [
    "intent",
    "affectedModules",
    "unchangedModules",
    "newModules",
    "guidesNeeded",
    "designSystemChanges",
  ],
} as const;
