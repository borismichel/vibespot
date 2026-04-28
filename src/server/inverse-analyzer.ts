/**
 * Inverse pipeline — HubSpot → vibeSpot.
 *
 * Reverse-engineer an imported HubSpot theme so the AI can iterate on it
 * coherently. Produces a structured report covering:
 *
 *   - Design tokens — `:root` custom properties, plus inferred palette,
 *     typography, spacing, radii, and shadow values harvested from the
 *     theme's CSS. Used to seed `sharedCss` when the imported theme has
 *     none, so AI-generated additions stay consistent with the theme.
 *   - Module/template relationship graph — which templates use which
 *     modules, plus orphan modules that no template references.
 *   - Field schema flags — patterns vibeSpot doesn't natively generate
 *     (deeply nested groups, repeater nesting, HubDB fields, custom
 *     widgets) so the AI can leave them alone.
 *   - Round-trip risks — HubL macros, partials, raw blocks, custom JS,
 *     and import_modules entries that the AI may unknowingly break on
 *     re-upload.
 *
 * Deterministic and rule-based on purpose — predictable, no AI cost.
 * Findings can later feed an AI brand-asset extractor for richer context.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readFile, writeFile, fileExists } from "../utils/fs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning" | "info";

export interface InverseFinding {
  severity: Severity;
  /** Stable rule id, e.g. "design.tokens.empty". */
  rule: string;
  file?: string;
  message: string;
  /** Optional remediation hint. */
  fix?: string;
}

export interface ColorToken {
  value: string;
  /** Number of CSS occurrences of this color across scanned files. */
  count: number;
  /** Token name if the color is declared as a CSS custom property. */
  varName?: string;
}

export interface DesignTokens {
  /** `:root` custom properties (`--name` → value), declared in the theme. */
  cssVariables: Record<string, string>;
  /** Top colours by frequency, normalized to lowercase hex/rgb. */
  palette: ColorToken[];
  /** Font families seen, deduplicated, in declaration order. */
  fontFamilies: string[];
  /** Font sizes seen (rem/em/px), unique values. */
  fontSizes: string[];
  /** Spacing values seen (rem/em/px) — useful for generating consistent padding. */
  spacing: string[];
  /** Border radii seen. */
  radii: string[];
  /** Box-shadow values seen. */
  shadows: string[];
}

export interface ModuleNode {
  name: string;
  templates: string[];
  hasJs: boolean;
}

export interface TemplateNode {
  id: string;
  file: string;
  modules: string[];
}

export interface ModuleGraph {
  templates: TemplateNode[];
  modules: ModuleNode[];
  /** Modules that exist on disk but no template references. */
  orphanModules: string[];
}

export interface FieldFlag {
  module: string;
  field: string;
  reason: string;
}

export interface RoundTripRisk {
  file: string;
  pattern: string;
  detail: string;
}

