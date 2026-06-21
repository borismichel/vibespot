/**
 * Brand-intake routing (VIB-1878).
 *
 * The brand-intake checkpoint fires at the front of the pipeline ONLY when a
 * theme has no style system yet (see `missingBrandAssets`). When the user picks
 * "Bring your brand" instead of "Surprise me", each channel they fill in is
 * routed here to its matching extractor and folded into a single brand result:
 *
 *   - paste colors  → parsed into semantic `:root` color variables
 *   - paste code    → CSS/HTML token extraction (`:root` vars, colors, fonts)
 *   - HubSpot theme → inverse-analyzer `extractDesignTokens` → `:root`
 *   - site URL      → fetch + CSS token extraction (best-effort)
 *   - tone of voice → brandvoice asset (steers copy during the build)
 *
 * Everything here is deterministic (no model call) so the gate stays cheap. The
 * result seeds the design system: `styleguide` is injected into the design
 * prompt and the derived `cssVariables` are merged into the design checkpoint so
 * the brand `:root` is rendered before the expensive module build.
 */

import type { BrandIntakeInput } from "./types.js";
import type { DesignTokens } from "../inverse-analyzer.js";
import { extractDesignTokens, buildRootCssFromTokens } from "../inverse-analyzer.js";
import { log } from "../log.js";

export interface BrandIntakeResult {
  /** Merged `:root` custom properties derived from every populated channel. */
  cssVariables: Record<string, string>;
  /** A `:root { … }` block built from `cssVariables` (empty when none found). */
  rootCss: string;
  /** Human-readable brand brief injected into the design-system prompt. */
  styleguide?: string;
  /** Tone-of-voice text persisted as the brandvoice asset. */
  brandvoice?: string;
  /** Which channels actually contributed, for the summary message. */
  channels: string[];
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)/g;
const ROOT_RE = /:root\s*\{([^}]*)\}/g;
// Trailing `;` is optional so the last declaration in a block is still captured.
const VAR_DECL_RE = /(--[A-Za-z0-9-_]+)\s*:\s*([^;]+?)\s*(?:;|$)/g;
const FONT_FAMILY_RE = /font-family\s*:\s*([^;}]+)[;}]/gi;

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/** Empty design-tokens scaffold to fill incrementally. */
function emptyTokens(): DesignTokens {
  return { cssVariables: {}, palette: [], fontFamilies: [], fontSizes: [], spacing: [], radii: [], shadows: [] };
}

/**
 * Extract design tokens from a raw CSS/HTML string (pasted code or fetched
 * markup). Mirrors the disk-based `extractDesignTokens` but works in-memory:
 * `:root` declarations win, then top colors and font families seed a palette.
 */
function tokensFromCss(css: string): DesignTokens {
  const tokens = emptyTokens();

  let rootMatch: RegExpExecArray | null;
  const rootRe = new RegExp(ROOT_RE.source, "g");
  while ((rootMatch = rootRe.exec(css)) !== null) {
    const declRe = new RegExp(VAR_DECL_RE.source, "g");
    let decl: RegExpExecArray | null;
    while ((decl = declRe.exec(rootMatch[1])) !== null) {
      const name = decl[1].trim();
      const value = decl[2].trim();
      if (name && value && !tokens.cssVariables[name]) tokens.cssVariables[name] = value;
    }
  }

  const counts = new Map<string, number>();
  let cm: RegExpExecArray | null;
  const colorRe = new RegExp(COLOR_RE.source, "g");
  while ((cm = colorRe.exec(css)) !== null) {
    const norm = cm[0].trim().toLowerCase();
    if (["#fff", "#ffffff", "#000", "#000000"].includes(norm)) continue;
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  }
  tokens.palette = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([value, count]) => ({ value, count }));

  const fonts: string[] = [];
  let fm: RegExpExecArray | null;
  const fontRe = new RegExp(FONT_FAMILY_RE.source, "gi");
  while ((fm = fontRe.exec(css)) !== null) {
    const first = fm[1].split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (first && !first.startsWith("var(")) fonts.push(first);
  }
  tokens.fontFamilies = uniq(fonts).slice(0, 8);

  return tokens;
}

/**
 * Parse a free-form colors blob into semantic `:root` color variables.
 * Accepts hex/rgb/hsl values, one per line or comma-separated, with optional
 * leading labels ("Primary: #e8613a" or "Brand #e8613a, accent #111").
 */
function tokensFromColors(raw: string): DesignTokens {
  const tokens = emptyTokens();
  const lines = raw.split(/[\n,]/).map((l) => l.trim()).filter(Boolean);
  let i = 0;
  for (const line of lines) {
    const colorRe = new RegExp(COLOR_RE.source, "g");
    const m = colorRe.exec(line);
    if (!m) continue;
    const value = m[0].trim();
    // Use a leading label as the var name if present, else a positional slot.
    const labelPart = line.slice(0, m.index).replace(/[:\-–—]+\s*$/, "").trim();
    const slug = labelPart
      ? labelPart.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      : "";
    const name = slug
      ? `--color-${slug}`
      : i === 0 ? "--color-primary" : i === 1 ? "--color-secondary" : `--color-accent-${i - 1}`;
    if (!tokens.cssVariables[name]) {
      tokens.cssVariables[name] = value;
      tokens.palette.push({ value: value.toLowerCase(), count: 1 });
      i++;
    }
  }
  return tokens;
}

