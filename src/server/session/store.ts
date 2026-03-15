/**
 * Session CRUD, index management, and the global activeSession variable.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { ensureGitRepo } from "../project-git.js";
import type { VibeSession, SessionIndexEntry } from "./types.js";
import { migrateSession } from "./templates.js";

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const SESSIONS_DIR = join(homedir(), ".vibespot", "sessions");
const INDEX_PATH = join(SESSIONS_DIR, "_index.json");

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

export function getSession(): VibeSession | null {
  return activeSession;
}

function generateId(): string {
  return `vibe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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