export interface InverseReport {
  themePath: string;
  designTokens: DesignTokens;
  graph: ModuleGraph;
  fieldFlags: FieldFlag[];
  roundTripRisks: RoundTripRisk[];
  findings: InverseFinding[];
  summary: {
    moduleCount: number;
    templateCount: number;
    orphanCount: number;
    paletteSize: number;
    cssVarCount: number;
    customMacroCount: number;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function analyzeTheme(themePath: string): InverseReport {
  const findings: InverseFinding[] = [];

  if (!fileExists(themePath)) {
    return emptyReport(themePath, [
      {
        severity: "error",
        rule: "theme.path.missing",
        message: `Theme directory not found: ${themePath}`,
      },
    ]);
  }

  const designTokens = extractDesignTokens(themePath);
  const graph = buildModuleGraph(themePath);
  const fieldFlags = collectFieldFlags(themePath);
  const roundTripRisks = collectRoundTripRisks(themePath);

  if (Object.keys(designTokens.cssVariables).length === 0) {
    findings.push({
      severity: "info",
      rule: "design.cssVariables.empty",
      message: "No :root CSS custom properties found in theme CSS.",
      fix: "Run with --apply-tokens to seed a :root block from inferred palette/typography.",
    });
  }
  if (designTokens.palette.length === 0) {
    findings.push({
      severity: "info",
      rule: "design.palette.empty",
      message: "Could not infer a colour palette from the theme CSS.",
    });
  }
  if (graph.orphanModules.length > 0) {
    findings.push({
      severity: "warning",
      rule: "modules.orphan",
      message: `${graph.orphanModules.length} module(s) are not referenced by any template: ${graph.orphanModules.join(", ")}`,
      fix: "Either reference these modules from a template or remove them.",
    });
  }
  if (graph.templates.length === 0 && graph.modules.length > 0) {
    findings.push({
      severity: "warning",
      rule: "templates.missing",
      message: "Theme has modules but no page templates wiring them together.",
      fix: "Add a templates/<name>.html that includes the modules via dnd_module.",
    });
  }
  for (const f of fieldFlags) {
    findings.push({
      severity: "info",
      rule: "field.unsupported-pattern",
      file: `modules/${f.module}.module/fields.json`,
      message: `${f.module}.${f.field}: ${f.reason}`,
      fix: "vibeSpot will preserve this field as-is. Edit it in HubSpot if changes are needed.",
    });
  }
  for (const r of roundTripRisks) {
    findings.push({
      severity: "warning",
      rule: "roundtrip.preserve-pattern",
      file: r.file,
      message: `${r.pattern}: ${r.detail}`,
      fix: "vibeSpot avoids modifying this. Don't ask the AI to refactor it.",
    });
  }

  const customMacroCount = roundTripRisks.filter((r) => r.pattern === "hubl.macro").length;

  return {
    themePath,
    designTokens,
    graph,
    fieldFlags,
    roundTripRisks,
    findings,
    summary: {
      moduleCount: graph.modules.length,
      templateCount: graph.templates.length,
      orphanCount: graph.orphanModules.length,
      paletteSize: designTokens.palette.length,
      cssVarCount: Object.keys(designTokens.cssVariables).length,
      customMacroCount,
    },
  };
}

/**
 * Build a `:root { ... }` CSS block from extracted tokens. Useful for
 * seeding `sharedCss` on imported themes that don't ship one.
 */
export function buildRootCssFromTokens(tokens: DesignTokens): string {
  const lines: string[] = [];

  // Existing custom properties win — keep them verbatim.
  for (const [name, value] of Object.entries(tokens.cssVariables)) {
    lines.push(`  ${name}: ${value};`);
  }

  // Otherwise synthesise tokens from inferred palette/typography. Only emit
  // when the original theme had no :root block, to avoid noisy duplicates.
  if (Object.keys(tokens.cssVariables).length === 0) {
    tokens.palette.slice(0, 8).forEach((c, i) => {
      const slot = i === 0 ? "primary" : i === 1 ? "secondary" : `accent-${i - 1}`;
      lines.push(`  --color-${slot}: ${c.value};`);
    });
    if (tokens.fontFamilies[0]) {
      lines.push(`  --font-family-base: ${tokens.fontFamilies[0]};`);
    }
    if (tokens.fontFamilies[1]) {
      lines.push(`  --font-family-heading: ${tokens.fontFamilies[1]};`);
    }
  }

  if (lines.length === 0) return "";
  return `:root {\n${lines.join("\n")}\n}\n`;
}

/**
 * Write the extracted `:root` block into `css/<theme>-theme.css` if no
 * shared CSS file exists. Returns the path written, or null if skipped.
 */
export function applyTokensToSharedCss(themePath: string, themeName: string): string | null {
  const cssDir = join(themePath, "css");
  if (fileExists(cssDir)) {
    try {
      for (const f of readdirSync(cssDir)) {
        if (f.endsWith("-theme.css")) return null; // already has shared CSS
      }
    } catch { /* ignore */ }
  }
  const tokens = extractDesignTokens(themePath);
  const rootBlock = buildRootCssFromTokens(tokens);
  if (!rootBlock) return null;

  const target = join(cssDir, `${themeName}-theme.css`);
  // Best-effort mkdir via writeFile helper — relies on existing fs util.
  writeFile(target, rootBlock);
  return target;
}

// ---------------------------------------------------------------------------
// Design token extraction
// ---------------------------------------------------------------------------

const COLOR_HEX_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const COLOR_RGB_RE = /\brgba?\([^)]+\)/g;
const COLOR_HSL_RE = /\bhsla?\([^)]+\)/g;
const FONT_FAMILY_RE = /font-family\s*:\s*([^;}\n]+)/g;
const FONT_SIZE_RE = /font-size\s*:\s*([^;}\n]+)/g;
const PADDING_MARGIN_RE = /(?:padding|margin|gap)(?:-(?:top|right|bottom|left))?\s*:\s*([^;}\n]+)/g;
const RADIUS_RE = /border-radius\s*:\s*([^;}\n]+)/g;
const SHADOW_RE = /box-shadow\s*:\s*([^;}\n]+)/g;
const ROOT_BLOCK_RE = /:root\s*\{([\s\S]*?)\}/g;
const CSS_VAR_DECL_RE = /(--[\w-]+)\s*:\s*([^;}\n]+)/g;

