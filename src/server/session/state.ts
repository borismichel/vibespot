/**
 * State mutation functions for the active session.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ModuleFiles, GeneratedAssets } from "../../ai/engine.js";
import type { ChatMessage, TemplateEntry, SessionAsset, FieldDef, PageType } from "./types.js";
import { getSession, saveSession } from "./store.js";
import { getActiveTemplate, addTemplate, setActiveTemplate } from "./templates.js";
import { log } from "../log.js";

// ---------------------------------------------------------------------------
// Flat-field sync helpers (exported for use by templates.ts)
// ---------------------------------------------------------------------------

/**
 * Sync flat session fields from a template (compatibility layer).
 * Existing code reads session.modules, session.messages, etc.
 * This keeps those in sync with the active template.
 */
export function syncFlatFieldsFromTemplate(tpl: TemplateEntry): void {
  const activeSession = getSession();
  if (!activeSession) return;
  activeSession.modules = tpl.modules;
  activeSession.moduleOrder = tpl.moduleOrder;
  activeSession.sharedCss = tpl.sharedCss;
  activeSession.sharedJs = tpl.sharedJs;
  activeSession.template = tpl.template;
  activeSession.messages = tpl.messages;
  if (!activeSession.brandAssets) activeSession.brandAssets = {};
  activeSession.brandAssets.plan = tpl.plan;
}

/**
 * Sync changes from flat session fields back to the active template.
 * Called after any mutation to session.modules/sharedCss/etc.
 */
export function syncFlatFieldsToTemplate(): void {
  const activeSession = getSession();
  if (!activeSession) return;
  let tpl = getActiveTemplate();
  if (!tpl) {
    if (activeSession.modules.length === 0) return;
    // addTemplate() calls syncFlatFieldsFromTemplate() which wipes flat fields
    // to the new (empty) template. Save and restore so existing modules survive.
    const saved = {
      modules: activeSession.modules,
      moduleOrder: activeSession.moduleOrder,
      sharedCss: activeSession.sharedCss,
      sharedJs: activeSession.sharedJs,
      template: activeSession.template,
      messages: activeSession.messages,
      plan: activeSession.brandAssets?.plan,
    };
    tpl = addTemplate("landing_page", `${activeSession.themeName} Landing Page`);
    activeSession.activeTemplateId = tpl.id;
    activeSession.modules = saved.modules;
    activeSession.moduleOrder = saved.moduleOrder;
    activeSession.sharedCss = saved.sharedCss;
    activeSession.sharedJs = saved.sharedJs;
    activeSession.template = saved.template;
    activeSession.messages = saved.messages;
    if (activeSession.brandAssets) activeSession.brandAssets.plan = saved.plan;
  }
  tpl.modules = activeSession.modules;
  tpl.moduleOrder = activeSession.moduleOrder;
  tpl.sharedCss = activeSession.sharedCss;
  tpl.sharedJs = activeSession.sharedJs;
  tpl.template = activeSession.template;
  tpl.messages = activeSession.messages;
  tpl.plan = activeSession.brandAssets?.plan;
}

// ---------------------------------------------------------------------------
// Message management
// ---------------------------------------------------------------------------

export function addMessage(role: "user" | "assistant", content: string, pipeline?: import("./types.js").PipelineMetadata): void {
  const activeSession = getSession();
  if (!activeSession) return;
  const msg: import("./types.js").ChatMessage = { role, content, timestamp: Date.now() };
  if (pipeline) msg.pipeline = pipeline;
  activeSession.messages.push(msg);
  activeSession.updatedAt = Date.now();
  syncFlatFieldsToTemplate();
  saveChatToTheme();
}

export function addSessionAsset(asset: SessionAsset): void {
  const activeSession = getSession();
  if (!activeSession) return;
  if (!activeSession.assets) activeSession.assets = [];
  activeSession.assets.push(asset);
  activeSession.updatedAt = Date.now();
  saveSession();
}

// ---------------------------------------------------------------------------
// Module mutations
// ---------------------------------------------------------------------------

/**
 * Normalize a module name for similarity matching: lowercase, strip
 * dashes, underscores, and whitespace.
 */
function normalizeForSimilarity(name: string): string {
  return name.toLowerCase().replace(/[\s\-_]+/g, "");
}

/**
 * Heuristic: are two module names likely the SAME module under different
 * naming conventions? Catches:
 *   - case variants:   "how-it-works" vs "How It Works" → both "howitworks"
 *   - prefix renames:  "hero" vs "Hero Field Journal" → "hero" prefix of "herofieldjournal"
 *   - suffix renames:  "footer" vs "page-footer" → "footer" suffix
 * Used only for warnings — never to merge modules automatically.
 */
