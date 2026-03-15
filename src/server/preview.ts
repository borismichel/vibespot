/**
 * Preview builder — assembles rendered HubL modules into a full HTML page.
 */

import {
  renderHubL,
  buildContextFromFields,
  assemblePreview,
  type FieldDef,
} from "../hubl/renderer.js";
import { getSession, getOrderedModules } from "./session.js";

/**
 * Extract CSS custom property values from shared CSS.
 * Returns defaults for dark theme if properties aren't found.
 */
function extractThemeColors(sharedCss: string | undefined): {
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  border: string;
} {
  if (!sharedCss) {
    return { bg: "#0f0f14", surface: "#1a1a20", text: "#ffffff", textMuted: "#666", border: "#333" };
  }

  const extract = (names: string[], fallback: string): string => {
    for (const name of names) {
      // Match --name: #hex or --name: rgb(...) etc.
      const re = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*([^;})]+)`, "i");
      const m = sharedCss.match(re);
      if (m) return m[1].trim();
    }
    return fallback;
  };

  const bg = extract(["--bg", "--background", "--color-bg", "--bg-primary", "--body-bg"], "#0f0f14");
  const surface = extract(["--surface", "--bg-secondary", "--card-bg", "--color-surface"], bg);
  const text = extract(["--text", "--color-text", "--text-primary", "--fg", "--foreground"], "#ffffff");
  const textMuted = extract(["--text-muted", "--text-secondary", "--muted", "--color-text-muted"], "#666");
  const border = extract(["--border", "--border-color", "--color-border"], "#333");

  return { bg, surface, text, textMuted, border };
}

/**
 * Build a full preview HTML page from the current session state.
 * Each module's HubL template is rendered with its fields.json defaults,
 * then assembled with shared CSS/JS into a complete page.
 */
export function buildPreviewHtml(): string {
  const session = getSession();
  if (!session) {
    return welcomePreview();
  }

  const modules = getOrderedModules();
  const moduleOrder = session.moduleOrder || [];

  // Nothing to show yet — no modules and no pending order
  if (modules.length === 0 && moduleOrder.length === 0) {
    return welcomePreview();
  }

  const renderedModules: string[] = [];
  const moduleCssArray: string[] = [];
  const moduleJsArray: string[] = [];
  const renderedNames = new Set<string>();

  for (const mod of modules) {
    // Skip template-like content that was accidentally stored as a module
    if (mod.moduleHtml.includes("dnd_area") || mod.moduleHtml.includes("extends ")) {
      continue;
    }

    // Build context from fields.json defaults
    let context: { module: Record<string, unknown> };
    try {
      const fields: FieldDef[] = JSON.parse(mod.fieldsJson);
      context = { module: buildContextFromFields(fields) };
    } catch {
      context = { module: {} };
    }

    // Render HubL template with context
    const rendered = renderHubL(mod.moduleHtml, context);

    // Wrap each module in a container with id + data attribute for anchor links
    const anchorId = mod.moduleName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    renderedModules.push(
      `<div class="vibespot-module" id="${anchorId}" data-module="${mod.moduleName}">${rendered}</div>`
    );
    renderedNames.add(mod.moduleName);

    if (mod.moduleCss) moduleCssArray.push(mod.moduleCss);
    if (mod.moduleJs) moduleJsArray.push(mod.moduleJs);
  }

  // Render skeleton placeholders for modules in moduleOrder that aren't generated yet
  const theme = extractThemeColors(session.sharedCss);
  for (const name of moduleOrder) {
    if (!renderedNames.has(name)) {
      const anchorId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      renderedModules.push(
        `<div class="vibespot-module vibespot-module--pending" id="${anchorId}" data-module="${name}">
          <div class="vibespot-placeholder">
            <div class="vibespot-placeholder__name">${name}</div>
          </div>
        </div>`
      );
    }
  }

  // Add placeholder CSS for pending modules — uses theme colors
  const placeholderCss = `body{background:${theme.bg}}.vibespot-placeholder{display:flex;align-items:center;justify-content:center;min-height:200px;padding:3rem;background:${theme.surface};border:1px dashed ${theme.border};border-radius:12px;margin:1rem 0}.vibespot-placeholder__name{font-size:1.5rem;font-weight:600;font-family:system-ui,sans-serif;color:${theme.textMuted};letter-spacing:.5px;animation:vp-fade 2s ease-in-out infinite}@keyframes vp-fade{0%,100%{opacity:.3}50%{opacity:.8}}`;

  return assemblePreview({
    renderedModules,
    sharedCss: session.sharedCss,
    moduleCssArray: [placeholderCss, ...moduleCssArray],
    sharedJs: session.sharedJs,
    moduleJsArray,
  });
}

/**
 * Static welcome screen — shown before first generation.
 */
function welcomePreview(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f0f14;
    color: #888;
  }
  .welcome {
    text-align: center;
    padding: 2rem;
  }
  .welcome__wave {
    font-size: 4rem;
    margin-bottom: 1.2rem;
    opacity: 0.4;
    animation: float 3s ease-in-out infinite;
  }
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-6px); }
  }
  .welcome__title {
    font-size: 1.4rem;
    font-weight: 600;
    color: #bbb;
    letter-spacing: 0.5px;
    margin-bottom: 0.4rem;
  }
  .welcome__sub {
    font-size: 1rem;
    color: #666;
    font-weight: 300;
  }
</style>
</head>
<body>
<div class="welcome">
  <div class="welcome__wave">\u224B</div>
  <div class="welcome__title">vibeSpot</div>
  <div class="welcome__sub">Build Something Great</div>
</div>
</body>
</html>`;
}

/**
 * Build a preview HTML page for a single module (used by the dashboard module library).
 */
export function buildModulePreviewHtml(moduleName: string): string {
  const session = getSession();
  if (!session) return "";

  // Find the module across all templates
  let mod: typeof session.modules[0] | undefined;
  for (const tpl of session.templates) {
    mod = tpl.modules.find((m) => m.moduleName === moduleName);
    if (mod) break;
  }
  // Fallback: check flat modules array
  if (!mod) {
    mod = session.modules.find((m) => m.moduleName === moduleName);
  }
  if (!mod) return "";

  let context: { module: Record<string, unknown> };
  try {
    const fields: FieldDef[] = JSON.parse(mod.fieldsJson);
    context = { module: buildContextFromFields(fields) };
  } catch {
    context = { module: {} };
  }

  const rendered = renderHubL(mod.moduleHtml, context);

  return assemblePreview({
    renderedModules: [
      `<div class="vibespot-module" data-module="${mod.moduleName}">${rendered}</div>`,
    ],
    sharedCss: session.sharedCss,
    moduleCssArray: mod.moduleCss ? [mod.moduleCss] : [],
    sharedJs: session.sharedJs,
    moduleJsArray: mod.moduleJs ? [mod.moduleJs] : [],
  });
}

// Note: The generating screen (spinner + rotating messages) is now
// rendered client-side in preview.js to avoid an extra server round-trip.
