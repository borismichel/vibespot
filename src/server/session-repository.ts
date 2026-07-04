/**
 * SessionRepository interface — abstraction layer for session storage.
 *
 * The current implementation uses FileSessionRepository (backed by
 * ~/.vibespot/sessions/ JSON files).
 *
 * This interface captures the storage contract. Business logic (module updates,
 * field editing, template management) lives in session.ts and operates on
 * VibeSession objects regardless of how they're stored.
 */

import type { VibeSession } from "./session.js";

export interface SessionIndexEntry {
  id: string;
  themeName: string;
  updatedAt: number;
  moduleCount: number;
  templateCount: number;
}

export interface SessionRepository {
  /**
   * Save a session to persistent storage.
   */
  save(session: VibeSession): void;

  /**
   * Load a session by ID. Returns null if not found.
   */
  load(sessionId: string): VibeSession | null;

  /**
   * List all sessions (lightweight index entries, not full data).
   */
  list(): SessionIndexEntry[];

  /**
   * Delete a session by ID. If deleteFiles is true, also remove
   * the theme directory from disk/storage.
   */
  delete(sessionId: string, deleteFiles?: boolean): void;

  /**
   * Rename a session's theme. Updates all sessions with the same
   * theme name, renames disk directory, and updates the index.
   * Returns { ok: true } on success, or { ok: false, error: string } on failure.
   */
  rename(sessionId: string, newName: string): { ok: boolean; error?: string };
}

/**
 * FileSessionRepository — the default CLI implementation.
 *
 * This is currently implemented by the top-level functions in session.ts:
 * - save → saveSession()
 * - load → loadSession()
 * - list → listSessions()
 * - delete → deleteSession()
 * - rename → renameSession()
 *
 * To use this interface pattern in SaaS:
 *
 * ```typescript
 * import type { SessionRepository } from "./session-repository.js";
 *
 * class DatabaseSessionRepository implements SessionRepository {
 *   constructor(private db: DatabaseConnection) {}
 *   save(session: VibeSession) { ... }
 *   load(sessionId: string) { ... }
 *   list() { ... }
 *   delete(sessionId: string, deleteFiles?: boolean) { ... }
 *   rename(sessionId: string, newName: string) { ... }
 * }
 * ```
 *
 * Route handlers would receive the repository as a parameter instead
 * of importing global functions from session.ts.
 */
