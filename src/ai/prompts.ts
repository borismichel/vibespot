import { readFile, resolveAsset } from "../utils/fs.js";

// In-memory cache for guide files (~90KB total, read once)
const guideCache = new Map<string, string>();

function cachedAsset(name: string): string {
  let val = guideCache.get(name);
  if (val !== undefined) return val;
  try { val = readFile(resolveAsset(name)); } catch { val = ""; }
  guideCache.set(name, val);
  return val;
}

export function getConversionGuide(): string {
  return cachedAsset("conversion-guide.md") || "Conversion guide not found. Using built-in rules.";
}

export function getDesignGuide(): string {
  return cachedAsset("design-guide.md");
}

export function getContentGuide(): string {
  return cachedAsset("content-guide.md");
}

export function getHubspotRules(): string {
  return cachedAsset("hubspot-rules.md");
}

export function getHumanifyGuide(): string {
  return cachedAsset("humanify-guide.md");
}

export function getEmailRules(): string {
  return cachedAsset("email-rules.md");
}

export function getBlogRules(): string {
  return cachedAsset("blog-rules.md");
}

/**
 * Extract page-type-specific section from page-types.md.
 * Returns only the relevant section for the given page type.
 */
export function getPageTypeGuide(pageType: string): string {
  const fullGuide = cachedAsset("page-types.md");
  if (!fullGuide) return "";

  // Map page type to section header
  const sectionHeaders: Record<string, string> = {
    landing_page: "## Landing Page",
    blog_post: "## Blog Post",
    website_page: "## Website Page",
    module_only: "## Module Only",
  };

  const header = sectionHeaders[pageType];
  if (!header) return "";

  const startIdx = fullGuide.indexOf(header);
  if (startIdx < 0) return "";

  // Find the next section (## at start of line) after this one
  const afterHeader = fullGuide.indexOf("\n## ", startIdx + header.length);
  const section = afterHeader >= 0
    ? fullGuide.slice(startIdx, afterHeader).trim()
    : fullGuide.slice(startIdx).trim();

  return section;
}

export function buildSystemPrompt(conversionGuide: string): string {
  return `You are a HubSpot CMS expert converting React/Tailwind pages to native HubSpot modules.

## Rules
Follow the conversion guide below EXACTLY. Key rules:
- Use "type": "text" (NEVER "textarea")
- NEVER use "name": "name" (it's reserved) — use alternatives like "item_name"
- Wrap style fields in a "styles" group with "tab": "STYLE" on the group
- All CSS classes must use a unique prefix to avoid theme conflicts
- Every dnd_section needs padding={"top":"0","bottom":"0","left":"0","right":"0"}, full_width=true
- Use template_css and template_js variables (resolved in base.html, not child templates)
- Add .body-wrapper:has(.my-page) CSS fix + JS fallback for body background
- Add scoped overrides with !important for headings, paragraphs, links to defeat theme-overrides.css
- Use IntersectionObserver for scroll animations (add .visible class)
- Convert Tailwind utilities to vanilla CSS with BEM naming
- Convert React hooks to vanilla JS (no React, no npm packages)

## HubSpot CMS Rules
${getHubspotRules()}

## Conversion Guide
${conversionGuide}`;
}

export function buildAnalyzePrompt(componentList: string): string {
  return `Analyze these React components and create a module map.

For each component, return a JSON object with:
- name: HubSpot module name (e.g., "My Hero")
- description: Brief description of the section
- hasRepeaters: true if it contains .map() or array iteration
- hasInteractivity: true if it has JS-driven behavior (carousel, accordion, etc.)

Components:
${componentList}

Return ONLY valid JSON array, no markdown fences.`;
}

export function buildModulePrompt(
  componentSource: string,
  moduleName: string,
  cssVars: string
): string {
  return `Convert this React component to a HubSpot module named "${moduleName}".

Return a JSON object with these keys:
- fieldsJson: complete fields.json content (as JSON string)
- metaJson: complete meta.json content (as JSON string)
- moduleHtml: complete module.html content (HubL template)
- moduleCss: complete module.css content (vanilla CSS)
- moduleJs: module.js content if interactive behavior needed, or null

Design system CSS variables available:
${cssVars}

React component source:
${componentSource}

Return ONLY valid JSON, no markdown fences.`;
}

export function buildCssPrompt(
  indexCss: string,
  tailwindConfig: string,
  pagePrefix: string
): string {
  return `Create a shared CSS file for a HubSpot CMS landing page.

Extract the design system from the source CSS and Tailwind config below.
Use the class prefix ".${pagePrefix}-" for all custom classes.

Requirements:
- CSS custom properties for all colors, spacing
- Page wrapper styles (.${pagePrefix}-page) with !important font/color
- .body-wrapper:has(.${pagePrefix}-page) background fix
- .body-wrapper.${pagePrefix}-page-active JS fallback
- Scoped overrides: .${pagePrefix}-page h1-h6, p, a with !important
- .dnd-section padding: 0 !important and .row-fluid max-width: 100%
- Form overrides for dark themes
- Utility classes (container, section, grid, glass)
- Scroll animation classes (.${pagePrefix}-scroll-animate / .visible)
- Mobile breakpoint at 767px
- Responsive grid fallbacks

Source CSS:
${indexCss}

Tailwind config:
${tailwindConfig}

Return ONLY the CSS content, no markdown fences.`;
}

export function buildJsPrompt(
  hooksSource: string,
  interactiveComponents: string,
  pagePrefix: string
): string {
  return `Create a shared vanilla JS file for a HubSpot CMS landing page.

Convert the React hooks and interactive components below to plain JavaScript.
Use the class prefix "${pagePrefix}-" to match the CSS.

Requirements:
- IIFE wrapper with "use strict"
- initBodyWrapper: add "${pagePrefix}-page-active" class to .body-wrapper
- initScrollAnimations: IntersectionObserver for .${pagePrefix}-scroll-animate → .visible
- Convert any carousels, accordions, typing animations to vanilla JS
- DOMContentLoaded / readyState check

React hooks source:
${hooksSource}

Interactive component sources:
${interactiveComponents}

Return ONLY the JavaScript content, no markdown fences.`;
}

export function buildTemplatePrompt(
  moduleNames: string[],
  themeName: string,
  pagePrefix: string
): string {
  return `Create a HubSpot page template that assembles these modules:

${moduleNames.map((n, i) => `${i + 1}. ${n}.module`).join("\n")}

Template requirements:
- templateType: page, isAvailableForNewContent: true
- extends "./layouts/base.html"
- set template_css = "../../css/${pagePrefix}-theme.css"
- set template_js = "../../js/${pagePrefix}-animations.js"
- Empty header and footer blocks (modules handle them)
- Wrap content in <div class="${pagePrefix}-page">
- Each module in its own dnd_section with padding zeroed and full_width=true
- dnd_area label: "${themeName} Landing Page"

Return ONLY the template HTML content, no markdown fences.`;
}