function isSimilarModuleName(a: string, b: string): boolean {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (na === nb) return true;
  if (na.length < 4 || nb.length < 4) return false;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (!longer.includes(shorter)) return false;
  return shorter.length / longer.length >= 0.8;
}

/**
 * Update session with newly generated/modified modules.
 * Merges new modules into existing state (updates existing, adds new).
 */
export function updateModules(assets: Partial<GeneratedAssets>): void {
  const activeSession = getSession();
  if (!activeSession) return;

  if (assets.sharedCss !== undefined) activeSession.sharedCss = assets.sharedCss;
  if (assets.sharedJs !== undefined) activeSession.sharedJs = assets.sharedJs;
  if (assets.template !== undefined) activeSession.template = assets.template;

  if (assets.modules) {
    for (const newMod of assets.modules) {
      const newNameLower = newMod.moduleName.toLowerCase();
      const idx = activeSession.modules.findIndex(
        (m) => m.moduleName.toLowerCase() === newNameLower
      );
      if (idx >= 0) {
        activeSession.modules[idx] = newMod;
      } else {
        // Defensive: if the arriving name is a "case/format variant" of an
        // existing module (kebab vs Title Case, etc.), this is almost
        // certainly a planner/developer drift bug — the AI re-named an
        // existing module instead of regenerating it. Log a warning so
        // future divergences surface in logs even before they show up
        // as duplicate modules in the UI.
        const similar = activeSession.modules.find((m) =>
          isSimilarModuleName(m.moduleName, newMod.moduleName)
        );
        if (similar) {
          log.warn(
            "session-state",
            `Module "${newMod.moduleName}" looks like a renamed variant of existing "${similar.moduleName}" — adding as a new module. This usually indicates the Module Planner re-named an existing module. Check the prompt's "preserve existing names" rule.`,
          );
        }

        activeSession.modules.push(newMod);
        if (!activeSession.moduleOrder.some((n) => n.toLowerCase() === newNameLower)) {
          activeSession.moduleOrder.push(newMod.moduleName);
        }
      }
    }
  }

  activeSession.updatedAt = Date.now();
  syncFlatFieldsToTemplate();
}

/**
 * Reorder modules (used by drag-and-drop in the UI).
 */
export function reorderModules(newOrder: string[]): void {
  const activeSession = getSession();
  if (!activeSession) return;
  activeSession.moduleOrder = newOrder;
  activeSession.updatedAt = Date.now();
  syncFlatFieldsToTemplate();
}

/**
 * Remove a module by name.
 */
export function removeModule(moduleName: string): void {
  const activeSession = getSession();
  if (!activeSession) return;
  activeSession.modules = activeSession.modules.filter(
    (m) => m.moduleName !== moduleName
  );
  activeSession.moduleOrder = activeSession.moduleOrder.filter(
    (n) => n !== moduleName
  );

  // Also remove from all templates
  for (const tpl of activeSession.templates) {
    tpl.modules = tpl.modules.filter((m) => m.moduleName !== moduleName);
    tpl.moduleOrder = tpl.moduleOrder.filter((n) => n !== moduleName);
  }

  // Delete module directory from disk
  if (activeSession.themePath) {
    const modDir = join(activeSession.themePath, "modules", `${moduleName}.module`);
    if (existsSync(modDir)) rmSync(modDir, { recursive: true, force: true });
  }

  activeSession.updatedAt = Date.now();
  syncFlatFieldsToTemplate();
}

/**
 * Detach a module from the current template (remove from moduleOrder only).
 * The module data stays in the session so it can be re-added later.
 */
export function detachModule(moduleName: string): void {
  const activeSession = getSession();
  if (!activeSession) return;
  activeSession.moduleOrder = activeSession.moduleOrder.filter(
    (n) => n !== moduleName
  );
  activeSession.updatedAt = Date.now();
  syncFlatFieldsToTemplate();
}

/**
 * Update a single field value in a module's fields.json.
 * Used by the field editor sidebar.
 */
export function updateFieldValue(
  moduleName: string,
  fieldPath: string,
  value: unknown
): void {
  const activeSession = getSession();
  if (!activeSession) return;

  const mod = activeSession.modules.find((m) => m.moduleName === moduleName);
  if (!mod) return;

  try {
    const fields = JSON.parse(mod.fieldsJson);
    setFieldDefault(fields, fieldPath, value);
    mod.fieldsJson = JSON.stringify(fields, null, 2);
    activeSession.updatedAt = Date.now();
    syncFlatFieldsToTemplate();
  } catch {
    // Invalid JSON — skip
  }
}

