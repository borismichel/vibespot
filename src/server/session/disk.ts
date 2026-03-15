/**
 * Theme disk I/O — reading from and writing to theme directories.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ModuleFiles } from "../../ai/engine.js";
import type { ChatMessage, TemplateEntry, PageType } from "./types.js";
import { getSession } from "./store.js";
import { getOrderedModules, syncFlatFieldsFromTemplate, syncFlatFieldsToTemplate, loadChatFromTheme } from "./state.js";
import { getActiveTemplate, migrateSession } from "./templates.js";
import { ensureGitRepo } from "../project-git.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Get modules in display order for a specific template entry.
 */
function getOrderedModulesFrom(tpl: TemplateEntry): ModuleFiles[] {
  const ordered: ModuleFiles[] = [];
  for (const name of tpl.moduleOrder) {
    const mod = tpl.modules.find((m) => m.moduleName === name);
    if (mod) ordered.push(mod);
  }
  for (const mod of tpl.modules) {
    if (!tpl.moduleOrder.includes(mod.moduleName)) {
      ordered.push(mod);
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Template file parsing
// ---------------------------------------------------------------------------

interface ParsedTemplate {
  id: string;
  label: string;
  pageType: PageType;
  moduleNames: string[];
  templateContent: string;
  filename: string;
}

/**
 * Parse a single HubL template file to extract metadata and module references.
 */
function parseTemplateFile(filePath: string, filename: string): ParsedTemplate | null {
  const content = safeRead(filePath);
  if (!content) return null;

  // Skip scaffold placeholder and listing templates
  if (filename === "home.html" || filename.endsWith("-listing.html")) return null;

  // Infer ID from filename (strip .html)
  const id = filename.replace(/\.html$/, "");

  // Infer pageType from prefix
  let pageType: PageType = "landing_page";
  if (id.startsWith("bp-")) pageType = "blog_post";
  else if (id.startsWith("wp-")) pageType = "website_page";
  else if (id.startsWith("mo-")) pageType = "module_only";

  // Extract label from HubL comment metadata
  let label = id;
  const labelMatch = content.match(/<!--[\s\S]*?label:\s*"?([^"\n]+)"?\s*[\s\S]*?-->/);
  if (labelMatch) {
    label = labelMatch[1].trim();
  }

  // Extract module references from dnd_module tags
  const moduleRe = /dnd_module\s+path=["']\.\.\/modules\/(.+?)\.module["']/g;
  const moduleNames: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = moduleRe.exec(content)) !== null) {
    moduleNames.push(match[1]);
  }

  return { id, label, pageType, moduleNames, templateContent: content, filename };
}

/**
 * Scan the templates directory and create TemplateEntry objects for each template file.
 * Returns an empty array if no valid template files are found.
 */
function scanTemplateFiles(
  templatesDir: string,
  modulesByName: Map<string, ModuleFiles>,
  sharedCss: string,
  sharedJs: string,
  chatMessages: ChatMessage[],
): TemplateEntry[] {
  if (!existsSync(templatesDir)) return [];

  const entries: TemplateEntry[] = [];
  const allFiles = readdirSync(templatesDir).filter(
    (f) => f.endsWith(".html") && f !== "home.html"
  );

  // Filter out layout files (in subdirectories) — only direct children
  for (const filename of allFiles) {
    const filePath = join(templatesDir, filename);
    const parsed = parseTemplateFile(filePath, filename);
    if (!parsed) continue;
    if (parsed.moduleNames.length === 0 && entries.length > 0) continue; // skip empty templates if we have others

    // Build module list for this template
    const templateModules: ModuleFiles[] = [];
    const templateOrder: string[] = [];
    for (const name of parsed.moduleNames) {
      const mod = modulesByName.get(name);
      if (mod) {
        templateModules.push(mod);
        templateOrder.push(name);
      }
    }

    entries.push({
      id: parsed.id,
      label: parsed.label,
      pageType: parsed.pageType,
      templateFile: `templates/${parsed.filename}`,
      modules: templateModules,
      moduleOrder: templateOrder,
      sharedCss,
      sharedJs,
      template: parsed.templateContent,
      messages: entries.length === 0 ? [...chatMessages] : [], // chat history goes to first template
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Scan modules from disk (for loading existing themes)
// ---------------------------------------------------------------------------

/**
 * Scan a theme directory on disk and load existing modules into the session.
 */
export function scanThemeFromDisk(themePath: string): void {
  const activeSession = getSession();
  if (!activeSession) return;

  // Load persisted chat from theme directory (if session has no messages yet)
  const chatFromDisk = loadChatFromTheme(themePath);
  if (chatFromDisk.length > 0 && activeSession.messages.length === 0) {
    activeSession.messages = chatFromDisk;
  }

  // Ensure git repo exists (handles themes created before this feature)
  ensureGitRepo(themePath);

  const modulesDir = join(themePath, "modules");
  if (!existsSync(modulesDir)) return;

  const entries = readdirSync(modulesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".module")) continue;

    const modDir = join(modulesDir, entry.name);
    const moduleName = entry.name.replace(/\.module$/, "");

    const mod: ModuleFiles = {
      moduleName,
      fieldsJson: safeRead(join(modDir, "fields.json")),
      metaJson: safeRead(join(modDir, "meta.json")),
      moduleHtml: safeRead(join(modDir, "module.html")),
      moduleCss: safeRead(join(modDir, "module.css")),
      moduleJs: safeRead(join(modDir, "module.js")) || undefined,
    };

    if (mod.fieldsJson && mod.moduleHtml) {
      activeSession.modules.push(mod);
      activeSession.moduleOrder.push(moduleName);
    }
  }

  // Load shared CSS/JS
  const cssDir = join(themePath, "css");
  const jsDir = join(themePath, "js");
  let sharedCss = "";
  let sharedJs = "";

  if (existsSync(cssDir)) {
    const cssFiles = readdirSync(cssDir).filter(
      (f) => f.endsWith("-theme.css")
    );
    if (cssFiles.length > 0) {
      sharedCss = safeRead(join(cssDir, cssFiles[0]));
      activeSession.sharedCss = sharedCss;
    }
  }

  if (existsSync(jsDir)) {
    const jsFiles = readdirSync(jsDir).filter(
      (f) => f.endsWith("-animations.js")
    );
    if (jsFiles.length > 0) {
      sharedJs = safeRead(join(jsDir, jsFiles[0]));
      activeSession.sharedJs = sharedJs;
    }
  }

  // Load brand assets from .vibespot/ directory
  const sgPath = join(themePath, ".vibespot", "styleguide.md");
  const bvPath = join(themePath, ".vibespot", "brandvoice.md");
  if (existsSync(sgPath) || existsSync(bvPath)) {
    if (!activeSession.brandAssets) activeSession.brandAssets = {};
    if (existsSync(sgPath)) activeSession.brandAssets.styleguide = safeRead(sgPath);
    if (existsSync(bvPath)) activeSession.brandAssets.brandvoice = safeRead(bvPath);
  }

  // Scan template files and create per-template TemplateEntry objects
  const templatesDir = join(themePath, "templates");
  const modulesByName = new Map(activeSession.modules.map((m) => [m.moduleName, m]));
  const parsedTemplates = scanTemplateFiles(templatesDir, modulesByName, sharedCss, sharedJs, activeSession.messages);

  if (parsedTemplates.length > 0) {
    activeSession.templates = parsedTemplates;
    activeSession.activeTemplateId = parsedTemplates[0].id;

    // Reorder flat modules to match the first template's order
    const firstOrder = parsedTemplates[0].moduleOrder;
    if (firstOrder.length > 0) {
      const loadedNames = new Set(activeSession.moduleOrder);
      const validOrder = firstOrder.filter((n) => loadedNames.has(n));
      for (const n of activeSession.moduleOrder) {
        if (!validOrder.includes(n)) validOrder.push(n);
      }
      activeSession.moduleOrder = validOrder;
    }

    syncFlatFieldsFromTemplate(parsedTemplates[0]);
  } else {
    // No template files found — fall back to legacy single-template migration
    if (!activeSession.templates) activeSession.templates = [];
    if (!activeSession.activeTemplateId) activeSession.activeTemplateId = "";
    migrateSession(activeSession);
  }
}

// ---------------------------------------------------------------------------
// Write modules back to disk (for upload)
// ---------------------------------------------------------------------------

export function writeModulesToDisk(): void {
  const activeSession = getSession();
  if (!activeSession) return;

  const themePath = activeSession.themePath;

  // Collect all modules from all templates (deduplicated by name)
  const allModules = new Map<string, ModuleFiles>();
  if (activeSession.templates.length > 0) {
    for (const tpl of activeSession.templates) {
      for (const mod of tpl.modules) {
        allModules.set(mod.moduleName, mod);
      }
    }
  }
  // Also include flat session modules (backward compat / active template)
  for (const mod of activeSession.modules) {
    allModules.set(mod.moduleName, mod);
  }

  // Pre-create all module directories in one pass
  const modulesBaseDir = join(themePath, "modules");
  mkdirSync(modulesBaseDir, { recursive: true });
  for (const mod of allModules.values()) {
    mkdirSync(join(modulesBaseDir, `${mod.moduleName}.module`), { recursive: true });
  }

  for (const mod of allModules.values()) {
    const modDir = join(modulesBaseDir, `${mod.moduleName}.module`);
    writeFileSync(join(modDir, "fields.json"), mod.fieldsJson, "utf-8");
    writeFileSync(join(modDir, "meta.json"), mod.metaJson, "utf-8");
    writeFileSync(join(modDir, "module.html"), mod.moduleHtml, "utf-8");
    writeFileSync(join(modDir, "module.css"), mod.moduleCss, "utf-8");
    if (mod.moduleJs) {
      writeFileSync(join(modDir, "module.js"), mod.moduleJs, "utf-8");
    }
  }

  // Write shared CSS/JS
  if (activeSession.sharedCss) {
    const cssDir = join(themePath, "css");
    mkdirSync(cssDir, { recursive: true });
    writeFileSync(
      join(cssDir, `${activeSession.themeName}-theme.css`),
      activeSession.sharedCss,
      "utf-8"
    );
  }

  if (activeSession.sharedJs) {
    const jsDir = join(themePath, "js");
    mkdirSync(jsDir, { recursive: true });
    writeFileSync(
      join(jsDir, `${activeSession.themeName}-animations.js`),
      activeSession.sharedJs,
      "utf-8"
    );
  }

  // Write page templates for all templates in the session
  const templatesDir = join(themePath, "templates");
  mkdirSync(templatesDir, { recursive: true });

  // Remove scaffold home.html once real templates exist — it's an empty shell
  // that shows up as a usable template in HubSpot but has no modules.
  const scaffoldHome = join(templatesDir, "home.html");
  const hasRealTemplates = activeSession.templates.length > 0 || activeSession.modules.length > 0;
  if (hasRealTemplates && existsSync(scaffoldHome)) {
    rmSync(scaffoldHome, { force: true });
  }

  // Track which template files we're writing so we can clean up stale ones
  const activeTemplateFiles = new Set<string>();

  if (activeSession.templates.length > 0) {
    for (const tpl of activeSession.templates) {
      if (tpl.pageType === "module_only") continue; // No template for module-only
      if (tpl.modules.length === 0) continue;

      const templateContent = tpl.template || generateTemplateForEntry(tpl);
      const annotated = ensureTemplateAnnotations(templateContent, tpl.label, tpl.pageType);
      const filename = `${tpl.id}.html`;
      writeFileSync(join(templatesDir, filename), annotated, "utf-8");
      activeTemplateFiles.add(filename);

      // For blog posts, also generate a listing template
      if (tpl.pageType === "blog_post") {
        writeBlogListingTemplate(templatesDir, tpl);
        activeTemplateFiles.add(`${tpl.id}-listing.html`);
      }
    }
  } else if (activeSession.modules.length > 0) {
    // Legacy fallback: single template from flat fields
    const template = activeSession.template || generateTemplateFromModules();
    const annotated = ensureTemplateAnnotations(template, `${activeSession.themeName} Landing Page`);
    const filename = `lp-${activeSession.themeName}.html`;
    writeFileSync(join(templatesDir, filename), annotated, "utf-8");
    activeTemplateFiles.add(filename);
  }

  // Clean up stale lp-*.html template files that are no longer in the session
  try {
    for (const file of readdirSync(templatesDir)) {
      if (file.startsWith("lp-") && file.endsWith(".html") && !activeTemplateFiles.has(file)) {
        rmSync(join(templatesDir, file), { force: true });
      }
    }
  } catch { /* non-critical */ }

  // Patch base.html to load template_js (animations won't work without this)
  patchBaseTemplate();

  // Populate theme.json with proper metadata
  updateThemeJson();
}

// ---------------------------------------------------------------------------
// Reload from disk
// ---------------------------------------------------------------------------

/**
 * Clear in-memory modules and re-scan from disk.
 * Used after a git rollback to sync session state with restored files.
 */
export function reloadModulesFromDisk(): void {
  const activeSession = getSession();
  if (!activeSession) return;
  activeSession.modules = [];
  activeSession.moduleOrder = [];
  activeSession.sharedCss = "";
  activeSession.sharedJs = "";
  activeSession.template = "";
  scanThemeFromDisk(activeSession.themePath);
  activeSession.updatedAt = Date.now();
  syncFlatFieldsToTemplate();
}

/**
 * Reload only the active template's modules from disk.
 * Used after a scoped rollback to avoid affecting other templates.
 */
export function reloadActiveTemplateFromDisk(): void {
  const activeSession = getSession();
  if (!activeSession) return;
  const tpl = getActiveTemplate();
  if (!tpl) return;

  const themePath = activeSession.themePath;
  const modulesDir = join(themePath, "modules");

  // Reload modules that belong to this template
  tpl.modules = [];
  for (const name of tpl.moduleOrder) {
    const modDir = join(modulesDir, `${name}.module`);
    if (!existsSync(modDir)) continue;
    const mod: ModuleFiles = {
      moduleName: name,
      fieldsJson: safeRead(join(modDir, "fields.json")),
      metaJson: safeRead(join(modDir, "meta.json")),
      moduleHtml: safeRead(join(modDir, "module.html")),
      moduleCss: safeRead(join(modDir, "module.css")),
      moduleJs: safeRead(join(modDir, "module.js")) || undefined,
    };
    if (mod.fieldsJson && mod.moduleHtml) {
      tpl.modules.push(mod);
    }
  }

  // Reload template file
  if (tpl.templateFile) {
    const tplPath = join(themePath, tpl.templateFile);
    if (existsSync(tplPath)) {
      tpl.template = safeRead(tplPath);
    }
  }

  // Sync flat fields from the updated template
  syncFlatFieldsFromTemplate(tpl);
  activeSession.updatedAt = Date.now();
}

// ---------------------------------------------------------------------------
// Theme metadata — populate theme.json + validate template annotations
// ---------------------------------------------------------------------------

/**
 * Patch base.html to load template_js (the boilerplate only loads template_css).
 * Without this, shared animations JS never runs and scroll-animate elements stay invisible.
 */
function patchBaseTemplate(): void {
  const activeSession = getSession();
  if (!activeSession) return;
  const basePath = join(activeSession.themePath, "templates", "layouts", "base.html");
  if (!existsSync(basePath)) return;

  try {
    let content = readFileSync(basePath, "utf-8");
    // Already patched?
    if (content.includes("template_js")) return;

    // Insert {% if template_js %} block right after the main.js require line
    const mainJsLine = '{{ require_js(get_asset_url("../../js/main.js")) }}';
    if (content.includes(mainJsLine)) {
      content = content.replace(
        mainJsLine,
        mainJsLine + '\n    {% if template_js %}\n      {{ require_js(get_asset_url(template_js)) }}\n    {% endif %}'
      );
    } else {
      // Fallback: insert before standard_footer_includes
      content = content.replace(
        "{{ standard_footer_includes }}",
        '{% if template_js %}\n      {{ require_js(get_asset_url(template_js)) }}\n    {% endif %}\n    {{ standard_footer_includes }}'
      );
    }

    writeFileSync(basePath, content, "utf-8");
  } catch {
    // Non-critical — the generated template has its own require_js fallback
  }
}

/**
 * Update theme.json with proper name/label and ensure template annotations.
 * Called during writeModulesToDisk.
 */
function updateThemeJson(): void {
  const activeSession = getSession();
  if (!activeSession) return;
  const themeJsonPath = join(activeSession.themePath, "theme.json");
  if (!existsSync(themeJsonPath)) return;

  try {
    const themeData = JSON.parse(readFileSync(themeJsonPath, "utf-8"));
    themeData.label = activeSession.themeName;
    themeData.name = activeSession.themeName;
    writeFileSync(themeJsonPath, JSON.stringify(themeData, null, 2), "utf-8");
  } catch {
    // Non-critical
  }
}

/**
 * Ensure the page template has proper HubSpot annotations.
 */
function ensureTemplateAnnotations(templateContent: string, label: string, pageType: PageType = "landing_page"): string {
  // Check if annotations already exist
  if (templateContent.includes("templateType")) return templateContent;

  const templateType = pageType === "blog_post" ? "blog_post" : "page";
  const annotations = `<!--
  templateType: ${templateType}
  isAvailableForNewContent: true
  label: "${label}"
-->\n`;
  return annotations + templateContent;
}

// ---------------------------------------------------------------------------
// Template generation — build page templates from module data
// ---------------------------------------------------------------------------

/**
 * Build a HubSpot page template for a specific TemplateEntry.
 */
function generateTemplateForEntry(tpl: TemplateEntry): string {
  if (tpl.modules.length === 0) return "";

  const activeSession = getSession()!;
  const name = activeSession.themeName;
  const ordered = getOrderedModulesFrom(tpl);

  const sections = ordered.map((mod) => {
    return `    {% dnd_section padding={"top":"0","bottom":"0","left":"0","right":"0"}, full_width=true %}
      {% dnd_module path="../modules/${mod.moduleName}.module" %}
      {% end_dnd_module %}
    {% end_dnd_section %}`;
  }).join("\n\n");

  const templateType = tpl.pageType === "blog_post" ? "blog_post" : "page";

  return `<!--
  templateType: ${templateType}
  isAvailableForNewContent: true
  label: "${tpl.label}"
-->
{% extends "./layouts/base.html" %}

{% set template_css = "../../css/${name}-theme.css" %}
{% set template_js = "../../js/${name}-animations.js" %}

{% block header %}
{% endblock header %}

{% block body %}
<div class="${name}-page">
  {% dnd_area "main_content" label="${tpl.label}" %}

${sections}

  {% end_dnd_area %}
</div>
{{ require_js(get_asset_url("../../js/${name}-animations.js")) }}
{% endblock body %}

{% block footer %}
{% endblock footer %}
`;
}

/**
 * Write a blog listing template alongside a blog post template.
 */
function writeBlogListingTemplate(templatesDir: string, tpl: TemplateEntry): void {
  const listingContent = `<!--
  templateType: blog_listing
  isAvailableForNewContent: true
  label: "${tpl.label} - Listing"
-->
{% extends "./layouts/base.html" %}

{% block body %}
<div class="blog-listing">
  <h1>{{ group.public_title }}</h1>
  {% for content in contents %}
  <article class="blog-listing__post">
    <h2><a href="{{ content.absolute_url }}">{{ content.name }}</a></h2>
    {% if content.featured_image %}
    <img src="{{ content.featured_image }}" alt="{{ content.featured_image_alt_text }}">
    {% endif %}
    <p>{{ content.post_summary|truncatewords(30) }}</p>
    <span class="blog-listing__date">{{ content.publish_date|datetimeformat('%B %d, %Y') }}</span>
  </article>
  {% endfor %}
  {% if next_page_num %}
  <a href="{{ next_page_url }}">Next Page</a>
  {% endif %}
</div>
{% endblock body %}
`;
  writeFileSync(
    join(templatesDir, `${tpl.id}-listing.html`),
    listingContent,
    "utf-8"
  );
}

/**
 * Build a HubSpot page template that assembles all modules in display order.
 * Legacy — used when no templates array exists (flat session).
 */
function generateTemplateFromModules(): string {
  const activeSession = getSession();
  if (!activeSession || activeSession.modules.length === 0) return "";

  const name = activeSession.themeName;
  const ordered = getOrderedModules();

  const sections = ordered.map((mod) => {
    return `    {% dnd_section padding={"top":"0","bottom":"0","left":"0","right":"0"}, full_width=true %}
      {% dnd_module path="../modules/${mod.moduleName}.module" %}
      {% end_dnd_module %}
    {% end_dnd_section %}`;
  }).join("\n\n");

  return `<!--
  templateType: page
  isAvailableForNewContent: true
  label: "${name} Landing Page"
-->
{% extends "./layouts/base.html" %}

{% set template_css = "../../css/${name}-theme.css" %}
{% set template_js = "../../js/${name}-animations.js" %}

{% block header %}
{% endblock header %}

{% block body %}
<div class="${name}-page">
  {% dnd_area "main_content" label="${name} Landing Page" %}

${sections}

  {% end_dnd_area %}
</div>
{{ require_js(get_asset_url("../../js/${name}-animations.js")) }}
{% endblock body %}

{% block footer %}
{% endblock footer %}
`;
}
