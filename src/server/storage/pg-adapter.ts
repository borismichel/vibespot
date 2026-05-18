/**
 * PostgresStorageAdapter — stores sessions and theme files in Postgres.
 *
 * Schema:
 * - sessions: id, theme_name, theme_path (virtual), data (jsonb), created_at, updated_at
 * - theme_files: id, theme_id (fk sessions.id), path, content (text), created_at, updated_at
 *
 * Theme files are stored as rows keyed by (theme_id, path) where path is relative
 * to the theme root (e.g., "modules/hero.module/fields.json").
 */

import type { StorageAdapter, FileEntry, ModuleOnDisk } from "./types.js";
import type { VibeSession, SessionIndexEntry } from "../session/types.js";

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export class PostgresStorageAdapter implements StorageAdapter {
  private pool: PgPool;
  private initialized = false;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        theme_name TEXT NOT NULL,
        theme_path TEXT NOT NULL DEFAULT '',
        data JSONB NOT NULL,
        is_imported BOOLEAN DEFAULT FALSE,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS theme_files (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
        UNIQUE(session_id, path)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_theme_files_session_path
      ON theme_files(session_id, path)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_theme_name
      ON sessions(theme_name)
    `);
    this.initialized = true;
  }

  // -------------------------------------------------------------------------
  // Generic file I/O — maps to theme_files table using path as key
  // -------------------------------------------------------------------------

  async read(path: string): Promise<string | null> {
    await this.ensureSchema();
    const { sessionId, relativePath } = this.parsePath(path);
    if (!sessionId) return null;
    const result = await this.pool.query(
      "SELECT content FROM theme_files WHERE session_id = $1 AND path = $2",
      [sessionId, relativePath]
    );
    return result.rows.length > 0 ? (result.rows[0].content as string) : null;
  }

  async write(path: string, data: string): Promise<void> {
    await this.ensureSchema();
    const { sessionId, relativePath } = this.parsePath(path);
    if (!sessionId) return;
    await this.pool.query(
      `INSERT INTO theme_files (session_id, path, content, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, path) DO UPDATE SET content = $3, updated_at = $4`,
      [sessionId, relativePath, data, Date.now()]
    );
  }

  async delete(path: string): Promise<void> {
    await this.ensureSchema();
    const { sessionId, relativePath } = this.parsePath(path);
    if (!sessionId) return;
    // Delete the exact path and any children (simulates recursive rm)
    await this.pool.query(
      "DELETE FROM theme_files WHERE session_id = $1 AND (path = $2 OR path LIKE $3)",
      [sessionId, relativePath, `${relativePath}/%`]
    );
  }

  async list(prefix: string): Promise<FileEntry[]> {
    await this.ensureSchema();
    const { sessionId, relativePath } = this.parsePath(prefix);
    if (!sessionId) return [];

    const likePattern = relativePath ? `${relativePath}/%` : "%";
    const result = await this.pool.query(
      "SELECT DISTINCT path FROM theme_files WHERE session_id = $1 AND path LIKE $2",
      [sessionId, likePattern]
    );

    // Simulate directory listing (only immediate children)
    const depth = relativePath ? relativePath.split("/").length : 0;
    const seen = new Set<string>();
    const entries: FileEntry[] = [];

    for (const row of result.rows) {
      const fullPath = row.path as string;
      const parts = fullPath.split("/");
      if (parts.length <= depth) continue;

      const childName = parts[depth];
      const childPath = parts.slice(0, depth + 1).join("/");
      if (seen.has(childPath)) continue;
      seen.add(childPath);

      entries.push({
        path: childPath,
        isDirectory: parts.length > depth + 1,
      });
    }

    return entries;
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureSchema();
    const { sessionId, relativePath } = this.parsePath(path);
    if (!sessionId) return false;
    const result = await this.pool.query(
      "SELECT 1 FROM theme_files WHERE session_id = $1 AND (path = $2 OR path LIKE $3) LIMIT 1",
      [sessionId, relativePath, `${relativePath}/%`]
    );
    return result.rows.length > 0;
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.ensureSchema();
    const old = this.parsePath(oldPath);
    const nw = this.parsePath(newPath);
    if (!old.sessionId) return;

    // Update all paths that start with old prefix
    await this.pool.query(
      `UPDATE theme_files
       SET path = $3 || SUBSTRING(path FROM $4),
           session_id = COALESCE($5, session_id)
       WHERE session_id = $1 AND (path = $2 OR path LIKE $6)`,
      [
        old.sessionId,
        old.relativePath,
        nw.relativePath,
        old.relativePath.length + 1,
        nw.sessionId || old.sessionId,
        `${old.relativePath}/%`,
      ]
    );
  }

  // -------------------------------------------------------------------------
  // Session CRUD
  // -------------------------------------------------------------------------

  async saveSession(session: VibeSession): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO sessions (id, theme_name, theme_path, data, is_imported, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         theme_name = $2, theme_path = $3, data = $4, is_imported = $5, updated_at = $7`,
      [
        session.id,
        session.themeName,
        session.themePath,
        JSON.stringify(session),
        !!session.isImported,
        session.createdAt,
        session.updatedAt || Date.now(),
      ]
    );
  }

  async loadSession(sessionId: string): Promise<VibeSession | null> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT data FROM sessions WHERE id = $1",
      [sessionId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].data as unknown as VibeSession;
  }

  async listSessions(): Promise<SessionIndexEntry[]> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT id, theme_name, updated_at, is_imported, data FROM sessions ORDER BY updated_at DESC"
    );
    return result.rows.map((row) => {
      const data = row.data as any;
      const templates = data?.templates || [];
      return {
        id: row.id as string,
        themeName: row.theme_name as string,
        updatedAt: row.updated_at as number,
        moduleCount: templates.reduce((n: number, t: any) => n + (t.modules?.length || 0), 0),
        templateCount: templates.length,
        isImported: !!row.is_imported,
      };
    });
  }

  async deleteSession(sessionId: string, deleteFiles = false): Promise<void> {
    await this.ensureSchema();
    // theme_files cascade-deletes via FK
    if (deleteFiles) {
      await this.pool.query("DELETE FROM theme_files WHERE session_id = $1", [sessionId]);
    }
    await this.pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
  }

  async deleteSessionsByTheme(themeName: string, deleteFiles = false): Promise<void> {
    await this.ensureSchema();
    const result = await this.pool.query("SELECT id FROM sessions WHERE theme_name = $1", [themeName]);
    for (const row of result.rows) {
      await this.deleteSession(row.id as string, deleteFiles);
    }
  }

  // -------------------------------------------------------------------------
  // Theme file operations
  // -------------------------------------------------------------------------

  async readModule(themePath: string, moduleName: string): Promise<ModuleOnDisk | null> {
    await this.ensureSchema();
    const sessionId = this.sessionIdFromThemePath(themePath);
    if (!sessionId) return null;

    const prefix = `modules/${moduleName}.module`;
    const result = await this.pool.query(
      "SELECT path, content FROM theme_files WHERE session_id = $1 AND path LIKE $2",
      [sessionId, `${prefix}/%`]
    );

    if (result.rows.length === 0) return null;

    const files: Record<string, string> = {};
    for (const row of result.rows) {
      const filename = (row.path as string).split("/").pop()!;
      files[filename] = row.content as string;
    }

    if (!files["fields.json"] || !files["module.html"]) return null;

    return {
      fieldsJson: files["fields.json"],
      metaJson: files["meta.json"] || "",
      moduleHtml: files["module.html"],
      moduleCss: files["module.css"] || "",
      moduleJs: files["module.js"] || undefined,
    };
  }

  async writeModule(themePath: string, moduleName: string, files: ModuleOnDisk): Promise<void> {
    await this.ensureSchema();
    const sessionId = this.sessionIdFromThemePath(themePath);
    if (!sessionId) return;

    const prefix = `modules/${moduleName}.module`;
    const now = Date.now();
    const entries: [string, string][] = [
      [`${prefix}/fields.json`, files.fieldsJson],
      [`${prefix}/meta.json`, files.metaJson],
      [`${prefix}/module.html`, files.moduleHtml],
      [`${prefix}/module.css`, files.moduleCss],
    ];
    if (files.moduleJs) {
      entries.push([`${prefix}/module.js`, files.moduleJs]);
    }

    for (const [path, content] of entries) {
      await this.pool.query(
        `INSERT INTO theme_files (session_id, path, content, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (session_id, path) DO UPDATE SET content = $3, updated_at = $4`,
        [sessionId, path, content, now]
      );
    }
  }

  async deleteModule(themePath: string, moduleName: string): Promise<void> {
    await this.ensureSchema();
    const sessionId = this.sessionIdFromThemePath(themePath);
    if (!sessionId) return;
    await this.pool.query(
      "DELETE FROM theme_files WHERE session_id = $1 AND path LIKE $2",
      [sessionId, `modules/${moduleName}.module/%`]
    );
  }

  async listModules(themePath: string): Promise<string[]> {
    await this.ensureSchema();
    const sessionId = this.sessionIdFromThemePath(themePath);
    if (!sessionId) return [];
    const result = await this.pool.query(
      "SELECT DISTINCT path FROM theme_files WHERE session_id = $1 AND path LIKE 'modules/%.module/%'",
      [sessionId]
    );
    const names = new Set<string>();
    for (const row of result.rows) {
      const match = (row.path as string).match(/^modules\/(.+)\.module\//);
      if (match) names.add(match[1]);
    }
    return Array.from(names);
  }

  async readSharedCss(themePath: string, themeName: string): Promise<string> {
    await this.ensureSchema();
    const sessionId = this.sessionIdFromThemePath(themePath);
    if (!sessionId) return "";
    const result = await this.pool.query(
      "SELECT content FROM theme_files WHERE session_id = $1 AND path = $2",
      [sessionId, `css/${themeName}-theme.css`]
    );
    return result.rows.length > 0 ? (result.rows[0].content as string) : "";
  }

  async writeSharedCss(themePath: string, themeName: string, css: string): Promise<void> {
    await this.ensureSchema();
    const sessionId = this.sessionIdFromThemePath(themePath);
    if (!sessionId) return;
    await this.pool.query(
      `INSERT INTO theme_files (session_id, path, content, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, path) DO UPDATE SET content = $3, updated_at = $4`,
      [sessionId, `css/${themeName}-theme.css`, css, Date.now()]
    );
  }

  async readSharedJs(themePath: string, themeName: string): Promise<string> {
    await this.ensureSchema();
    const sessionId = this.sessionIdFromThemePath(themePath);
    if (!sessionId) return "";
    const result = await this.pool.query(
      "SELECT content FROM theme_files WHERE session_id = $1 AND path = $2",
      [sessionId, `js/${themeName}-animations.js`]
    );
    return result.rows.length > 0 ? (result.rows[0].content as string) : "";
  }

  async writeSharedJs(themePath: string, themeName: string, js: string): Promise<void> {
    await this.ensureSchema();
    const sessionId = this.sessionIdFromThemePath(themePath);
    if (!sessionId) return;
    await this.pool.query(
      `INSERT INTO theme_files (session_id, path, content, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, path) DO UPDATE SET content = $3, updated_at = $4`,
      [sessionId, `js/${themeName}-animations.js`, js, Date.now()]
    );
  }

  async readBrandAsset(themePath: string, filename: string): Promise<string | null> {
    await this.ensureSchema();
    const sessionId = this.sessionIdFromThemePath(themePath);
    if (!sessionId) return null;
    const result = await this.pool.query(
      "SELECT content FROM theme_files WHERE session_id = $1 AND path = $2",
      [sessionId, `.vibespot/${filename}`]
    );
    return result.rows.length > 0 ? (result.rows[0].content as string) : null;
  }

  async writeBrandAsset(themePath: string, filename: string, content: string): Promise<void> {
    await this.ensureSchema();
    const sessionId = this.sessionIdFromThemePath(themePath);
    if (!sessionId) return;
    await this.pool.query(
      `INSERT INTO theme_files (session_id, path, content, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, path) DO UPDATE SET content = $3, updated_at = $4`,
      [sessionId, `.vibespot/${filename}`, content, Date.now()]
    );
  }

  async deleteBrandAsset(themePath: string, filename: string): Promise<void> {
    await this.ensureSchema();
    const sessionId = this.sessionIdFromThemePath(themePath);
    if (!sessionId) return;
    await this.pool.query(
      "DELETE FROM theme_files WHERE session_id = $1 AND path = $2",
      [sessionId, `.vibespot/${filename}`]
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * For generic file I/O, paths are structured as: <sessionId>/<relativePath>
   * This is a convention for the Postgres adapter — the SaaS layer will
   * construct paths this way instead of using filesystem paths.
   */
  private parsePath(fullPath: string): { sessionId: string | null; relativePath: string } {
    // In SaaS mode, paths are: "sessions/<sessionId>/files/<relativePath>"
    const match = fullPath.match(/^sessions\/([^/]+)\/files\/(.+)$/);
    if (match) return { sessionId: match[1], relativePath: match[2] };

    // Fallback: try to find session ID from the path via registered themes
    // In practice, SaaS routes will always use the structured path format
    return { sessionId: null, relativePath: fullPath };
  }

  /**
   * Resolve a session ID from a theme path.
   * In SaaS mode, themePath is the session ID itself (virtual).
   */
  private sessionIdFromThemePath(themePath: string): string | null {
    // In SaaS, themePath will be set to the session ID
    // The session layer will set themePath = sessionId for Postgres mode
    if (themePath.startsWith("vibe-")) return themePath;

    // Fallback: look up by path
    // This won't be needed in practice — the migration sets themePath = session.id
    return null;
  }
}