/** Best-effort fetch of a site's HTML + linked stylesheets, concatenated. */
async function fetchSiteCss(url: string): Promise<string> {
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(normalized, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) return "";
    const html = await res.text();
    let css = "";
    // Inline <style> blocks.
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) css += `\n${m[1]}`;
    // Linked stylesheets (first few only).
    const hrefs: string[] = [];
    for (const m of html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)) {
      const href = /href=["']([^"']+)["']/i.exec(m[0])?.[1];
      if (href) hrefs.push(href);
    }
    for (const href of hrefs.slice(0, 3)) {
      try {
        const abs = new URL(href, normalized).toString();
        const sheet = await fetch(abs, { signal: controller.signal, redirect: "follow" });
        if (sheet.ok) css += `\n${await sheet.text()}`;
      } catch { /* skip individual sheet failures */ }
    }
    return css;
  } catch (err) {
    log.warn("brand-intake", `site fetch failed for ${normalized}: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Merge a channel's tokens into the running accumulators (first value wins). */
function mergeTokens(into: Record<string, string>, palette: string[], fonts: string[], tokens: DesignTokens): void {
  for (const [k, v] of Object.entries(tokens.cssVariables)) {
    if (!into[k]) into[k] = v;
  }
  palette.push(...tokens.palette.map((p) => p.value));
  fonts.push(...tokens.fontFamilies);
}

/**
 * Route the user's brand-intake input through the matching extractors and fold
 * the results into one brand brief + merged `:root`. Returns empty channels if
 * nothing usable was provided (the caller then falls back to "surprise me").
 */
export async function routeBrandIntake(input: BrandIntakeInput): Promise<BrandIntakeResult> {
  const cssVariables: Record<string, string> = {};
  const palette: string[] = [];
  const fonts: string[] = [];
  const channels: string[] = [];
  const briefSections: string[] = [];

  if (input.colors?.trim()) {
    const t = tokensFromColors(input.colors);
    if (Object.keys(t.cssVariables).length > 0) {
      mergeTokens(cssVariables, palette, fonts, t);
      channels.push("colors");
      briefSections.push(`### Brand colors (provided)\n${Object.entries(t.cssVariables).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
    }
  }

  if (input.code?.trim()) {
    const t = tokensFromCss(input.code);
    if (Object.keys(t.cssVariables).length > 0 || t.palette.length > 0 || t.fontFamilies.length > 0) {
      mergeTokens(cssVariables, palette, fonts, t);
      channels.push("code");
      briefSections.push(`### From pasted code\n- Variables: ${Object.keys(t.cssVariables).length}\n- Colors: ${t.palette.slice(0, 6).map((p) => p.value).join(", ") || "none"}\n- Fonts: ${t.fontFamilies.join(", ") || "none"}`);
    }
  }

  if (input.themePath?.trim()) {
    try {
      const t = extractDesignTokens(input.themePath.trim());
      if (Object.keys(t.cssVariables).length > 0 || t.palette.length > 0 || t.fontFamilies.length > 0) {
        mergeTokens(cssVariables, palette, fonts, t);
        channels.push("theme");
        briefSections.push(`### From imported theme\n- Variables: ${Object.keys(t.cssVariables).length}\n- Colors: ${t.palette.slice(0, 6).map((p) => p.value).join(", ") || "none"}\n- Fonts: ${t.fontFamilies.join(", ") || "none"}`);
      }
    } catch (err) {
      log.warn("brand-intake", `theme token extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (input.siteUrl?.trim()) {
    const css = await fetchSiteCss(input.siteUrl.trim());
    if (css) {
      const t = tokensFromCss(css);
      if (Object.keys(t.cssVariables).length > 0 || t.palette.length > 0 || t.fontFamilies.length > 0) {
        mergeTokens(cssVariables, palette, fonts, t);
        channels.push("site");
        briefSections.push(`### From site (${input.siteUrl.trim()})\n- Colors: ${t.palette.slice(0, 6).map((p) => p.value).join(", ") || "none"}\n- Fonts: ${t.fontFamilies.join(", ") || "none"}`);
      }
    }
  }

  // Synthesize semantic vars from inferred palette/fonts when no explicit
  // `:root` variables were provided (e.g. site/theme with utility CSS only).
  if (Object.keys(cssVariables).length === 0) {
    uniq(palette).slice(0, 6).forEach((value, i) => {
      const slot = i === 0 ? "primary" : i === 1 ? "secondary" : `accent-${i - 1}`;
      cssVariables[`--color-${slot}`] = value;
    });
  }
  const uFonts = uniq(fonts);
  if (uFonts[0] && !Object.keys(cssVariables).some((k) => k.includes("font") && k.includes("head"))) {
    cssVariables["--font-heading"] = uFonts[0];
  }
  if (uFonts[1] && !Object.keys(cssVariables).some((k) => k.includes("font") && k.includes("body"))) {
    cssVariables["--font-body"] = uFonts[1] || uFonts[0];
  }

  const rootCss = Object.keys(cssVariables).length
    ? buildRootCssFromTokens({ ...emptyTokens(), cssVariables })
    : "";

  const brandvoice = input.voice?.trim() || undefined;
  if (brandvoice) channels.push("voice");

  let styleguide: string | undefined;
  if (briefSections.length > 0 || brandvoice) {
    const parts = [
      "# Brand intake (user-provided)",
      "Use these EXACT brand tokens as the foundation of the design system. Map the colors and fonts into `:root` variables and build every component style around them — do not invent a different palette.",
    ];
    if (briefSections.length) parts.push(briefSections.join("\n\n"));
    if (brandvoice) parts.push(`### Tone of voice\n${brandvoice}`);
    styleguide = parts.join("\n\n");
  }

  return { cssVariables, rootCss, styleguide, brandvoice, channels };
}
