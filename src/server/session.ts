/**
 * Session state for the vibe coding workspace.
 * Tracks conversation history, generated modules, and theme state.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type { ModuleFiles, GeneratedAssets } from "../ai/engine.js";
import { ensureGitRepo } from "./project-git.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export type PageType = "landing_page" | "blog_post" | "website_page" | "module_only";

export interface TemplateEntry {
  id: string;                    // e.g. "lp-main", "blog-post"
  label: string;                 // "Main Landing Page"
  pageType: PageType;
  templateFile: string;          // "templates/lp-main.html"
  modules: ModuleFiles[];
  moduleOrder: string[];
  sharedCss: string;
  sharedJs: string;
  template: string;              // HubL template content
  messages: ChatMessage[];       // per-template chat history
}

export interface VibeSession {
  id: string;
  themePath: string;
  themeName: string;

  // Multi-template support
  templates: TemplateEntry[];
  activeTemplateId: string;
  brandAssets?: {
    styleguide?: string;
    brandvoice?: string;
    humanify?: boolean;
  };

  // Legacy flat fields — kept for backward compat, redirected to active template
  messages: ChatMessage[];
  modules: ModuleFiles[];
  sharedCss: string;
  sharedJs: string;
  template: string;
  moduleOrder: string[];
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const SESSIONS_DIR = join(homedir(), ".vibespot", "sessions");
const INDEX_PATH = join(SESSIONS_DIR, "_index.json");

interface SessionIndexEntry {
  id: string;
  themeName: string;
  updatedAt: number;
  moduleCount: number;
  templateCount: number;
}

let _indexCache: SessionIndexEntry[] | null = null;

function readIndex(): SessionIndexEntry[] {
  if (_indexCache) return _indexCache;
  try {
    if (!existsSync(INDEX_PATH)) return rebuildIndex();
    _indexCache = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
    return _indexCache!;
  } catch {
    return rebuildIndex();
  }
}

function writeIndex(entries: SessionIndexEntry[]): void {
  _indexCache = entries;
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(INDEX_PATH, JSON.stringify(entries), "utf-8");
  } catch { /* non-critical */ }
}

function rebuildIndex(): SessionIndexEntry[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const entries: SessionIndexEntry[] = [];
  for (const f of readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json") && f !== "_index.json")) {
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
      const templates = data.templates || [];
      entries.push({
        id: data.id,
        themeName: data.themeName,
        updatedAt: data.updatedAt,
        moduleCount: templates.reduce((n: number, t: any) => n + (t.modules?.length || 0), 0),
        templateCount: templates.length,
      });
    } catch { /* skip corrupt files */ }
  }
  _indexCache = entries;
  writeIndex(entries);
  return entries;
}

function upsertIndex(session: VibeSession): void {
  const entries = readIndex();
  const templates = session.templates || [];
  const entry: SessionIndexEntry = {
    id: session.id,
    themeName: session.themeName,
    updatedAt: session.updatedAt,
    moduleCount: templates.reduce((n, t) => n + (t.modules?.length || 0), 0),
    templateCount: templates.length,
  };
  const idx = entries.findIndex((e) => e.id === session.id);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  writeIndex(entries);
}

function removeFromIndex(sessionId: string): void {
  const entries = readIndex().filter((e) => e.id !== sessionId);
  writeIndex(entries);
}

function removeFromIndexByTheme(themeName: string): void {
  const entries = readIndex().filter((e) => e.themeName !== themeName);
  writeIndex(entries);
}

let activeSession: VibeSession | null = null;

export function createSession(themePath: string, themeName: string): VibeSession {
  const session: VibeSession = {
    id: generateId(),
    themePath,
    themeName,
    templates: [],
    activeTemplateId: "",
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
  ensureGitRepo(themePath);
  return session;
}

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
  if (!activeSession) return null;
  if (!activeSession.activeTemplateId || !activeSession.templates?.length) return null;
  return activeSession.templates.find((t) => t.id === activeSession!.activeTemplateId) || null;
}

/**
 * Set the active template by ID. Syncs flat fields from the template.
 */