export function extractDesignTokens(themePath: string): DesignTokens {
  const cssFiles = collectCssFiles(themePath);

  const cssVariables: Record<string, string> = {};
  const colourCounts = new Map<string, number>();
  const colourVarNames = new Map<string, string>();
  const fontFamilies = new Set<string>();
  const fontSizes = new Set<string>();
  const spacing = new Set<string>();
  const radii = new Set<string>();
  const shadows = new Set<string>();

  for (const file of cssFiles) {
    let css: string;
    try { css = readFile(file); } catch { continue; }

    // :root custom properties
    let rootMatch: RegExpExecArray | null;
    const rootRe = new RegExp(ROOT_BLOCK_RE.source, "g");
    while ((rootMatch = rootRe.exec(css)) !== null) {
      const body = rootMatch[1];
      const declRe = new RegExp(CSS_VAR_DECL_RE.source, "g");
      let decl: RegExpExecArray | null;
      while ((decl = declRe.exec(body)) !== null) {
        const name = decl[1].trim();
        const value = decl[2].trim();
        if (!cssVariables[name]) cssVariables[name] = value;
        // Index colour-named tokens for the palette.
        const colorInValue = value.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)/);
        if (colorInValue) {
          const norm = normalizeColor(colorInValue[0]);
          colourVarNames.set(norm, name);
        }
      }
    }

    // Colours (hex, rgb, hsl) — count occurrences across all CSS for palette ordering.
    for (const re of [COLOR_HEX_RE, COLOR_RGB_RE, COLOR_HSL_RE]) {
      const local = new RegExp(re.source, "g");
      let m: RegExpExecArray | null;
      while ((m = local.exec(css)) !== null) {
        const norm = normalizeColor(m[0]);
        if (!norm) continue;
        colourCounts.set(norm, (colourCounts.get(norm) ?? 0) + 1);
      }
    }

    collectAllValues(css, FONT_FAMILY_RE, fontFamilies, sanitizeFontFamily);
    collectAllValues(css, FONT_SIZE_RE, fontSizes, (v) => v.trim());
    collectSpacing(css, spacing);
    collectAllValues(css, RADIUS_RE, radii, (v) => v.trim());
    collectAllValues(css, SHADOW_RE, shadows, (v) => v.trim());
  }

  const palette: ColorToken[] = [...colourCounts.entries()]
    .filter(([value]) => !isUtilityColor(value))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([value, count]) => ({
      value,
      count,
      varName: colourVarNames.get(value),
    }));

  return {
    cssVariables,
    palette,
    fontFamilies: [...fontFamilies].slice(0, 8),
    fontSizes: [...fontSizes].slice(0, 16),
    spacing: [...spacing].slice(0, 16),
    radii: [...radii].slice(0, 8),
    shadows: [...shadows].slice(0, 8),
  };
}

function collectAllValues(
  css: string,
  re: RegExp,
  set: Set<string>,
  transform: (v: string) => string,
): void {
  const local = new RegExp(re.source, "g");
  let m: RegExpExecArray | null;
  while ((m = local.exec(css)) !== null) {
    const v = transform(m[1]);
    if (v && !v.startsWith("var(")) set.add(v);
  }
}

function collectSpacing(css: string, set: Set<string>): void {
  const re = new RegExp(PADDING_MARGIN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const raw = m[1].trim();
    if (raw.startsWith("var(")) continue;
    // Split shorthand padding/margin into individual tokens.
    for (const part of raw.split(/\s+/)) {
      if (/^-?\d+(\.\d+)?(rem|em|px|%)$/.test(part)) set.add(part);
    }
  }
}

function sanitizeFontFamily(value: string): string {
  return value
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
}

function normalizeColor(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("#")) {
    // Expand 3-digit hex to 6-digit so #fff and #ffffff match.
    if (/^#[0-9a-f]{3}$/.test(trimmed)) {
      const [, a, b, c] = trimmed.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/)!;
      return `#${a}${a}${b}${b}${c}${c}`;
    }
    return trimmed;
  }
  return trimmed.replace(/\s+/g, "");
}

const UTILITY_COLORS = new Set([
  "#000000",
  "#ffffff",
  "transparent",
  "currentcolor",
  "inherit",
  "initial",
]);

function isUtilityColor(value: string): boolean {
  return UTILITY_COLORS.has(value);
}

