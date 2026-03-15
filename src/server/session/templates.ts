/**
 * Multi-template management functions.
 */

import type { ModuleFiles } from "../../ai/engine.js";
import type { VibeSession, TemplateEntry, PageType } from "./types.js";
import { getSession } from "./store.js";
import { syncFlatFieldsFromTemplate } from "./state.js";

// ---------------------------------------------------------------------------
// Template management
// ---------------------------------------------------------------------------

/**
 * Migrate a legacy flat session (v0.3.0) into the templates array.
 * Called when loading a session that has modules but no templates.
 */
export function migrateSession(session: VibeSession): void {
  if (session.templates && session.templates.length > 0) return;
  if (!session.modules || session.modules.length === 0) {
    session.templates = [];
    session.activeTemplateId = "";
    return;
  }

  const templateId = `lp-${session.themeName}`;
  const entry: TemplateEntry = {
    id: templateId,
    label: `${session.themeName} Landing Page`,
    pageType: "landing_page",
    templateFile: `templates/lp-${session.themeName}.html`,
    modules: [...session.modules],
    moduleOrder: [...session.moduleOrder],
    sharedCss: session.sharedCss || "",
    sharedJs: session.sharedJs || "",
    template: session.template || "",
    messages: [...session.messages],
  };

  session.templates = [entry];
  session.activeTemplateId = templateId;
}

/**
 * Get the active template entry, or null if none set.
 */
export function getActiveTemplate(): TemplateEntry | null {
  const activeSession = getSession();
  if (!activeSession) return null;
  if (!activeSession.activeTemplateId || !activeSession.templates?.length) return null;
  return activeSession.templates.find((t) => t.id === activeSession!.activeTemplateId) || null;
}

/**
 * Set the active template by ID. Syncs flat fields from the template.
 */
export function setActiveTemplate(templateId: string): boolean {
  const activeSession = getSession();
  if (!activeSession) return false;
  const tpl = activeSession.templates.find((t) => t.id === templateId);
  if (!tpl) return false;

  activeSession.activeTemplateId = templateId;
  syncFlatFieldsFromTemplate(tpl);
  activeSession.updatedAt = Date.now();
  return true;
}

/**
 * Create a new template entry and add it to the session.
 */
export function addTemplate(pageType: PageType, label: string): TemplateEntry {
  const activeSession = getSession();
  if (!activeSession) throw new Error("No active session");

  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const prefix = pageType === "blog_post" ? "bp" :
                 pageType === "website_page" ? "wp" :
                 pageType === "module_only" ? "mo" : "lp";
  const id = `${prefix}-${slug}`;

  const entry: TemplateEntry = {
    id,
    label,
    pageType,
    templateFile: pageType === "module_only" ? "" : `templates/${id}.html`,
    modules: [],
    moduleOrder: [],
    sharedCss: "",
    sharedJs: "",
    template: "",
    messages: [],
  };

  activeSession.templates.push(entry);
  activeSession.activeTemplateId = id;
  syncFlatFieldsFromTemplate(entry);
  activeSession.updatedAt = Date.now();
  return entry;
}

/**
 * Clone an existing template, deep-copying modules and state.
 */
export function cloneTemplate(templateId: string, newLabel?: string): TemplateEntry | null {
  const activeSession = getSession();
  if (!activeSession) return null;
  const source = activeSession.templates.find((t) => t.id === templateId);
  if (!source) return null;

  const label = newLabel || `${source.label} (Copy)`;
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const prefix = source.pageType === "blog_post" ? "bp" :
                 source.pageType === "website_page" ? "wp" :
                 source.pageType === "module_only" ? "mo" : "lp";
  const id = `${prefix}-${slug}`;

  const entry: TemplateEntry = {
    id,
    label,
    pageType: source.pageType,
    templateFile: source.pageType === "module_only" ? "" : `templates/${id}.html`,
    modules: source.modules.map((m) => ({ ...m })), // shallow copy each module
    moduleOrder: [...source.moduleOrder],
    sharedCss: source.sharedCss,
    sharedJs: source.sharedJs,
    template: source.template,
    messages: [], // start fresh chat for clone
  };

  activeSession.templates.push(entry);
  activeSession.activeTemplateId = id;
  syncFlatFieldsFromTemplate(entry);
  activeSession.updatedAt = Date.now();
  return entry;
}

/**
 * Rename a template's display label.
 */
export function renameTemplate(templateId: string, newLabel: string): boolean {
  const activeSession = getSession();
  if (!activeSession) return false;
  const tpl = activeSession.templates.find((t) => t.id === templateId);
  if (!tpl) return false;
  tpl.label = newLabel;
  activeSession.updatedAt = Date.now();
  return true;
}

/**
 * Remove a template by ID.
 */
export function removeTemplate(templateId: string): boolean {
  const activeSession = getSession();
  if (!activeSession) return false;
  const idx = activeSession.templates.findIndex((t) => t.id === templateId);
  if (idx < 0) return false;

  activeSession.templates.splice(idx, 1);

  // If we removed the active template, switch to the first remaining one
  if (activeSession.activeTemplateId === templateId) {
    if (activeSession.templates.length > 0) {
      setActiveTemplate(activeSession.templates[0].id);
    } else {
      activeSession.activeTemplateId = "";
      activeSession.modules = [];
      activeSession.moduleOrder = [];
      activeSession.sharedCss = "";
      activeSession.sharedJs = "";
      activeSession.template = "";
      activeSession.messages = [];
    }
  }

  activeSession.updatedAt = Date.now();
  return true;
}

/**
 * Get deduplicated modules across all templates (the module library).
 */
export function getModuleLibrary(): Array<{ module: ModuleFiles; usedIn: string[] }> {
  const activeSession = getSession();
  if (!activeSession) return [];
  const map = new Map<string, { module: ModuleFiles; usedIn: string[] }>();

  for (const tpl of activeSession.templates) {
    for (const mod of tpl.modules) {
      const existing = map.get(mod.moduleName);
      if (existing) {
        existing.usedIn.push(tpl.label);
      } else {
        map.set(mod.moduleName, { module: mod, usedIn: [tpl.label] });
      }
    }
  }

  return Array.from(map.values());
}
