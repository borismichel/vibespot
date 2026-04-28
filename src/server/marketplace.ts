/**
 * HubSpot Marketplace publication path.
 *
 * Two pieces:
 *   - Validator: rule-based audit of a generated theme against Marketplace
 *     submission requirements. Produces a structured report grouped by
 *     severity (error / warning / info) with optional fix suggestions.
 *   - Listing metadata: read/write a `marketplace.json` sidecar capturing
 *     listing fields the submitter provides (category, description, etc.).
 *
 * HubSpot reviews the actual submission via their portal — vibeSpot only
 * gets the theme into a state that should pass that review.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readFile, writeFile, fileExists } from "../utils/fs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning" | "info";

export interface MarketplaceFinding {
  severity: Severity;
  /** Stable rule id, e.g. "theme.json.label.missing". */
  rule: string;
  /** Path of the file the finding refers to, relative to the theme. */
  file?: string;
  /** Short, human-readable message. */
  message: string;
  /** Actionable suggestion shown to the user. */
  fix?: string;
  /** Optional auto-fix hint that the UI/CLI can offer. */
  autoFixable?: boolean;
}

export interface MarketplaceReport {
  themePath: string;
  passed: boolean;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  findings: MarketplaceFinding[];
  metadata: MarketplaceMetadata | null;
}

export interface MarketplaceMetadata {
  category?: string;
  description?: string;
  features?: string[];
  supportUrl?: string;
  documentationUrl?: string;
  pricingTier?: "free" | "paid";
  tags?: string[];
}

/** HubSpot Marketplace top-level theme categories (as of writing). */
export const MARKETPLACE_CATEGORIES = [
  "Business Services",
  "Education",
  "Events",
  "Health & Wellness",
  "Hospitality",
  "Marketing & SEO",
  "Non-profit",
  "Portfolio",
  "Real Estate",
  "Restaurant & Food",
  "Retail & E-commerce",
  "SaaS & Technology",
  "Travel",
  "Other",
];

// HubSpot Marketplace requires the following top-level theme.json fields. See
// https://developers.hubspot.com/docs/cms/marketplace/theme-requirements#theme-configuration-themejson
const THEME_JSON_REQUIRED: string[] = [
  "label",
  "preview_path",
  "screenshot_path",
  "version",
  "documentation_url",
  "license",
  "example_url",
];

// Boolean fields that must be declared (presence is required even if false).
const THEME_JSON_REQUIRED_BOOLEANS: string[] = [
  "enable_domain_stylesheets",
  "is_available_for_new_content",
];

// ---------------------------------------------------------------------------
// Listing metadata (marketplace.json)
// ---------------------------------------------------------------------------

const METADATA_FILENAME = "marketplace.json";

export function readMarketplaceMeta(themePath: string): MarketplaceMetadata | null {
  const file = join(themePath, METADATA_FILENAME);
  if (!fileExists(file)) return null;
  try {
    const data = JSON.parse(readFile(file)) as MarketplaceMetadata;
    return data;
  } catch {
    return null;
  }
}