export function setActiveTemplate(templateId: string): boolean {
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
 * Rename a template's display label.
 */
export function renameTemplate(templateId: string, newLabel: string): boolean {
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

/**
 * Sync flat session fields from a template (compatibility layer).
 * Existing code reads session.modules, session.messages, etc.
 * This keeps those in sync with the active template.
 */
function syncFlatFieldsFromTemplate(tpl: TemplateEntry): void {
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
function syncFlatFieldsToTemplate(): void {
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

export function getSession(): VibeSession | null {
  return activeSession;
}

export function addMessage(role: "user" | "assistant", content: string): void {
  if (!activeSession) return;
  activeSession.messages.push({ role, content, timestamp: Date.now() });
  activeSession.updatedAt = Date.now();
  syncFlatFieldsToTemplate();
  saveChatToTheme();
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
  syncFlatFieldsToTemplate();
}

/**
 * Reorder modules (used by drag-and-drop in the UI).
 */
export function reorderModules(newOrder: string[]): void {
  if (!activeSession) return;
  activeSession.moduleOrder = newOrder;
  activeSession.updatedAt = Date.now();
  syncFlatFieldsToTemplate();
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
  syncFlatFieldsToTemplate();
}

/**
 * Detach a module from the current template (remove from moduleOrder only).
 * The module data stays in the session so it can be re-added later.
 */
export function detachModule(moduleName: string): void {
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

  // Load brand assets from .vibespot/ directory
  const sgPath = join(themePath, ".vibespot", "styleguide.md");
  const bvPath = join(themePath, ".vibespot", "brandvoice.md");
  if (existsSync(sgPath) || existsSync(bvPath)) {
    if (!activeSession.brandAssets) activeSession.brandAssets = {};
    if (existsSync(sgPath)) activeSession.brandAssets.styleguide = safeRead(sgPath);
    if (existsSync(bvPath)) activeSession.brandAssets.brandvoice = safeRead(bvPath);
  }

  // Migrate flat fields to templates if this is a pre-existing theme
  if (!activeSession.templates) activeSession.templates = [];
  if (!activeSession.activeTemplateId) activeSession.activeTemplateId = "";
  migrateSession(activeSession);
}

// ---------------------------------------------------------------------------
// Persistence — save/load sessions across restarts
// ---------------------------------------------------------------------------

export function saveSession(): void {
  if (!activeSession) return;

  mkdirSync(SESSIONS_DIR, { recursive: true });
  const filePath = join(SESSIONS_DIR, `${activeSession.id}.json`);
  writeFileSync(filePath, JSON.stringify(activeSession, null, 2), "utf-8");
  upsertIndex(activeSession);
}

export function loadSession(sessionId: string): VibeSession | null {
  const filePath = join(SESSIONS_DIR, sessionId + ".json");
  if (!existsSync(filePath)) return null;

  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));

    // Ensure templates array exists (backward compat with v0.3.0 sessions)
    if (!data.templates) data.templates = [];
    if (!data.activeTemplateId) data.activeTemplateId = "";

    // Migrate flat fields into templates if needed
    migrateSession(data);

    activeSession = data;
    return data;
  } catch {
    return null;
  }
}

export function listSessions(): Array<{ id: string; themeName: string; updatedAt: number; moduleCount: number; templateCount: number }> {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readIndex();
}

export function deleteSession(sessionId: string, deleteFiles = false): void {
  const filePath = join(SESSIONS_DIR, sessionId + ".json");

  // Read the session to get themeName (needed to find sibling sessions)
  let themeName = "";
  if (deleteFiles) {
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      themeName = data.themeName || "";
      if (data.themePath && existsSync(data.themePath)) {
        rmSync(data.themePath, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  } else {
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      themeName = data.themeName || "";
    } catch { /* ignore */ }
  }

  try {
    if (existsSync(filePath)) rmSync(filePath);
  } catch { /* ignore */ }

  // Also delete all other sessions for the same theme (prevents ghost entries)
  if (themeName && existsSync(SESSIONS_DIR)) {
    for (const f of readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json") && f !== "_index.json")) {
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
        if (data.themeName === themeName) {
          rmSync(join(SESSIONS_DIR, f));
        }
      } catch { /* ignore */ }
    }
    removeFromIndexByTheme(themeName);
  } else {
    removeFromIndex(sessionId);
  }

  if (activeSession?.id === sessionId) {
    activeSession = null;
  }
}

/**
 * Rename a project: update themeName in all sessions, rename disk folder,
 * rename CSS/JS files, and update the session index.
 */
export function renameSession(sessionId: string, newName: string): { ok: boolean; error?: string } {
  // Load the session to get the current theme name
  const filePath = join(SESSIONS_DIR, sessionId + ".json");
  if (!existsSync(filePath)) return { ok: false, error: "Session not found" };

  let session: VibeSession;
  try {
    session = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return { ok: false, error: "Failed to read session" };
  }

  const oldName = session.themeName;
  if (oldName === newName) return { ok: true };

  const oldPath = session.themePath;
  const newPath = join(dirname(oldPath), newName);

  // Rename the folder on disk
  if (existsSync(oldPath)) {
    if (existsSync(newPath)) return { ok: false, error: "A project with that name already exists" };
    try {
      renameSync(oldPath, newPath);
    } catch (err) {
      return { ok: false, error: `Failed to rename folder: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Rename CSS/JS files inside the new folder
    const cssOld = join(newPath, "css", `${oldName}-theme.css`);
    const cssNew = join(newPath, "css", `${newName}-theme.css`);
    if (existsSync(cssOld)) try { renameSync(cssOld, cssNew); } catch { /* non-critical */ }

    const jsOld = join(newPath, "js", `${oldName}-animations.js`);
    const jsNew = join(newPath, "js", `${newName}-animations.js`);
    if (existsSync(jsOld)) try { renameSync(jsOld, jsNew); } catch { /* non-critical */ }

    // Update theme.json label/name
    const themeJsonPath = join(newPath, "theme.json");
    if (existsSync(themeJsonPath)) {
      try {
        const themeData = JSON.parse(readFileSync(themeJsonPath, "utf-8"));
        themeData.label = newName;
        themeData.name = newName;
        writeFileSync(themeJsonPath, JSON.stringify(themeData, null, 2), "utf-8");
      } catch { /* non-critical */ }
    }
  }

  // Update all sessions that reference this theme
  if (existsSync(SESSIONS_DIR)) {
    for (const f of readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json") && f !== "_index.json")) {
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
        if (data.themeName === oldName) {
          data.themeName = newName;
          data.themePath = newPath;
          data.updatedAt = Date.now();
          writeFileSync(join(SESSIONS_DIR, f), JSON.stringify(data, null, 2), "utf-8");
        }
      } catch { /* skip corrupt files */ }
    }
  }

  // Update the in-memory active session
  if (activeSession && activeSession.themeName === oldName) {
    activeSession.themeName = newName;
    activeSession.themePath = newPath;
    activeSession.updatedAt = Date.now();
  }

  // Rebuild the index
  rebuildIndex();

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Write modules back to disk (for upload)
// ---------------------------------------------------------------------------

export function writeModulesToDisk(): void {
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
  if (activeSession.templates.length > 0) {
    const templatesDir = join(themePath, "templates");
    mkdirSync(templatesDir, { recursive: true });

    for (const tpl of activeSession.templates) {
      if (tpl.pageType === "module_only") continue; // No template for module-only
      if (tpl.modules.length === 0) continue;

      const templateContent = tpl.template || generateTemplateForEntry(tpl);
      const annotated = ensureTemplateAnnotations(templateContent, tpl.label, tpl.pageType);
      writeFileSync(
        join(templatesDir, `${tpl.id}.html`),
        annotated,
        "utf-8"
      );

      // For blog posts, also generate a listing template
      if (tpl.pageType === "blog_post") {
        writeBlogListingTemplate(templatesDir, tpl);
      }
    }
  } else if (activeSession.modules.length > 0) {
    // Legacy fallback: single template from flat fields
    const template = activeSession.template || generateTemplateFromModules();
    const templatesDir = join(themePath, "templates");
    mkdirSync(templatesDir, { recursive: true });
    const annotated = ensureTemplateAnnotations(template, `${activeSession.themeName} Landing Page`);
    writeFileSync(
      join(templatesDir, `lp-${activeSession.themeName}.html`),
      annotated,
      "utf-8"
    );
  }

  // Patch base.html to load template_js (animations won't work without this)
  patchBaseTemplate();

  // Populate theme.json with proper metadata
  updateThemeJson();
}

// ---------------------------------------------------------------------------
// Chat persistence — store chat in theme directory
// ---------------------------------------------------------------------------

/**
 * Persist chat to {themePath}/.vibespot/chat.json (gitignored).
 */
function saveChatToTheme(): void {
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
function loadChatFromTheme(themePath: string): ChatMessage[] {
  const chatPath = join(themePath, ".vibespot", "chat.json");
  if (!existsSync(chatPath)) return [];
  try {
    const data = JSON.parse(readFileSync(chatPath, "utf-8"));
    return Array.isArray(data.messages) ? data.messages : [];
  } catch {
    return [];
  }
}

/**
 * Clear in-memory modules and re-scan from disk.
 * Used after a git rollback to sync session state with restored files.
 */
export function reloadModulesFromDisk(): void {
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

  const name = activeSession!.themeName;
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

/**
 * Build a HubSpot page template that assembles all modules in display order.
 * Legacy — used when no templates array exists (flat session).
 */
function generateTemplateFromModules(): string {
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
