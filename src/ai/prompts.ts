import { readFile, resolveAsset } from "../utils/fs.js";

export function getConversionGuide(): string {
  try {
    return readFile(resolveAsset("conversion-guide.md"));
  } catch {
    return "Conversion guide not found. Using built-in rules.";
  }
}

export function getDesignGuide(): string {
  try {
    return readFile(resolveAsset("design-guide.md"));
  } catch {
    return "";
  }
}

export function getContentGuide(): string {
  try {
    return readFile(resolveAsset("content-guide.md"));
  } catch {
    return "";
  }
}

export function getHubspotRules(): string {
  try {
    return readFile(resolveAsset("hubspot-rules.md"));
  } catch {
    return "";
  }
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