export function writeMarketplaceMeta(themePath: string, meta: MarketplaceMetadata): void {
  const file = join(themePath, METADATA_FILENAME);
  writeFile(file, JSON.stringify(meta, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export function validateMarketplace(themePath: string): MarketplaceReport {
  const findings: MarketplaceFinding[] = [];

  if (!fileExists(themePath)) {
    findings.push({
      severity: "error",
      rule: "theme.path.missing",
      message: `Theme directory not found: ${themePath}`,
    });
    return finalize(themePath, findings, null);
  }

  const themeJson = readJsonSafe(join(themePath, "theme.json"));
  if (!themeJson) {
    findings.push({
      severity: "error",
      rule: "theme.json.missing",
      file: "theme.json",
      message: "theme.json is missing or invalid JSON",
      fix: "Recreate the theme so theme.json is generated, or restore it from version control.",
    });
    return finalize(themePath, findings, readMarketplaceMeta(themePath));
  }

  validateThemeJson(themePath, themeJson, findings);
  validateScreenshot(themePath, themeJson, findings);
  validateModules(themePath, findings);
  validateNoCdnImports(themePath, findings);
  validateNoHardcodedPortal(themePath, findings);
  validateAccessibility(themePath, findings);

  const metadata = readMarketplaceMeta(themePath);
  validateListingMetadata(metadata, findings);

  return finalize(themePath, findings, metadata);
}

function finalize(
  themePath: string,
  findings: MarketplaceFinding[],
  metadata: MarketplaceMetadata | null,
): MarketplaceReport {
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const infoCount = findings.filter((f) => f.severity === "info").length;
  return {
    themePath,
    passed: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    findings,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

function validateThemeJson(
  themePath: string,
  theme: Record<string, unknown>,
  findings: MarketplaceFinding[],
): void {
  const requiredHints: Record<string, string> = {
    documentation_url: 'Add a "documentation_url" entry pointing to public docs for the theme.',
    license: 'Add a "license" entry — an SPDX identifier or URL (e.g. "MIT").',
    example_url: 'Add an "example_url" entry pointing to a public live preview of the theme.',
  };
  for (const field of THEME_JSON_REQUIRED) {
    if (!hasNonEmpty(theme, field)) {
      findings.push({
        severity: "error",
        rule: `theme.json.${field}.missing`,
        file: "theme.json",
        message: `theme.json is missing required field "${field}"`,
        fix: requiredHints[field] ?? `Add a "${field}" entry to theme.json.`,
      });
    }
  }

  for (const field of THEME_JSON_REQUIRED_BOOLEANS) {
    if (!(field in theme) || typeof theme[field] !== "boolean") {
      findings.push({
        severity: "error",
        rule: `theme.json.${field}.missing`,
        file: "theme.json",
        message: `theme.json must declare boolean "${field}"`,
        fix: `Add "${field}": true (or false) to theme.json.`,
      });
    }
  }

  // author block: HubSpot Marketplace requires author with name, email, and url.
  const author = theme.author as Record<string, unknown> | undefined;
  if (!author || typeof author !== "object") {
    findings.push({
      severity: "error",
      rule: "theme.json.author.missing",
      file: "theme.json",
      message: 'theme.json is missing required "author" block',
      fix: 'Add { "author": { "name": "...", "email": "...", "url": "..." } } to theme.json.',
    });
  } else {
    if (!hasNonEmpty(author, "name")) {
      findings.push({
        severity: "error",
        rule: "theme.json.author.name.missing",
        file: "theme.json",
        message: "theme.json author.name is missing",
        fix: "Provide a publisher name in theme.json author.name.",
      });
    }
    if (!hasNonEmpty(author, "email")) {
      findings.push({
        severity: "error",
        rule: "theme.json.author.email.missing",
        file: "theme.json",
        message: "theme.json author.email is missing",
        fix: "Provide a contact email in theme.json author.email.",
      });
    }
    if (!hasNonEmpty(author, "url")) {
      findings.push({
        severity: "error",
        rule: "theme.json.author.url.missing",
        file: "theme.json",
        message: "theme.json author.url is missing",
        fix: "Add a public URL for the publisher (homepage or support page).",
      });
    }
  }

  // preview_path should reference an existing template
  const preview = theme.preview_path;
  if (typeof preview === "string" && preview.length > 0) {
    const previewFs = resolveThemeRelative(themePath, preview);
    if (!fileExists(previewFs)) {
      findings.push({
        severity: "error",
        rule: "theme.json.preview_path.invalid",
        file: "theme.json",
        message: `preview_path "${preview}" does not point to an existing file`,
        fix: "Update preview_path to a real template, e.g. ./templates/home.html.",
      });
    }
  }
}

function validateScreenshot(
  themePath: string,
  theme: Record<string, unknown>,
  findings: MarketplaceFinding[],
): void {
  const shotPath = theme.screenshot_path;
  if (typeof shotPath !== "string" || shotPath.length === 0) return;
  const fs = resolveThemeRelative(themePath, shotPath);
  if (!fileExists(fs)) {
    findings.push({
      severity: "error",
      rule: "theme.json.screenshot.missing",
      file: "theme.json",
      message: `Screenshot not found at ${shotPath}`,
      fix: "Place a 1500×1000 PNG at the screenshot_path declared in theme.json.",
    });
    return;
  }
  // Light heuristic — verify it is a PNG by extension. HubSpot recommends PNG/JPG at 1500×1000.
  if (!/\.(png|jpg|jpeg)$/i.test(shotPath)) {
    findings.push({
      severity: "warning",
      rule: "theme.json.screenshot.format",
      file: shotPath,
      message: "Screenshot should be a PNG or JPG",
      fix: "Re-export the screenshot as PNG (1500×1000) or JPG.",
    });
  }
}

function validateModules(themePath: string, findings: MarketplaceFinding[]): void {
  const modulesDir = join(themePath, "modules");
  if (!fileExists(modulesDir)) {
    findings.push({
      severity: "warning",
      rule: "modules.empty",
      message: "Theme has no modules/ directory",
      fix: "Generate at least one module before submitting to Marketplace.",
    });
    return;
  }

  let moduleCount = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(modulesDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".module")) continue;
    moduleCount++;
    const modulePath = join(modulesDir, entry);
    validateSingleModule(themePath, modulePath, entry, findings);
  }

  if (moduleCount === 0) {
    findings.push({
      severity: "warning",
      rule: "modules.empty",
      message: "Theme has no .module directories",
      fix: "Generate at least one module before submitting to Marketplace.",
    });
  }
}

function validateSingleModule(
  themePath: string,
  modulePath: string,
  moduleName: string,
  findings: MarketplaceFinding[],
): void {
  const meta = readJsonSafe(join(modulePath, "meta.json"));
  const metaFile = relativeToTheme(themePath, join(modulePath, "meta.json"));
  if (!meta) {
    findings.push({
      severity: "error",
      rule: "module.meta.missing",
      file: metaFile,
      message: `${moduleName}: meta.json is missing or invalid`,
      fix: "Recreate the module so meta.json is generated.",
    });
  } else {
    if (!hasNonEmpty(meta, "label")) {
      findings.push({
        severity: "error",
        rule: "module.meta.label.missing",
        file: metaFile,
        message: `${moduleName}: meta.json is missing "label"`,
        fix: 'Add a "label" entry to the module\'s meta.json.',
        autoFixable: true,
      });
    }
    if (meta.is_available_for_new_content === false) {
      findings.push({
        severity: "info",
        rule: "module.meta.unavailable",
        file: metaFile,
        message: `${moduleName}: is_available_for_new_content=false (won’t be selectable in HubSpot UI)`,
      });
    }
  }

  // fields.json — every field needs label, recommend help_text.
  const fieldsPath = join(modulePath, "fields.json");
  const fieldsFile = relativeToTheme(themePath, fieldsPath);
  if (!fileExists(fieldsPath)) {
    findings.push({
      severity: "warning",
      rule: "module.fields.missing",
      file: fieldsFile,
      message: `${moduleName}: fields.json is missing`,
      fix: "Add a fields.json (an empty array [] is acceptable for static modules).",
    });
  } else {
    const fields = readJsonSafe(fieldsPath);
    if (!Array.isArray(fields)) {
      findings.push({
        severity: "warning",
        rule: "module.fields.invalid",
        file: fieldsFile,
        message: `${moduleName}: fields.json is not a JSON array`,
      });
    } else {
      validateFieldsRecursive(fields, moduleName, fieldsFile, findings);
    }
  }

  // module.html should contain at least one element
  const htmlPath = join(modulePath, "module.html");
  if (!fileExists(htmlPath)) {
    findings.push({
      severity: "error",
      rule: "module.html.missing",
      file: relativeToTheme(themePath, htmlPath),
      message: `${moduleName}: module.html is missing`,
      fix: "Recreate the module so module.html is generated.",
    });
  }
}

function validateFieldsRecursive(
  fields: unknown[],
  moduleName: string,
  fieldsFile: string,
  findings: MarketplaceFinding[],
): void {
  for (const field of fields) {
    if (typeof field !== "object" || field === null) continue;
    const f = field as Record<string, unknown>;
    const fieldName = typeof f.name === "string" ? f.name : "(unnamed)";

    if (!hasNonEmpty(f, "label")) {
      findings.push({
        severity: "error",
        rule: "module.field.label.missing",
        file: fieldsFile,
        message: `${moduleName}.${fieldName}: field is missing "label"`,
        fix: `Add a human-readable "label" to the "${fieldName}" field in fields.json.`,
        autoFixable: true,
      });
    }
    if (!hasNonEmpty(f, "help_text") && f.type !== "group") {
      findings.push({
        severity: "info",
        rule: "module.field.help_text.missing",
        file: fieldsFile,
        message: `${moduleName}.${fieldName}: consider adding "help_text"`,
        fix: `Add a short "help_text" describing what "${fieldName}" controls.`,
      });
    }

    if (Array.isArray(f.children)) {
      validateFieldsRecursive(f.children as unknown[], moduleName, fieldsFile, findings);
    }
  }
}

function validateNoCdnImports(themePath: string, findings: MarketplaceFinding[]): void {
  const offenders: { file: string; match: string }[] = [];

  // CSS files: shared and per-module
  const cssDir = join(themePath, "css");
  scanDirShallow(cssDir, ".css").forEach((file) => {
    findCdnImportsIn(file, offenders, themePath);
  });

  const modulesDir = join(themePath, "modules");
  if (fileExists(modulesDir)) {
    for (const entry of readdirSafe(modulesDir)) {
      if (!entry.endsWith(".module")) continue;
      const modulePath = join(modulesDir, entry);
      ["module.css", "module.html"].forEach((name) => {
        const file = join(modulePath, name);
        if (fileExists(file)) findCdnImportsIn(file, offenders, themePath);
      });
    }
  }

  for (const o of offenders) {
    findings.push({
      severity: "error",
      rule: "asset.cdn-import",
      file: o.file,
      message: `External CDN reference found: ${o.match}`,
      fix: "Remove external @import / <link> URLs and bundle the asset locally.",
      autoFixable: true,
    });
  }
}

function findCdnImportsIn(
  file: string,
  offenders: { file: string; match: string }[],
  themePath: string,
): void {
  let content: string;
  try {
    content = readFile(file);
  } catch {
    return;
  }
  const cssImport = content.match(/@import\s+url\(['"]?https?:\/\/[^)\s'"]+['"]?\)/i);
  if (cssImport) offenders.push({ file: relativeToTheme(themePath, file), match: cssImport[0] });
  const linkTag = content.match(/<link[^>]+href=['"]https?:\/\/[^'"]+['"][^>]*>/i);
  if (linkTag) offenders.push({ file: relativeToTheme(themePath, file), match: linkTag[0] });
  const scriptTag = content.match(/<script[^>]+src=['"]https?:\/\/[^'"]+['"][^>]*>/i);
  if (scriptTag) offenders.push({ file: relativeToTheme(themePath, file), match: scriptTag[0] });
}

function validateNoHardcodedPortal(themePath: string, findings: MarketplaceFinding[]): void {
  // Look for HubSpot-specific portal-bound URLs, hard-coded portal IDs, or hardcoded page IDs.
  const patterns: { rule: string; re: RegExp; message: string }[] = [
    {
      rule: "asset.hardcoded.hubfs",
      re: /https?:\/\/[\w.-]*hubfs[\w.-]*\/(\d+)\//i,
      message: "Hardcoded portal-specific HubFS URL detected",
    },
    {
      rule: "asset.hardcoded.usercontent",
      re: /hubspotusercontent[-\w]*\.net\/(\w+\/)?(\d+)\//i,
      message: "Hardcoded portal-specific HubSpot user-content URL detected",
    },
    {
      rule: "asset.hardcoded.preview",
      re: /\d+\.hs-sites\.com|hubspotpagebuilder\.com\/\d+/i,
      message: "Hardcoded portal preview URL detected",
    },
  ];

  const filesToScan: string[] = [];
  const cssDir = join(themePath, "css");
  scanDirShallow(cssDir, ".css").forEach((f) => filesToScan.push(f));
  const jsDir = join(themePath, "js");
  scanDirShallow(jsDir, ".js").forEach((f) => filesToScan.push(f));
  const modulesDir = join(themePath, "modules");
  if (fileExists(modulesDir)) {
    for (const entry of readdirSafe(modulesDir)) {
      if (!entry.endsWith(".module")) continue;
      ["module.html", "module.css", "module.js"].forEach((name) => {
        const file = join(modulesDir, entry, name);
        if (fileExists(file)) filesToScan.push(file);
      });
    }
  }

  for (const file of filesToScan) {
    let content: string;
    try { content = readFile(file); } catch { continue; }
    for (const p of patterns) {
      const m = content.match(p.re);
      if (m) {
        findings.push({
          severity: "error",
          rule: p.rule,
          file: relativeToTheme(themePath, file),
          message: `${p.message}: ${m[0]}`,
          fix: "Replace portal-specific URLs with theme-relative paths or HubSpot tokens like get_asset_url.",
        });
      }
    }
  }
}

function validateAccessibility(themePath: string, findings: MarketplaceFinding[]): void {
  const modulesDir = join(themePath, "modules");
  if (!fileExists(modulesDir)) return;

  for (const entry of readdirSafe(modulesDir)) {
    if (!entry.endsWith(".module")) continue;
    const htmlPath = join(modulesDir, entry, "module.html");
    if (!fileExists(htmlPath)) continue;
    let html: string;
    try { html = readFile(htmlPath); } catch { continue; }

    // <img> tags without alt= attribute.
    const imgRe = /<img\b([^>]*)>/gi;
    let match: RegExpExecArray | null;
    while ((match = imgRe.exec(html))) {
      const attrs = match[1];
      if (!/\balt\s*=/.test(attrs)) {
        findings.push({
          severity: "warning",
          rule: "a11y.img.alt-missing",
          file: relativeToTheme(themePath, htmlPath),
          message: `${entry}: <img> without alt attribute`,
          fix: 'Add an alt attribute (alt="" is fine for purely decorative images).',
        });
      }
    }

    // No semantic landmarks at all is a soft warning.
    const hasSemanticTag = /<(section|article|header|footer|main|nav|aside|h[1-6])\b/i.test(html);
    if (!hasSemanticTag) {
      findings.push({
        severity: "info",
        rule: "a11y.semantics.missing",
        file: relativeToTheme(themePath, htmlPath),
        message: `${entry}: module.html has no semantic landmarks (section/article/header/etc.)`,
        fix: "Wrap the module's main content in a <section> with a heading.",
      });
    }
  }
}

function validateListingMetadata(
  meta: MarketplaceMetadata | null,
  findings: MarketplaceFinding[],
): void {
  if (!meta) {
    findings.push({
      severity: "warning",
      rule: "marketplace.json.missing",
      file: METADATA_FILENAME,
      message: "marketplace.json sidecar not found",
      fix: "Run `vibespot marketplace edit` (CLI) or open the Marketplace panel in the editor to fill in listing details.",
    });
    return;
  }
  if (!meta.category) {
    findings.push({
      severity: "warning",
      rule: "marketplace.json.category.missing",
      file: METADATA_FILENAME,
      message: "marketplace.json has no category",
      fix: `Pick one of: ${MARKETPLACE_CATEGORIES.join(", ")}.`,
    });
  } else if (!MARKETPLACE_CATEGORIES.includes(meta.category)) {
    findings.push({
      severity: "warning",
      rule: "marketplace.json.category.unknown",
      file: METADATA_FILENAME,
      message: `marketplace.json category "${meta.category}" is not a recognized HubSpot Marketplace category`,
      fix: `Use one of: ${MARKETPLACE_CATEGORIES.join(", ")}.`,
    });
  }
  if (!meta.description || meta.description.trim().length < 40) {
    findings.push({
      severity: "warning",
      rule: "marketplace.json.description.short",
      file: METADATA_FILENAME,
      message: "marketplace.json description is missing or short (<40 chars)",
      fix: "Provide a 1–2 sentence description of the theme for the Marketplace listing.",
    });
  }
  if (!meta.supportUrl) {
    findings.push({
      severity: "warning",
      rule: "marketplace.json.supportUrl.missing",
      file: METADATA_FILENAME,
      message: "marketplace.json has no supportUrl",
      fix: "Add a public support URL where buyers can reach the publisher.",
    });
  }
  // HubSpot listing requirements: minimum 2, maximum 5 features.
  // https://developers.hubspot.com/docs/cms/marketplace/general-requirements#theme-module-details
  const featureCount = meta.features?.length ?? 0;
  if (featureCount < 2) {
    findings.push({
      severity: "warning",
      rule: "marketplace.json.features.too_few",
      file: METADATA_FILENAME,
      message: `marketplace.json needs at least 2 features (has ${featureCount})`,
      fix: "Add 2–5 short bullet points highlighting what the theme does well.",
    });
  } else if (featureCount > 5) {
    findings.push({
      severity: "warning",
      rule: "marketplace.json.features.too_many",
      file: METADATA_FILENAME,
      message: `marketplace.json has ${featureCount} features but HubSpot allows at most 5`,
      fix: "Trim the features list to 5 or fewer entries.",
    });
  }
}

// ---------------------------------------------------------------------------
// Auto-fixes for the small set of findings we can resolve without intent.
// ---------------------------------------------------------------------------

export interface ApplyFixResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply the auto-fixable subset of findings:
 *   - Missing module label → fall back to the .module directory name.
 *   - Missing field label → fall back to the field's `name` attribute.
 *   - External CDN @import / <link> / <script> references → strip them.
 */
export function applyMarketplaceAutoFixes(themePath: string): ApplyFixResult {
  const applied: string[] = [];
  const skipped: string[] = [];

  const modulesDir = join(themePath, "modules");
  if (fileExists(modulesDir)) {
    for (const entry of readdirSafe(modulesDir)) {
      if (!entry.endsWith(".module")) continue;
      const modulePath = join(modulesDir, entry);
      const moduleSlug = entry.replace(/\.module$/, "");

      // meta.json — fill in label.
      const metaPath = join(modulePath, "meta.json");
      if (fileExists(metaPath)) {
        try {
          const meta = JSON.parse(readFile(metaPath)) as Record<string, unknown>;
          if (!hasNonEmpty(meta, "label")) {
            meta.label = humanize(moduleSlug);
            writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
            applied.push(`${entry}: filled meta.label = "${meta.label}"`);
          }
        } catch {
          skipped.push(`${entry}: meta.json could not be parsed`);
        }
      }

      // fields.json — fill in field labels.
      const fieldsPath = join(modulePath, "fields.json");
      if (fileExists(fieldsPath)) {
        try {
          const fields = JSON.parse(readFile(fieldsPath));
          if (Array.isArray(fields)) {
            const result = autoFillFieldLabels(fields);
            if (result > 0) {
              writeFile(fieldsPath, JSON.stringify(fields, null, 2) + "\n");
              applied.push(`${entry}: filled ${result} missing field label(s)`);
            }
          }
        } catch {
          skipped.push(`${entry}: fields.json could not be parsed`);
        }
      }
    }
  }

  // Strip CDN imports across shared CSS and module CSS/HTML so the same finding
  // the validator surfaces gets cleaned up here. We mirror the cleanup that the
  // upload auto-fix path performs but run it on demand from `marketplace check`.
  const cdnFiles = stripCdnReferencesAcrossTheme(themePath);
  for (const file of cdnFiles) {
    applied.push(`${file}: stripped external CDN reference(s)`);
  }

  return { applied, skipped };
}

function stripCdnReferencesAcrossTheme(themePath: string): string[] {
  const fixed: string[] = [];

  const importRe = /@import\s+url\(['"]?https?:\/\/[^)]+['"]?\)\s*;?/gi;
  const linkRe = /<link[^>]+href=['"]https?:\/\/[^'"]+['"][^>]*>/gi;
  const scriptRe = /<script[^>]+src=['"]https?:\/\/[^'"]+['"][^>]*><\/script>/gi;
  const scriptSelfClosingRe = /<script[^>]+src=['"]https?:\/\/[^'"]+['"][^>]*\/>/gi;

  function rewriteCss(file: string): void {
    let content: string;
    try { content = readFile(file); } catch { return; }
    const cleaned = content.replace(importRe, "");
    if (cleaned !== content) {
      writeFile(file, cleaned);
      fixed.push(relativeToTheme(themePath, file));
    }
  }

  function rewriteHtml(file: string): void {
    let content: string;
    try { content = readFile(file); } catch { return; }
    let cleaned = content.replace(linkRe, "");
    cleaned = cleaned.replace(scriptRe, "");
    cleaned = cleaned.replace(scriptSelfClosingRe, "");
    cleaned = cleaned.replace(importRe, "");
    if (cleaned !== content) {
      writeFile(file, cleaned);
      fixed.push(relativeToTheme(themePath, file));
    }
  }

  scanDirShallow(join(themePath, "css"), ".css").forEach(rewriteCss);

  const modulesDir = join(themePath, "modules");
  if (fileExists(modulesDir)) {
    for (const entry of readdirSafe(modulesDir)) {
      if (!entry.endsWith(".module")) continue;
      const modulePath = join(modulesDir, entry);
      const cssFile = join(modulePath, "module.css");
      const htmlFile = join(modulePath, "module.html");
      if (fileExists(cssFile)) rewriteCss(cssFile);
      if (fileExists(htmlFile)) rewriteHtml(htmlFile);
    }
  }

  return fixed;
}

function autoFillFieldLabels(fields: unknown[]): number {
  let count = 0;
  for (const field of fields) {
    if (typeof field !== "object" || field === null) continue;
    const f = field as Record<string, unknown>;
    if (!hasNonEmpty(f, "label") && hasNonEmpty(f, "name")) {
      f.label = humanize(String(f.name));
      count++;
    }
    if (Array.isArray(f.children)) {
      count += autoFillFieldLabels(f.children as unknown[]);
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonSafe(file: string): Record<string, unknown> | null {
  if (!fileExists(file)) return null;
  try {
    const data = JSON.parse(readFile(file));
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hasNonEmpty(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return v != null && v !== "";
}

function resolveThemeRelative(themePath: string, ref: string): string {
  // Inputs look like "./images/template-previews/home.png" or "templates/home.html".
  const cleaned = ref.replace(/^\.?\//, "");
  return join(themePath, cleaned);
}

function relativeToTheme(themePath: string, fullPath: string): string {
  const rel = relative(themePath, fullPath);
  return rel.split("\\").join("/");
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function scanDirShallow(dir: string, extension: string): string[] {
  if (!fileExists(dir)) return [];
  try {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).isFile() && name.endsWith(extension)) out.push(file);
    }
    return out;
  } catch {
    return [];
  }
}

function humanize(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
