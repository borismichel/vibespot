/**
 * State mutation functions for the active session.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ModuleFiles, GeneratedAssets } from "../../ai/engine.js";
import type { ChatMessage, TemplateEntry, SessionAsset, FieldDef } from "./types.js";
import { getSession, saveSession } from "./store.js";
import { getActiveTemplate } from "./templates.js";

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
}

/**
 * Sync changes from flat session fields back to the active template.
 * Called after any mutation to session.modules/sharedCss/etc.
 */
export function syncFlatFieldsToTemplate(): void {
  const activeSession = getSession();
  if (!activeSession) return;
  const tpl = getActiveTemplate();
  if (!tpl) return;
  tpl.modules = activeSession.modules;
  tpl.moduleOrder = activeSession.moduleOrder;
  tpl.sharedCss = activeSession.sharedCss;
  tpl.sharedJs = activeSession.sharedJs;
  tpl.template = activeSession.template;
  tpl.messages = activeSession.messages;
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
