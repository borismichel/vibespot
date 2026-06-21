/**
 * Design-checkpoint preview renderer (VIB-1877).
 *
 * Builds the `CheckpointPreview` shown in the design gate card — palette, type
 * specimen, and ONE representative hero — straight from the design-system
 * tokens, with NO model call. This is the cheap visual the user approves before
 * the expensive parallel module build (Stage 3). It is deliberately deterministic
 * and self-contained: the hero is rendered from the tokens alone, so the card is
 * accurate to the chosen look without generating any modules first.
 */

import type { CheckpointPreview, DesignSystemOutput } from "./types.js";

export interface DesignPreviewData {
  aesthetic: string;
  /** Swatches drawn from color-valued CSS variables. */
  palette: { label: string; value: string }[];
  typography: { heading: string; body: string };
  /** Self-contained HTML doc fragment (style + markup) for an iframe srcdoc. */
  heroHtml: string;
}

const COLOR_RE = /^(#|rgb|hsl|var\()/i;

function humanize(key: string): string {
  return key
    .replace(/^--/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Pick the first color var whose name matches any keyword, else a fallback. */
function pickColor(
  vars: Record<string, string>,
  keywords: string[],
  fallback: string,
): string {
  for (const kw of keywords) {
    for (const [k, v] of Object.entries(vars)) {
      if (k.toLowerCase().includes(kw) && COLOR_RE.test(String(v).trim())) {
        return String(v).trim();
      }
    }
  }
  return fallback;
}

function pickFont(
  vars: Record<string, string>,
  keywords: string[],
  fallback: string,
): string {
  for (const kw of keywords) {
    for (const [k, v] of Object.entries(vars)) {
      const key = k.toLowerCase();
      if (key.includes("font") && key.includes(kw) && String(v).trim()) {
        return String(v).trim();
      }
    }
  }
  // Any font var at all, else fallback.
  for (const [k, v] of Object.entries(vars)) {
    if (k.toLowerCase().includes("font") && String(v).trim()) return String(v).trim();
  }
  return fallback;
}

function extractPalette(vars: Record<string, string>): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(vars)) {
    const val = String(v).trim();
    if (!COLOR_RE.test(val) || val.startsWith("var(")) continue;
    if (seen.has(val.toLowerCase())) continue;
    seen.add(val.toLowerCase());
    out.push({ label: humanize(k), value: val });
    if (out.length >= 6) break;
  }
  return out;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a representative hero from the tokens — one section that shows the
 * surface, heading + body type, and a primary button, all themed. Returned as a
 * complete self-contained HTML string suitable for an iframe `srcdoc` so its
 * styles never leak into the host page.
 */
function renderHeroSpecimen(
  vars: Record<string, string>,
  headingFont: string,
  bodyFont: string,
): string {
  const surface = pickColor(vars, ["background", "bg", "surface", "dark"], "#0f1115");
  const text = pickColor(vars, ["text", "foreground", "fg", "ink", "light"], "#f5f5f7");
  const primary = pickColor(vars, ["primary", "brand", "accent", "cta"], "#e8613a");
  const onPrimary = pickColor(vars, ["on-primary", "button-text", "light", "background"], "#ffffff");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}
body{font-family:${esc(bodyFont)};background:${esc(surface)};color:${esc(text)}}
.hero{padding:48px 40px;display:flex;flex-direction:column;gap:18px;align-items:flex-start}
.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.7}
h1{font-family:${esc(headingFont)};font-size:38px;line-height:1.08;font-weight:700;max-width:14ch}
p{font-size:16px;line-height:1.55;opacity:.85;max-width:46ch}
.btn{margin-top:6px;display:inline-block;padding:13px 26px;border-radius:8px;
  background:${esc(primary)};color:${esc(onPrimary)};font-family:${esc(headingFont)};
  font-weight:600;font-size:15px;text-decoration:none}
</style></head><body>
<section class="hero">
  <span class="eyebrow">Preview</span>
  <h1>Build pages that feel like your brand.</h1>
  <p>This is a sample hero rendered from the design system above — same palette, type, and button style your real modules will use.</p>
  <a class="btn" href="#">Get started</a>
</section>
</body></html>`;
}

/** Build the design-checkpoint preview card payload from the design system. */
export function buildDesignPreview(
  ds: DesignSystemOutput & { sharedCss?: string },
): CheckpointPreview {
  const vars = ds.cssVariables || {};
  const palette = extractPalette(vars);
  const headingFont = pickFont(vars, ["head", "display", "title", "serif"], "Space Grotesk, system-ui, sans-serif");
  const bodyFont = pickFont(vars, ["body", "text", "base", "sans"], "DM Sans, system-ui, sans-serif");
  const heroHtml = renderHeroSpecimen(vars, headingFont, bodyFont);

  const data: DesignPreviewData = {
    aesthetic: ds.aesthetic || "custom",
    palette,
    typography: { heading: headingFont, body: bodyFont },
    heroHtml,
  };

  return {
    kind: "design",
    headline: "Here's the look — approve before I build the page",
    data: data as unknown as Record<string, unknown>,
  };
}
