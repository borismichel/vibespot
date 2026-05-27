/**
 * Shared fixtures for the stage-prompt golden snapshot test (VIB-1769).
 *
 * These representative inputs exercise the dynamic interpolation paths of every
 * managed stage-instruction prompt builder. The golden test renders each case
 * and asserts byte-identical output against committed snapshots — this guards
 * the Langfuse-prompt-management refactor (registry + bundle) against drift.
 */

import type { SitePagePlan } from "../src/server/agent/types.js";

export const SHARED_CSS = `:root {
  --acme-color-bg: #ffffff;
  --acme-color-primary: #1a1a2e;
  --acme-space-section: clamp(4rem, 8vw, 8rem);
}
.acme-container { max-width: 1200px; margin: 0 auto; }
.acme-section { padding: var(--acme-space-section) 0; }
.acme-section--dark { background: var(--acme-color-primary); }
.acme-grid { display: grid; gap: 1.5rem; }
.acme-grid--3 { grid-template-columns: repeat(3, 1fr); }
.acme-btn { display: inline-flex; }
.acme-btn--primary { background: var(--acme-color-primary); }
@media (max-width: 767px) { .acme-grid--3 { grid-template-columns: 1fr; } }`;

export const PAGES: SitePagePlan[] = [
  { id: "wp-home", label: "Home", pageType: "website_page", purpose: "Introduce the product.", slug: "" },
  { id: "wp-about", label: "About", pageType: "website_page", purpose: "Tell the company story.", slug: "about" },
  { id: "wp-contact", label: "Contact", pageType: "website_page", purpose: "Let visitors reach us.", slug: "contact" },
];

export const BRAND_ASSETS = {
  styleguide: "Primary brand color is deep indigo. Use generous whitespace.",
  brandvoice: "Confident, plain-spoken, never hypey.",
  themeContext: "Acme sells time-tracking software for agencies.",
  humanify: true,
  brandKit: {
    colors: { primary: "#1a1a2e", secondary: "#16213e", accent: "#e94560" },
    fonts: { heading: "Georgia", body: "system-ui" },
    logoUrl: "https://example.com/logo.svg",
  },
};

/**
 * Each case is { id, label, render } where render() returns the prompt string.
 * The golden test imports the builders lazily so this file stays builder-agnostic.
 */
export type GoldenCase = { id: string; render: () => string };

export function buildGoldenCases(b: {
  buildIntentAnalyzerPrompt: typeof import("../src/server/agent/prompts/intent-analyzer.js").buildIntentAnalyzerPrompt;
  buildDesignSystemPrompt: typeof import("../src/server/agent/prompts/page-architect.js").buildDesignSystemPrompt;
  buildModulePlannerPrompt: typeof import("../src/server/agent/prompts/page-architect.js").buildModulePlannerPrompt;
  buildSiteModulePlannerPrompt: typeof import("../src/server/agent/prompts/site-module-planner.js").buildSiteModulePlannerPrompt;
  buildModuleDeveloperPrompt: typeof import("../src/server/agent/prompts/module-developer.js").buildModuleDeveloperPrompt;
}): GoldenCase[] {
  return [
    {
      id: "intent-analyzer/minimal",
      render: () => b.buildIntentAnalyzerPrompt("acme", [], []),
    },
    {
      id: "intent-analyzer/full",
      render: () =>
        b.buildIntentAnalyzerPrompt(
          "acme",
          ["hero", "pricing"],
          [{ name: "trust-bar", usedIn: ["home"] }],
          "Acme sells time-tracking software.",
          {
            activePageLabel: "Home",
            pages: [
              { id: "wp-home", label: "Home", moduleCount: 5 },
              { id: "wp-about", label: "About", moduleCount: 3 },
            ],
          },
        ),
    },
    {
      id: "design-system/no-brand",
      render: () => b.buildDesignSystemPrompt("acme"),
    },
    {
      id: "design-system/brandkit",
      render: () => b.buildDesignSystemPrompt("acme", BRAND_ASSETS),
    },
    {
      id: "module-planner/minimal",
      render: () => b.buildModulePlannerPrompt("acme", SHARED_CSS),
    },
    {
      id: "module-planner/full",
      render: () =>
        b.buildModulePlannerPrompt("acme", SHARED_CSS, BRAND_ASSETS, ["content", "humanify"]),
    },
    {
      id: "site-module-planner/full",
      render: () =>
        b.buildSiteModulePlannerPrompt(
          "acme",
          PAGES,
          ["site-header", "site-footer"],
          SHARED_CSS,
          BRAND_ASSETS,
        ),
    },
    {
      id: "module-developer/minimal",
      render: () => b.buildModuleDeveloperPrompt("acme", ""),
    },
    {
      id: "module-developer/full",
      render: () =>
        b.buildModuleDeveloperPrompt("acme", SHARED_CSS, ["hubspot_rules", "conversion", "humanify"], BRAND_ASSETS),
    },
  ];
}
