/**
 * StorageAdapter interface — the pivot point between CLI (filesystem) and SaaS (Postgres).
 *
 * Three layers:
 * 1. Generic file operations (read/write/delete/list) for theme files
 * 2. Session CRUD (structured JSON, indexed for fast listing)
 * 3. Theme-aware helpers (module I/O, shared CSS/JS, brand assets)
 */

import type { VibeSession, SessionIndexEntry } from "../session/types.js";

// ---------------------------------------------------------------------------
// Generic file operations
// ---------------------------------------------------------------------------

export interface FileEntry {
  path: string;
  isDirectory: boolean;
}

export interface StorageAdapter {
  // --- Generic file I/O ---

  /** Read a file as UTF-8 string. Returns null if not found. */
  read(path: string): Promise<string | null>;

  /** Write a file (creates parent dirs as needed). */
  write(path: string, data: string): Promise<void>;

  /** Delete a file or directory recursively. */
  delete(path: string): Promise<void>;

  /** List files/directories under a prefix. Non-recursive by default. */
  list(prefix: string): Promise<FileEntry[]>;

  /** Check if a path exists. */
  exists(path: string): Promise<boolean>;

  /** Rename/move a path. */
  rename(oldPath: string, newPath: string): Promise<void>;

  // --- Session CRUD ---

  /** Create or update a session. */
  saveSession(session: VibeSession): Promise<void>;

  /** Load a session by ID. Returns null if not found. */
  loadSession(sessionId: string): Promise<VibeSession | null>;

  /** List all sessions (lightweight index entries). */
  listSessions(): Promise<SessionIndexEntry[]>;

  /** Delete a session by ID. If deleteFiles is true, also remove the theme directory. */
  deleteSession(sessionId: string, deleteFiles?: boolean): Promise<void>;

  /** Delete all sessions for a given theme name. */
  deleteSessionsByTheme(themeName: string, deleteFiles?: boolean): Promise<void>;

  // --- Theme file operations (scoped to a theme path) ---

  /** Read a module's files from the theme. Returns null if module doesn't exist. */
  readModule(themePath: string, moduleName: string): Promise<ModuleOnDisk | null>;

  /** Write a module's files to the theme. */
  writeModule(themePath: string, moduleName: string, files: ModuleOnDisk): Promise<void>;

  /** Delete a module directory from the theme. */
  deleteModule(themePath: string, moduleName: string): Promise<void>;

  /** List all module names in a theme. */
  listModules(themePath: string): Promise<string[]>;

  /** Read the shared theme CSS. Returns empty string if not found. */
  readSharedCss(themePath: string, themeName: string): Promise<string>;

  /** Write the shared theme CSS. */
  writeSharedCss(themePath: string, themeName: string, css: string): Promise<void>;

  /** Read the shared animations JS. Returns empty string if not found. */
  readSharedJs(themePath: string, themeName: string): Promise<string>;

  /** Write the shared animations JS. */
  writeSharedJs(themePath: string, themeName: string, js: string): Promise<void>;

  /** Read a brand asset file (.vibespot/styleguide.md, etc). */
  readBrandAsset(themePath: string, filename: string): Promise<string | null>;

  /** Write a brand asset file. */
  writeBrandAsset(themePath: string, filename: string, content: string): Promise<void>;

  /** Delete a brand asset file. */
  deleteBrandAsset(themePath: string, filename: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface ModuleOnDisk {
  fieldsJson: string;
  metaJson: string;
  moduleHtml: string;
  moduleCss: string;
  moduleJs?: string;
}