/**
 * Get modules in display order.
 */
export function getOrderedModules(): ModuleFiles[] {
  const activeSession = getSession();
  if (!activeSession) return [];

  const ordered: ModuleFiles[] = [];
  for (const name of activeSession.moduleOrder) {
    const mod = activeSession.modules.find((m) => m.moduleName === name);
    if (mod) ordered.push(mod);
  }

  // Append any modules not in the order list
  for (const mod of activeSession.modules) {
    if (!activeSession.moduleOrder.includes(mod.moduleName)) {
      ordered.push(mod);
    }
  }

  return ordered;
}

// ---------------------------------------------------------------------------
// Chat persistence — store chat in theme directory
// ---------------------------------------------------------------------------

/**
 * Persist chat to {themePath}/.vibespot/chat.json (gitignored).
 */
export function saveChatToTheme(): void {
  const activeSession = getSession();
  if (!activeSession) return;
  try {
    const chatDir = join(activeSession.themePath, ".vibespot");
    mkdirSync(chatDir, { recursive: true });
    const chatData = {
      sessionId: activeSession.id,
      themeName: activeSession.themeName,
      messages: activeSession.messages,
      updatedAt: Date.now(),
    };
    writeFileSync(join(chatDir, "chat.json"), JSON.stringify(chatData, null, 2), "utf-8");
  } catch {
    // Non-critical — don't block on chat persistence errors
  }
}

/**
 * Load chat history from a theme's .vibespot/chat.json.
 */
export function loadChatFromTheme(themePath: string): ChatMessage[] {
  const chatPath = join(themePath, ".vibespot", "chat.json");
  if (!existsSync(chatPath)) return [];
  try {
    const data = JSON.parse(readFileSync(chatPath, "utf-8"));
    return Array.isArray(data.messages) ? data.messages : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Multi-page result handler
// ---------------------------------------------------------------------------

export interface MultiPageResultInput {
  pages: {
    pageId: string;
    templateId: string;
    modules: ModuleFiles[];
    moduleOrder: string[];
  }[];
  sharedModules: ModuleFiles[];
  sharedCss: string;
  sharedJs: string;
  pageLabels: Map<string, { label: string; pageType: PageType }>;
}

export function applyMultiPageResult(result: MultiPageResultInput): void {
  const activeSession = getSession();
  if (!activeSession) return;

  // Sync shared CSS/JS to ALL existing templates
  for (const tpl of activeSession.templates) {
    tpl.sharedCss = result.sharedCss;
    tpl.sharedJs = result.sharedJs;
  }
  activeSession.sharedCss = result.sharedCss;
  activeSession.sharedJs = result.sharedJs;

  // Create or update template entries for each page
  for (const page of result.pages) {
    const meta = result.pageLabels.get(page.pageId);
    const label = meta?.label || page.pageId;
    const pageType = meta?.pageType || "website_page";

    let tpl = activeSession.templates.find((t) => t.id === page.templateId);

    if (!tpl) {
      tpl = addTemplate(pageType, label);
      tpl.id = page.templateId;
      tpl.templateFile = `templates/${page.templateId}.html`;
    }

    tpl.modules = page.modules;
    tpl.moduleOrder = page.moduleOrder;
    tpl.sharedCss = result.sharedCss;
    tpl.sharedJs = result.sharedJs;
  }

  // Activate the first page
  if (result.pages.length > 0) {
    setActiveTemplate(result.pages[0].templateId);
  }

  activeSession.updatedAt = Date.now();
}

export function syncSharedCssToAllTemplates(): void {
  const activeSession = getSession();
  if (!activeSession) return;

  const sharedCss = activeSession.sharedCss;
  const sharedJs = activeSession.sharedJs;

  for (const tpl of activeSession.templates) {
    tpl.sharedCss = sharedCss;
    tpl.sharedJs = sharedJs;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Set a default value at a dot-separated field path in a fields.json array.
 */
function setFieldDefault(fields: FieldDef[], path: string, value: unknown): void {
  const parts = path.split(".");
  const fieldName = parts[0];
  const field = fields.find((f: FieldDef) => f.name === fieldName);
  if (!field) return;

  if (parts.length === 1) {
    field.default = value;
  } else if (field.children) {
    setFieldDefault(field.children, parts.slice(1).join("."), value);
  }
}
