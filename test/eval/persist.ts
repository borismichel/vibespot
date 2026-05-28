/**
 * Theme persistence + full-page render for the persistent-theme benchmark (VIB-1833).
 *
 * The provider-comparison harness (VIB-1768) keeps generated pages in memory and
 * only emits KPI numbers. This benchmark additionally writes every generated
 * theme to disk so the *fidelity* of each model can be compared after the fact —
 * the actual HubSpot module files plus a standalone, self-contained full-page
 * HTML render (the same `assemblePreview` the live preview uses), which a
 * headless browser can later screenshot (`screenshot.ts`).
 *
 * Layout per (model, page):
 *   <root>/<modelSlug>/<pageId>/
 *     theme/
 *       modules/<name>.module/{module.html,module.css,fields.json,meta.json,module.js?}
 *       shared.css  shared.js  module-order.json
 *     page.html      ← standalone full-page render (screenshot input)
 *     page.png       ← full-page screenshot (added later, if a browser is available)
 *     metrics.json   ← per-(model,page) KPIs (accuracy / cost / latency / …)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderHubL,
  buildContextFromFields,
  assemblePreview,
  type FieldDef,
} from "../../src/hubl/renderer.js";
import type { ModuleFiles } from "../../src/ai/engine.js";
import type { GeneratedPage } from "./generate.js";

/** kebab/slug a label or `engine:model` into a filesystem-safe directory name. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Render a session-independent full-page HTML document from generated modules +
 * shared CSS/JS. Mirrors `buildPreviewHtml` (src/server/preview.ts) but takes
 * explicit inputs instead of reading the live server session, so it works in the
 * eval process. Skips template-like content the same way the live preview does.
 */
export function renderFullPageHtml(page: {
  finalModules: ModuleFiles[];
  moduleOrder: string[];
  sharedCss: string;
  sharedJs: string;
}): string {
  const byName = new Map(page.finalModules.map((m) => [m.moduleName, m]));
  const ordered = page.moduleOrder.length
    ? page.moduleOrder.map((n) => byName.get(n)).filter((m): m is ModuleFiles => !!m)
    : page.finalModules;

  const renderedModules: string[] = [];
  const moduleCssArray: string[] = [];
  const moduleJsArray: string[] = [];

  for (const mod of ordered) {
    if (mod.moduleHtml.includes("dnd_area") || mod.moduleHtml.includes("extends ")) continue;

    let fields: FieldDef[] = [];
    let context: { module: Record<string, unknown> };
    try {
      const parsed = JSON.parse(mod.fieldsJson);
      fields = Array.isArray(parsed) ? parsed : [];
      context = { module: buildContextFromFields(fields) };
    } catch {
      context = { module: {} };
    }

    const rendered = renderHubL(mod.moduleHtml, context);
    const anchorId = slug(mod.moduleName);
    renderedModules.push(
      `<div class="vibespot-module" id="${anchorId}" data-module="${mod.moduleName}">${rendered}</div>`,
    );
    if (mod.moduleCss) moduleCssArray.push(mod.moduleCss);
    if (mod.moduleJs) moduleJsArray.push(mod.moduleJs);
  }

  return assemblePreview({
    renderedModules,
    sharedCss: page.sharedCss,
    moduleCssArray,
    sharedJs: page.sharedJs,
    moduleJsArray,
  });
}

/** Write one module's files in HubSpot `<name>.module/` layout. */
function writeModule(modulesDir: string, mod: ModuleFiles): void {
  const dir = join(modulesDir, `${slug(mod.moduleName)}.module`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "module.html"), mod.moduleHtml ?? "");
  writeFileSync(join(dir, "module.css"), mod.moduleCss ?? "");
  writeFileSync(join(dir, "fields.json"), mod.fieldsJson ?? "[]");
  writeFileSync(join(dir, "meta.json"), mod.metaJson ?? "{}");
  if (mod.moduleJs) writeFileSync(join(dir, "module.js"), mod.moduleJs);
}

export interface PersistResult {
  /** Absolute directory for this (model, page) artifact set. */
  dir: string;
  /** Absolute path to the standalone full-page HTML render. */
  pageHtmlPath: string;
  /** Absolute path to the importable theme directory. */
  themeDir: string;
}

/**
 * Persist a generated page: theme files (importable), a standalone full-page
 * HTML render, and a metrics sidecar. Returns the paths for the report + the
 * screenshot step.
 */
export function persistTheme(opts: {
  outRoot: string;
  modelSlug: string;
  pageId: string;
  page: GeneratedPage;
  metrics: unknown;
}): PersistResult {
  const dir = join(opts.outRoot, opts.modelSlug, opts.pageId);
  const themeDir = join(dir, "theme");
  const modulesDir = join(themeDir, "modules");
  mkdirSync(modulesDir, { recursive: true });

  for (const mod of opts.page.finalModules) writeModule(modulesDir, mod);
  writeFileSync(join(themeDir, "shared.css"), opts.page.sharedCss ?? "");
  writeFileSync(join(themeDir, "shared.js"), opts.page.sharedJs ?? "");
  writeFileSync(
    join(themeDir, "module-order.json"),
    JSON.stringify(opts.page.moduleOrder, null, 2),
  );

  const pageHtmlPath = join(dir, "page.html");
  writeFileSync(pageHtmlPath, renderFullPageHtml(opts.page));
  writeFileSync(join(dir, "metrics.json"), JSON.stringify(opts.metrics, null, 2));

  return { dir, pageHtmlPath, themeDir };
}
