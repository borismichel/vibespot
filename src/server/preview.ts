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
  if (modules.length === 0) {
    return welcomePreview();
  }

  const renderedModules: string[] = [];
  const moduleCssArray: string[] = [];
  const moduleJsArray: string[] = [];

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

    if (mod.moduleCss) moduleCssArray.push(mod.moduleCss);
    if (mod.moduleJs) moduleJsArray.push(mod.moduleJs);
  }

  return assemblePreview({
    renderedModules,
    sharedCss: session.sharedCss,
    moduleCssArray,
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

// Note: The generating screen (spinner + rotating messages) is now
// rendered client-side in preview.js to avoid an extra server round-trip.
