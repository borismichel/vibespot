/**
 * FileSystemStorageAdapter — wraps current filesystem-based persistence.
 * Zero behavioral change from existing session/store.ts and session/disk.ts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { StorageAdapter, FileEntry, ModuleOnDisk } from "./types.js";
import type { VibeSession, SessionIndexEntry } from "../session/types.js";
import { resolveModuleDir } from "../../utils/path-safety.js";

export interface FileSystemStorageAdapterOptions {
  sessionsDir?: string;
}

function defaultSessionsDir(): string {
  if (process.env.VIBESPOT_SESSIONS_DIR) return process.env.VIBESPOT_SESSIONS_DIR;
  const baseDir = process.env.VIBESPOT_HOME || join(homedir(), ".vibespot");
  return join(baseDir, "sessions");
}

export class FileSystemStorageAdapter implements StorageAdapter {
  private readonly sessionsDir: string;
  private readonly indexPath: string;

  constructor(options: FileSystemStorageAdapterOptions = {}) {
    this.sessionsDir = options.sessionsDir || defaultSessionsDir();
    this.indexPath = join(this.sessionsDir, "_index.json");
  }

  // -------------------------------------------------------------------------
  // Generic file I/O
  // -------------------------------------------------------------------------

  async read(path: string): Promise<string | null> {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }

  async write(path: string, data: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data, "utf-8");
  }

  async delete(path: string): Promise<void> {
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
    }
  }

  async list(prefix: string): Promise<FileEntry[]> {
    if (!existsSync(prefix)) return [];
    const entries = readdirSync(prefix, { withFileTypes: true });
    return entries.map((e) => ({
      path: join(prefix, e.name),
      isDirectory: e.isDirectory(),
    }));
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    renameSync(oldPath, newPath);
  }

  // -------------------------------------------------------------------------
  // Session CRUD
  // -------------------------------------------------------------------------

  async saveSession(session: VibeSession): Promise<void> {
    mkdirSync(this.sessionsDir, { recursive: true });
    const filePath = join(this.sessionsDir, `${session.id}.json`);
    writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
    this.upsertIndex(session);
  }

  async loadSession(sessionId: string): Promise<VibeSession | null> {
    const filePath = join(this.sessionsDir, `${sessionId}.json`);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  async listSessions(): Promise<SessionIndexEntry[]> {
    if (!existsSync(this.sessionsDir)) return [];
    return this.readIndex();
  }

  async deleteSession(sessionId: string, deleteFiles = false): Promise<void> {
    const filePath = join(this.sessionsDir, `${sessionId}.json`);
    let themeName = "";

    if (existsSync(filePath)) {
      try {
        const data = JSON.parse(readFileSync(filePath, "utf-8"));
        themeName = data.themeName || "";
        if (deleteFiles && data.themePath && existsSync(data.themePath)) {
          rmSync(data.themePath, { recursive: true, force: true });
        }
      } catch { /* ignore */ }
      rmSync(filePath, { force: true });
    }

    if (themeName) {
      await this.deleteSessionsByTheme(themeName, false);
    } else {
      this.removeFromIndex(sessionId);
    }
  }

  async deleteSessionsByTheme(themeName: string, deleteFiles = false): Promise<void> {
    if (!existsSync(this.sessionsDir)) return;
    for (const f of readdirSync(this.sessionsDir).filter((f) => f.endsWith(".json") && f !== "_index.json")) {
      try {
        const data = JSON.parse(readFileSync(join(this.sessionsDir, f), "utf-8"));
        if (data.themeName === themeName) {
          if (deleteFiles && data.themePath && existsSync(data.themePath)) {
            rmSync(data.themePath, { recursive: true, force: true });
          }
          rmSync(join(this.sessionsDir, f), { force: true });
        }
      } catch { /* ignore */ }
    }
    const entries = this.readIndex().filter((e) => e.themeName !== themeName);
    this.writeIndex(entries);
  }

  // -------------------------------------------------------------------------
  // Theme file operations
  // -------------------------------------------------------------------------

  async readModule(themePath: string, moduleName: string): Promise<ModuleOnDisk | null> {
    // resolveModuleDir throws on names that would escape modules/ (VIB-1891)
    const modDir = resolveModuleDir(join(themePath, "modules"), moduleName);
    if (!existsSync(modDir)) return null;

    const fieldsJson = this.safeRead(join(modDir, "fields.json"));
    const moduleHtml = this.safeRead(join(modDir, "module.html"));
    if (!fieldsJson || !moduleHtml) return null;

    return {
      fieldsJson,
      metaJson: this.safeRead(join(modDir, "meta.json")),
      moduleHtml,
      moduleCss: this.safeRead(join(modDir, "module.css")),
      moduleJs: this.safeRead(join(modDir, "module.js")) || undefined,
    };
  }

  async writeModule(themePath: string, moduleName: string, files: ModuleOnDisk): Promise<void> {
    const modDir = resolveModuleDir(join(themePath, "modules"), moduleName);
    mkdirSync(modDir, { recursive: true });
    writeFileSync(join(modDir, "fields.json"), files.fieldsJson, "utf-8");
    writeFileSync(join(modDir, "meta.json"), files.metaJson, "utf-8");
    writeFileSync(join(modDir, "module.html"), files.moduleHtml, "utf-8");
    writeFileSync(join(modDir, "module.css"), files.moduleCss, "utf-8");
    if (files.moduleJs) {
      writeFileSync(join(modDir, "module.js"), files.moduleJs, "utf-8");
    }
  }

  async deleteModule(themePath: string, moduleName: string): Promise<void> {
    const modDir = resolveModuleDir(join(themePath, "modules"), moduleName);
    if (existsSync(modDir)) {
      rmSync(modDir, { recursive: true, force: true });
    }
  }

  async listModules(themePath: string): Promise<string[]> {
    const modulesDir = join(themePath, "modules");
    if (!existsSync(modulesDir)) return [];
    return readdirSync(modulesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.endsWith(".module"))
      .map((e) => e.name.replace(/\.module$/, ""));
  }

  async readSharedCss(themePath: string, themeName: string): Promise<string> {
    const cssDir = join(themePath, "css");
    if (!existsSync(cssDir)) return "";
    const files = readdirSync(cssDir).filter((f) => f.endsWith("-theme.css"));
    if (files.length === 0) return "";
    return this.safeRead(join(cssDir, files[0]));
  }

  async writeSharedCss(themePath: string, themeName: string, css: string): Promise<void> {
    const cssDir = join(themePath, "css");
    mkdirSync(cssDir, { recursive: true });
    writeFileSync(join(cssDir, `${themeName}-theme.css`), css, "utf-8");
  }

  async readSharedJs(themePath: string, themeName: string): Promise<string> {
    const jsDir = join(themePath, "js");
    if (!existsSync(jsDir)) return "";
    const files = readdirSync(jsDir).filter((f) => f.endsWith("-animations.js"));
    if (files.length === 0) return "";
    return this.safeRead(join(jsDir, files[0]));
  }

  async writeSharedJs(themePath: string, themeName: string, js: string): Promise<void> {
    const jsDir = join(themePath, "js");
    mkdirSync(jsDir, { recursive: true });
    writeFileSync(join(jsDir, `${themeName}-animations.js`), js, "utf-8");
  }

  async readBrandAsset(themePath: string, filename: string): Promise<string | null> {
    const filePath = join(themePath, ".vibespot", filename);
    if (!existsSync(filePath)) return null;
    return this.safeRead(filePath) || null;
  }

  async writeBrandAsset(themePath: string, filename: string, content: string): Promise<void> {
    const dir = join(themePath, ".vibespot");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), content, "utf-8");
  }

  async deleteBrandAsset(themePath: string, filename: string): Promise<void> {
    const filePath = join(themePath, ".vibespot", filename);
    if (existsSync(filePath)) rmSync(filePath, { force: true });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private safeRead(filePath: string): string {
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return "";
    }
  }

  private readIndex(): SessionIndexEntry[] {
    try {
      if (!existsSync(this.indexPath)) return this.rebuildIndex();
      return JSON.parse(readFileSync(this.indexPath, "utf-8"));
    } catch {
      return this.rebuildIndex();
    }
  }

  private writeIndex(entries: SessionIndexEntry[]): void {
    try {
      mkdirSync(this.sessionsDir, { recursive: true });
      writeFileSync(this.indexPath, JSON.stringify(entries), "utf-8");
    } catch { /* non-critical */ }
  }

  private rebuildIndex(): SessionIndexEntry[] {
    if (!existsSync(this.sessionsDir)) return [];
    const entries: SessionIndexEntry[] = [];
    for (const f of readdirSync(this.sessionsDir).filter((f) => f.endsWith(".json") && f !== "_index.json")) {
      try {
        const data = JSON.parse(readFileSync(join(this.sessionsDir, f), "utf-8"));
        const templates = data.templates || [];
        entries.push({
          id: data.id,
          themeName: data.themeName,
          updatedAt: data.updatedAt,
          moduleCount: templates.reduce((n: number, t: any) => n + (t.modules?.length || 0), 0),
          templateCount: templates.length,
          pageCount: templates.filter((t: any) => t.contentMode !== "email").length,
          emailCount: templates.filter((t: any) => t.contentMode === "email").length,
          hasBrandAssets: !!(data.brandAssets && (data.brandAssets.styleguide || data.brandAssets.brandvoice || data.brandAssets.brandKit)),
          isImported: !!data.isImported,
        });
      } catch { /* skip corrupt files */ }
    }
    this.writeIndex(entries);
    return entries;
  }

  private upsertIndex(session: VibeSession): void {
    const entries = this.readIndex();
    const templates = session.templates || [];
    const entry: SessionIndexEntry = {
      id: session.id,
      themeName: session.themeName,
      updatedAt: session.updatedAt,
      moduleCount: templates.reduce((n, t) => n + (t.modules?.length || 0), 0),
      templateCount: templates.length,
      pageCount: templates.filter((t) => t.contentMode !== "email").length,
      emailCount: templates.filter((t) => t.contentMode === "email").length,
      hasBrandAssets: !!(session.brandAssets && (session.brandAssets.styleguide || session.brandAssets.brandvoice || session.brandAssets.brandKit)),
      isImported: !!session.isImported,
    };
    const idx = entries.findIndex((e) => e.id === session.id);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    this.writeIndex(entries);
  }

  private removeFromIndex(sessionId: string): void {
    const entries = this.readIndex().filter((e) => e.id !== sessionId);
    this.writeIndex(entries);
  }
}
