/**
 * Session state for the vibe coding workspace.
 * Tracks conversation history, generated modules, and theme state.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { ModuleFiles, GeneratedAssets } from "../ai/engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface VibeSession {
  id: string;
  themePath: string;
  themeName: string;
  messages: ChatMessage[];
  modules: ModuleFiles[];
  sharedCss: string;
  sharedJs: string;
  template: string;
  moduleOrder: string[]; // module names in display order
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const SESSIONS_DIR = join(homedir(), ".vibespot", "sessions");

let activeSession: VibeSession | null = null;

export function createSession(themePath: string, themeName: string): VibeSession {
  const session: VibeSession = {
    id: generateId(),
    themePath,
    themeName,
    messages: [],
    modules: [],
    sharedCss: "",
    sharedJs: "",
    template: "",
    moduleOrder: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  activeSession = session;
  return session;
}

export function getSession(): VibeSession | null {
  return activeSession;
}

export function addMessage(role: "user" | "assistant", content: string): void {
  if (!activeSession) return;
  activeSession.messages.push({ role, content, timestamp: Date.now() });
  activeSession.updatedAt = Date.now();
}

/**
 * Update session with newly generated/modified modules.
 * Merges new modules into existing state (updates existing, adds new).
 */
export function updateModules(assets: Partial<GeneratedAssets>): void {
  if (!activeSession) return;

  if (assets.sharedCss !== undefined) activeSession.sharedCss = assets.sharedCss;
  if (assets.sharedJs !== undefined) activeSession.sharedJs = assets.sharedJs;
  if (assets.template !== undefined) activeSession.template = assets.template;

  if (assets.modules) {
    for (const newMod of assets.modules) {
      const idx = activeSession.modules.findIndex(
        (m) => m.moduleName === newMod.moduleName
      );
      if (idx >= 0) {
        activeSession.modules[idx] = newMod;
      } else {
        activeSession.modules.push(newMod);
        activeSession.moduleOrder.push(newMod.moduleName);
      }
    }
  }

  activeSession.updatedAt = Date.now();
}

/**
 * Reorder modules (used by drag-and-drop in the UI).
 */
export function reorderModules(newOrder: string[]): void {
  if (!activeSession) return;
  activeSession.moduleOrder = newOrder;
  activeSession.updatedAt = Date.now();
}

/**
 * Remove a module by name.
 */
export function removeModule(moduleName: string): void {
  if (!activeSession) return;
  activeSession.modules = activeSession.modules.filter(
    (m) => m.moduleName !== moduleName
  );
  activeSession.moduleOrder = activeSession.moduleOrder.filter(
    (n) => n !== moduleName
  );
  activeSession.updatedAt = Date.now();
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
  if (!activeSession) return;

  const mod = activeSession.modules.find((m) => m.moduleName === moduleName);
  if (!mod) return;

  try {
    const fields = JSON.parse(mod.fieldsJson);
    setFieldDefault(fields, fieldPath, value);
    mod.fieldsJson = JSON.stringify(fields, null, 2);
    activeSession.updatedAt = Date.now();
  } catch {
    // Invalid JSON — skip
  }
}

/**
 * Get modules in display order.
 */
export function getOrderedModules(): ModuleFiles[] {
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
// Scan modules from disk (for loading existing themes)
// ---------------------------------------------------------------------------

/**
 * Scan a theme directory on disk and load existing modules into the session.
 */
export function scanThemeFromDisk(themePath: string): void {
  if (!activeSession) return;

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

  if (existsSync(cssDir)) {
    const cssFiles = readdirSync(cssDir).filter(
      (f) => f.endsWith("-theme.css") || f.endsWith("-theme.css")
    );
    if (cssFiles.length > 0) {
      activeSession.sharedCss = safeRead(join(cssDir, cssFiles[0]));
    }
  }

  if (existsSync(jsDir)) {
    const jsFiles = readdirSync(jsDir).filter(
      (f) => f.endsWith("-animations.js")
    );
    if (jsFiles.length > 0) {
      activeSession.sharedJs = safeRead(join(jsDir, jsFiles[0]));
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence — save/load sessions across restarts
// ---------------------------------------------------------------------------

export function saveSession(): void {
  if (!activeSession) return;

  mkdirSync(SESSIONS_DIR, { recursive: true });
  const filePath = join(SESSIONS_DIR, `${activeSession.id}.json`);
  writeFileSync(filePath, JSON.stringify(activeSession, null, 2), "utf-8");
}

export function loadSession(sessionId: string): VibeSession | null {
  const filePath = join(SESSIONS_DIR, sessionId + ".json");
  if (!existsSync(filePath)) return null;

  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    activeSession = data;
    return data;
  } catch {
    return null;
  }
}

export function listSessions(): Array<{ id: string; themeName: string; updatedAt: number }> {
  if (!existsSync(SESSIONS_DIR)) return [];

  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
        return { id: data.id, themeName: data.themeName, updatedAt: data.updatedAt };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ id: string; themeName: string; updatedAt: number }>;
}

export function deleteSession(sessionId: string, deleteFiles = false): void {
  const filePath = join(SESSIONS_DIR, sessionId + ".json");

  if (deleteFiles) {
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      if (data.themePath && existsSync(data.themePath)) {
        rmSync(data.themePath, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }

  try {
    if (existsSync(filePath)) rmSync(filePath);
  } catch { /* ignore */ }

  if (activeSession?.id === sessionId) {
    activeSession = null;
  }
}

// ---------------------------------------------------------------------------
// Write modules back to disk (for upload)
// ---------------------------------------------------------------------------

export function writeModulesToDisk(): void {
  if (!activeSession) return;

  const themePath = activeSession.themePath;

  for (const mod of activeSession.modules) {
    const modDir = join(themePath, "modules", `${mod.moduleName}.module`);
    mkdirSync(modDir, { recursive: true });

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

  if (activeSession.template) {
    const templatesDir = join(themePath, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(
      join(templatesDir, `lp-${activeSession.themeName}.html`),
      activeSession.template,
      "utf-8"
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return `vibe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

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

interface FieldDef {
  name: string;
  default?: unknown;
  children?: FieldDef[];
}
