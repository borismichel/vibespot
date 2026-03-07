/**
 * Setup routes — onboarding flow in the browser.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readdirSync, rmSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { jsonResponse, readBody } from "../route-helpers.js";
import {
  getSession,
  createSession,
  scanThemeFromDisk,
  saveSession,
  loadSession,
  listSessions,
} from "../session.js";
import { isGenerating } from "../ai-handler.js";
import { detectEnvironment } from "../../utils/detect.js";
import { saveConfig } from "../../utils/config.js";
import { ensureDir } from "../../utils/fs.js";

export const WORKSPACE_DIR = join(homedir(), "vibespot-themes");

let _themeListCache: { data: Array<{ name: string; moduleCount: number }>; ts: number } | null = null;
const THEME_LIST_TTL = 5000;

export function getLocalThemes(): Array<{ name: string; moduleCount: number }> {
  if (_themeListCache && Date.now() - _themeListCache.ts < THEME_LIST_TTL) return _themeListCache.data;
  const themes: Array<{ name: string; moduleCount: number }> = [];
  if (existsSync(WORKSPACE_DIR)) {
    try {
      for (const entry of readdirSync(WORKSPACE_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const themeJson = join(WORKSPACE_DIR, entry.name, "theme.json");
          if (existsSync(themeJson)) {
            let moduleCount = 0;
            const modulesDir = join(WORKSPACE_DIR, entry.name, "modules");
            if (existsSync(modulesDir)) {
              try {
                moduleCount = readdirSync(modulesDir, { withFileTypes: true })
                  .filter((e) => e.isDirectory()).length;
              } catch { /* ignore */ }
            }
            themes.push({ name: entry.name, moduleCount });
          }
        }
      }
    } catch { /* ignore */ }
  }
  _themeListCache = { data: themes, ts: Date.now() };
  return themes;
}

export function handleSetupInfoRoute(res: ServerResponse): void {
  const session = getSession();
  const env = detectEnvironment();

  let hsInstalled = false;
  try {
    execSync("hs --version", { encoding: "utf-8", stdio: "pipe" });
    hsInstalled = true;
  } catch { /* not installed */ }

  const sessions = listSessions()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10);

  const localThemes = getLocalThemes();

  jsonResponse(res, 200, {
    hasActiveSession: !!session,
    activeSession: session ? {
      id: session.id,
      themeName: session.themeName,
      moduleCount: session.modules.length,
    } : null,
    hsInstalled,
    aiAvailable: env.availableEngines.length > 0,
    availableEngines: env.availableEngines,
    activeEngine: env.activeEngine,
    sessions,
    localThemes,
  });
}

export function handleSetupCreateRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      if (isGenerating()) { jsonResponse(res, 409, { error: "Cannot switch projects while AI is generating.", generating: true }); return; }
      const { name } = JSON.parse(body);
      if (!name || typeof name !== "string") {
        jsonResponse(res, 400, { error: "Theme name is required" });
        return;
      }

      const themeName = name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      const themePath = join(WORKSPACE_DIR, themeName);
      ensureDir(WORKSPACE_DIR);

      if (existsSync(themePath)) {
        rmSync(themePath, { recursive: true, force: true });
      }

      const cwdBefore = new Set(readdirSync(process.cwd()));
      execSync(`hs cms theme create "${themeName}"`, {
        encoding: "utf-8",
        stdio: "pipe",
      });

      let createdAt = join(process.cwd(), themeName);
      if (!existsSync(createdAt)) {
        const cwdAfter = readdirSync(process.cwd());
        const newDir = cwdAfter.find((e) => !cwdBefore.has(e) && existsSync(join(process.cwd(), e)));
        if (newDir) createdAt = join(process.cwd(), newDir);
      }

      if (createdAt !== themePath && existsSync(createdAt)) {
        renameSync(createdAt, themePath);
      }

      const tplDir = join(themePath, "templates");
      if (existsSync(tplDir)) {
        for (const f of readdirSync(tplDir)) {
          if (f.endsWith(".html")) rmSync(join(tplDir, f));
        }
      }

      createSession(themePath, themeName);
      saveSession();

      jsonResponse(res, 200, {
        ok: true,
        themeName,
        themePath,
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleSetupFetchRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      if (isGenerating()) { jsonResponse(res, 409, { error: "Cannot switch projects while AI is generating.", generating: true }); return; }
      const { name } = JSON.parse(body);
      if (!name || typeof name !== "string") {
        jsonResponse(res, 400, { error: "Theme name is required" });
        return;
      }

      const themePath = join(WORKSPACE_DIR, name);
      ensureDir(WORKSPACE_DIR);

      execSync(`hs cms fetch "${name}" "${themePath}"`, {
        encoding: "utf-8",
        stdio: "pipe",
      });

      createSession(themePath, name);
      scanThemeFromDisk(themePath);
      saveSession();

      jsonResponse(res, 200, {
        ok: true,
        themeName: name,
        themePath,
        moduleCount: getSession()?.modules.length || 0,
      });
    } catch (err) {
      jsonResponse(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export function handleSetupOpenRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      if (isGenerating()) { jsonResponse(res, 409, { error: "Cannot switch projects while AI is generating.", generating: true }); return; }
      const { path: themePath } = JSON.parse(body);
      if (!themePath || typeof themePath !== "string") {
        jsonResponse(res, 400, { error: "Theme path is required" });
        return;
      }

      let fullPath = themePath;
      if (!existsSync(fullPath)) {
        fullPath = join(WORKSPACE_DIR, themePath);
      }
      if (!existsSync(fullPath)) {
        jsonResponse(res, 400, { error: `Theme folder not found: ${themePath}` });
        return;
      }

      const themeName = basename(fullPath);
      createSession(fullPath, themeName);
      scanThemeFromDisk(fullPath);
      saveSession();

      jsonResponse(res, 200, {
        ok: true,
        themeName,
        themePath: fullPath,
        moduleCount: getSession()?.modules.length || 0,
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleSetupResumeRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      if (isGenerating()) { jsonResponse(res, 409, { error: "Cannot switch projects while AI is generating.", generating: true }); return; }
      const { sessionId } = JSON.parse(body);
      if (!sessionId || typeof sessionId !== "string") {
        jsonResponse(res, 400, { error: "Session ID is required" });
        return;
      }

      const session = loadSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: "Session not found" });
        return;
      }

      jsonResponse(res, 200, {
        ok: true,
        themeName: session.themeName,
        themePath: session.themePath,
        moduleCount: session.modules.length,
        messageCount: session.messages.length,
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleSetupApiKeyRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { apiKey } = JSON.parse(body);
      if (!apiKey || typeof apiKey !== "string") {
        jsonResponse(res, 400, { error: "API key is required" });
        return;
      }

      saveConfig({ anthropicApiKey: apiKey });
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