function collectCssFiles(themePath: string): string[] {
  const out: string[] = [];

  const cssDir = join(themePath, "css");
  if (fileExists(cssDir)) {
    for (const f of readdirSafe(cssDir)) {
      if (f.endsWith(".css")) out.push(join(cssDir, f));
    }
  }

  const modulesDir = join(themePath, "modules");
  if (fileExists(modulesDir)) {
    for (const entry of readdirSafe(modulesDir)) {
      if (!entry.endsWith(".module")) continue;
      const moduleCss = join(modulesDir, entry, "module.css");
      if (fileExists(moduleCss)) out.push(moduleCss);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Module/template graph
// ---------------------------------------------------------------------------

export function buildModuleGraph(themePath: string): ModuleGraph {
  const modulesDir = join(themePath, "modules");
  const templatesDir = join(themePath, "templates");

  const moduleNames = new Set<string>();
  const moduleHasJs = new Map<string, boolean>();
  if (fileExists(modulesDir)) {
    for (const entry of readdirSafe(modulesDir)) {
      if (!entry.endsWith(".module")) continue;
      const name = entry.replace(/\.module$/, "");
      moduleNames.add(name);
      moduleHasJs.set(name, fileExists(join(modulesDir, entry, "module.js")));
    }
  }

  const templateNodes: TemplateNode[] = [];
  const moduleToTemplates = new Map<string, Set<string>>();

  if (fileExists(templatesDir)) {
    for (const filename of readdirSafe(templatesDir)) {
      if (!filename.endsWith(".html") || filename === "home.html") continue;
      const filePath = join(templatesDir, filename);
      let stat;
      try { stat = statSync(filePath); } catch { continue; }
      if (!stat.isFile()) continue;
      let content: string;
      try { content = readFile(filePath); } catch { continue; }
      const moduleRe = /dnd_module\s+path=["']\.\.\/modules\/([^."']+)\.module["']/g;
      const found: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = moduleRe.exec(content)) !== null) {
        const name = m[1];
        found.push(name);
        const templates = moduleToTemplates.get(name) ?? new Set<string>();
        templates.add(filename);
        moduleToTemplates.set(name, templates);
      }
      const id = filename.replace(/\.html$/, "");
      templateNodes.push({ id, file: `templates/${filename}`, modules: dedup(found) });
    }
  }

  const moduleNodes: ModuleNode[] = [...moduleNames].sort().map((name) => ({
    name,
    templates: [...(moduleToTemplates.get(name) ?? [])].sort(),
    hasJs: moduleHasJs.get(name) ?? false,
  }));

  const orphanModules = moduleNodes.filter((m) => m.templates.length === 0).map((m) => m.name);

  return { templates: templateNodes, modules: moduleNodes, orphanModules };
}

// ---------------------------------------------------------------------------
// Field schema flags
// ---------------------------------------------------------------------------

const VIBESPOT_GENERATED_FIELD_TYPES = new Set([
  "text",
  "richtext",
  "image",
  "url",
  "boolean",
  "choice",
  "number",
  "color",
  "icon",
  "link",
  "menu",
  "video",
  "form",
  "cta",
  "blog",
  "tag",
  "page",
  "email",
  "logo",
  "embed",
  "alignment",
  "border",
  "spacing",
  "font",
  "background",
  "gradient",
  "textalignment",
  "group",
]);

export function collectFieldFlags(themePath: string): FieldFlag[] {
  const out: FieldFlag[] = [];
  const modulesDir = join(themePath, "modules");
  if (!fileExists(modulesDir)) return out;

  for (const entry of readdirSafe(modulesDir)) {
    if (!entry.endsWith(".module")) continue;
    const moduleName = entry.replace(/\.module$/, "");
    const fieldsPath = join(modulesDir, entry, "fields.json");
    if (!fileExists(fieldsPath)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(readFile(fieldsPath)); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    walkFields(parsed as unknown[], moduleName, out, 0);
  }

  return out;
}

function walkFields(fields: unknown[], moduleName: string, out: FieldFlag[], depth: number): void {
  for (const field of fields) {
    if (typeof field !== "object" || field === null) continue;
    const f = field as Record<string, unknown>;
    const name = typeof f.name === "string" ? f.name : "(unnamed)";
    const type = typeof f.type === "string" ? f.type : "";

    if (type === "group" && depth >= 1) {
      out.push({ module: moduleName, field: name, reason: "deeply nested group (>1 level)" });
    }
    if ((type === "group" || type === "module") && f.occurrence) {
      const occ = f.occurrence as Record<string, unknown>;
      if (occ.max !== undefined && occ.max !== 1) {
        out.push({ module: moduleName, field: name, reason: "repeater (occurrence) field" });
      }
    }
    if (type === "hubdb_table" || type === "hubdbtable") {
      out.push({ module: moduleName, field: name, reason: "HubDB-backed field" });
    }
    if (type === "crm_object" || type === "crm_object_property") {
      out.push({ module: moduleName, field: name, reason: "CRM object field" });
    }
    if (type === "embed" && typeof f.embed === "object") {
      out.push({ module: moduleName, field: name, reason: "rich embed field" });
    }
    if (type && !VIBESPOT_GENERATED_FIELD_TYPES.has(type) && type !== "module") {
      out.push({ module: moduleName, field: name, reason: `field type "${type}" not in vibeSpot's generation set` });
    }
    if (f.visibility && typeof f.visibility === "object") {
      out.push({ module: moduleName, field: name, reason: "conditional visibility rule" });
    }

    if (Array.isArray(f.children)) {
      walkFields(f.children as unknown[], moduleName, out, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Round-trip risks
// ---------------------------------------------------------------------------

export function collectRoundTripRisks(themePath: string): RoundTripRisk[] {
  const out: RoundTripRisk[] = [];

  // Module-level: custom JS, custom macros in HTML, raw blocks
  const modulesDir = join(themePath, "modules");
  if (fileExists(modulesDir)) {
    for (const entry of readdirSafe(modulesDir)) {
      if (!entry.endsWith(".module")) continue;
      const slug = entry.replace(/\.module$/, "");
      const htmlPath = join(modulesDir, entry, "module.html");
      if (fileExists(htmlPath)) scanHublRisks(htmlPath, themePath, slug, out);
      const jsPath = join(modulesDir, entry, "module.js");
      if (fileExists(jsPath)) {
        try {
          const js = readFile(jsPath);
          if (js.trim().length > 0) {
            out.push({
              file: relativeToTheme(themePath, jsPath),
              pattern: "module.js.custom",
              detail: `${slug}: module ships custom JS — preserve verbatim`,
            });
          }
        } catch { /* ignore */ }
      }
    }
  }

  // Template-level: macros, includes from outside modules/, raw blocks
  const templatesDir = join(themePath, "templates");
  if (fileExists(templatesDir)) {
    for (const filename of readdirSafe(templatesDir)) {
      if (!filename.endsWith(".html")) continue;
      const filePath = join(templatesDir, filename);
      if (!fileExists(filePath)) continue;
      let stat;
      try { stat = statSync(filePath); } catch { continue; }
      if (!stat.isFile()) continue;
      scanHublRisks(filePath, themePath, filename, out);
    }
  }

  // import_modules.json — declares pre-installed modules HubSpot expects
  const importModules = join(themePath, "import_modules.json");
  if (fileExists(importModules)) {
    out.push({
      file: "import_modules.json",
      pattern: "theme.import_modules",
      detail: "Theme declares import_modules.json — preserve to avoid breaking HubSpot pre-install",
    });
  }

  return out;
}

function scanHublRisks(file: string, themePath: string, slug: string, out: RoundTripRisk[]): void {
  let content: string;
  try { content = readFile(file); } catch { return; }
  const rel = relativeToTheme(themePath, file);

  if (/{%\s*macro\s+\w+/.test(content)) {
    out.push({ file: rel, pattern: "hubl.macro", detail: `${slug}: contains custom HubL {% macro %}` });
  }
  if (/{%\s*raw\s*%}/.test(content)) {
    out.push({ file: rel, pattern: "hubl.raw", detail: `${slug}: contains {% raw %} block` });
  }
  const includeRe = /{%\s*include\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = includeRe.exec(content)) !== null) {
    const target = m[1];
    if (!target.startsWith("../modules/") && !target.startsWith("./modules/") && !target.includes("/layouts/")) {
      out.push({
        file: rel,
        pattern: "hubl.include",
        detail: `${slug}: includes partial "${target}" outside modules/`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyReport(themePath: string, findings: InverseFinding[]): InverseReport {
  return {
    themePath,
    designTokens: {
      cssVariables: {},
      palette: [],
      fontFamilies: [],
      fontSizes: [],
      spacing: [],
      radii: [],
      shadows: [],
    },
    graph: { templates: [], modules: [], orphanModules: [] },
    fieldFlags: [],
    roundTripRisks: [],
    findings,
    summary: {
      moduleCount: 0,
      templateCount: 0,
      orphanCount: 0,
      paletteSize: 0,
      cssVarCount: 0,
      customMacroCount: 0,
    },
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function relativeToTheme(themePath: string, fullPath: string): string {
  return relative(themePath, fullPath).split("\\").join("/");
}

function dedup<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
