/**
 * Setup routes — onboarding flow in the browser.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";

// Windows needs shell to resolve .cmd/.bat from PATH; args array prevents injection
const _shellOpt: ExecFileSyncOptions = process.platform === "win32" ? { shell: true } : {};
import { jsonResponse, readBody } from "../route-helpers.js";
import { loadConfig, getHubSpotPak } from "../../utils/config.js";
import { createThemeScaffold, addEmailTemplateToTheme } from "../../hubspot/theme-scaffold.js";
import { fetchTheme } from "../../hubspot/fetcher.js";
import { getMetadata, listRootFolders } from "../../hubspot/api.js";
import {
  getSession,
  createSession,
  scanThemeFromDisk,
  saveSession,
  loadSession,
  listSessions,
  writeModulesToDisk,
} from "../session.js";
import { isGenerating } from "../ai-handler.js";
import { detectEnvironment } from "../../utils/detect.js";
import { saveConfig } from "../../utils/config.js";
import { ensureDir } from "../../utils/fs.js";
import { listStarters, getStarter } from "../starters.js";
import { getServerContentMode } from "../server.js";
import { enrichImportedThemeBrandAssets } from "../brand-enrichment.js";

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
    execFileSync("hs", ["--version"], { encoding: "utf-8", stdio: "pipe", ..._shellOpt });
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
      isImported: !!session.isImported,
    } : null,
    hsInstalled,
    aiAvailable: env.availableEngines.length > 0,
    availableEngines: env.availableEngines,
    activeEngine: env.activeEngine,
    sessions,
    localThemes,
    contentMode: getServerContentMode(),
  });
}

export function handleSetupCreateRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      if (isGenerating()) { jsonResponse(res, 409, { error: "Cannot switch projects while AI is generating.", generating: true }); return; }
      const { name, starterId } = JSON.parse(body);
      if (!name || typeof name !== "string") {
        jsonResponse(res, 400, { error: "Theme name is required" });
        return;
      }

      const themeName = name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      if (!themeName) {
        jsonResponse(res, 400, { error: "Theme name must contain at least one alphanumeric character" });
        return;
      }

      const themePath = join(WORKSPACE_DIR, themeName);
      ensureDir(WORKSPACE_DIR);

      if (existsSync(themePath)) {
        rmSync(themePath, { recursive: true, force: true });
      }

      if (starterId && typeof starterId === "string" && !getStarter(starterId)) {
        jsonResponse(res, 400, { error: `Starter template "${starterId}" not found` });
        return;
      }

      createThemeScaffold(themePath, themeName);
      createSession(themePath, themeName);

      if (starterId && typeof starterId === "string") {
        bootstrapFromStarter(themePath, themeName, starterId);
        writeModulesToDisk();
      }

      saveSession();

      jsonResponse(res, 200, {
        ok: true,
        themeName,
        themePath,
        starterId: starterId || undefined,
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function bootstrapFromStarter(themePath: string, themeName: string, starterId: string): void {
  const starter = getStarter(starterId);
  if (!starter) return;

  const session = getSession();
  if (!session) return;

  const isEmail = starter.contentType === "email";
  const modules = starter.modules.map((m) => ({ ...m }));
  const moduleOrder = [...starter.moduleOrder];
  const templateId = isEmail ? `email-${themeName}` : `lp-${themeName}`;

  const entry: import("../session/types.js").TemplateEntry = {
    id: templateId,
    label: `${starter.name}`,
    pageType: isEmail ? "module_only" : "landing_page",
    contentMode: isEmail ? "email" : undefined,
    templateFile: isEmail ? `templates/email.html` : `templates/${templateId}.html`,
    modules,
    moduleOrder,
    sharedCss: starter.sharedCss,
    sharedJs: starter.sharedJs,
    template: "",
    messages: [],
  };

  if (isEmail) {
    addEmailTemplateToTheme(themePath, themeName);
  }

  session.templates = [entry];
  session.activeTemplateId = templateId;

  session.modules = modules;
  session.moduleOrder = moduleOrder;
  session.sharedCss = starter.sharedCss;
  session.sharedJs = starter.sharedJs;

  const modulesDir = join(themePath, "modules");
  mkdirSync(modulesDir, { recursive: true });

  for (const mod of starter.modules) {
    const modDir = join(modulesDir, `${mod.moduleName}.module`);
    mkdirSync(modDir, { recursive: true });
    writeFileSync(join(modDir, "fields.json"), mod.fieldsJson, "utf-8");
    writeFileSync(join(modDir, "meta.json"), mod.metaJson, "utf-8");
    writeFileSync(join(modDir, "module.html"), mod.moduleHtml, "utf-8");
    writeFileSync(join(modDir, "module.css"), mod.moduleCss, "utf-8");
    if (mod.moduleJs) writeFileSync(join(modDir, "module.js"), mod.moduleJs, "utf-8");
  }

  if (starter.sharedCss) {
    const cssDir = join(themePath, "css");
    mkdirSync(cssDir, { recursive: true });
    writeFileSync(join(cssDir, `${themeName}-theme.css`), starter.sharedCss, "utf-8");
  }

  if (starter.sharedJs) {
    const jsDir = join(themePath, "js");
    mkdirSync(jsDir, { recursive: true });
    writeFileSync(join(jsDir, `${themeName}-animations.js`), starter.sharedJs, "utf-8");
  }
}

export function handleStartersListRoute(res: ServerResponse): void {
  jsonResponse(res, 200, { starters: listStarters() });
}

export function handleSetupFetchRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      if (isGenerating()) { jsonResponse(res, 409, { error: "Cannot switch projects while AI is generating.", generating: true }); return; }
      const { name: rawName } = JSON.parse(body);
      if (!rawName || typeof rawName !== "string") {
        jsonResponse(res, 400, { error: "Theme name is required" });
        return;
      }

      // Strip leading/trailing slashes (HubSpot DM "Copy path" gives "/theme-name")
      const name = rawName.replace(/^\/+|\/+$/g, "");
      if (!name) {
        jsonResponse(res, 400, { error: "Theme name is required" });
        return;
      }

      const pak = getHubSpotPak();
      const config = loadConfig();

      // Sanitize for local directory name (marketplace paths like @marketplace/Theme → _marketplace_Theme)
      const safeDirName = name.includes("/") || name.includes("@")
        ? name.replace(/[@/]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")
        : name;
      const themePath = join(WORKSPACE_DIR, safeDirName);
      ensureDir(WORKSPACE_DIR);

      if (config.hubspotUploadMode === "cli" || !pak) {
        // CLI fallback
        (async () => {
          execFileSync("hs", ["cms", "fetch", name, themePath], {
            encoding: "utf-8",
            stdio: "pipe",
            ..._shellOpt,
          });

          const result = await finalizeFetchedTheme(themePath, safeDirName);
          jsonResponse(res, 200, {
            ok: true,
            themeName: safeDirName,
            themePath,
            moduleCount: result.moduleCount,
            brandEnrichment: result.brandEnrichment,
          });
        })().catch((err) => {
          jsonResponse(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } else {
        // API mode (default) — use original name for API, safe name for local
        fetchTheme(pak, name, themePath)
          .then(async () => {
            const result = await finalizeFetchedTheme(themePath, safeDirName);
            jsonResponse(res, 200, {
              ok: true,
              themeName: safeDirName,
              themePath,
              moduleCount: result.moduleCount,
              brandEnrichment: result.brandEnrichment,
            });
          })
          .catch((err) => {
            jsonResponse(res, 500, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
    } catch (err) {
      jsonResponse(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

async function finalizeFetchedTheme(themePath: string, themeName: string): Promise<{
  moduleCount: number;
  brandEnrichment: Awaited<ReturnType<typeof enrichImportedThemeBrandAssets>>;
}> {
  createSession(themePath, themeName, { isImported: true });
  scanThemeFromDisk(themePath);
  saveSession();

  const session = getSession();
  let brandEnrichment: Awaited<ReturnType<typeof enrichImportedThemeBrandAssets>> = {
    attempted: [],
    extracted: [],
    skipped: [],
    errors: [],
  };

  if (session) {
    brandEnrichment = await enrichImportedThemeBrandAssets(session);
    saveSession();
  }

  return {
    moduleCount: session?.modules.length || 0,
    brandEnrichment,
  };
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

      // Restrict to workspace directory to prevent arbitrary filesystem access
      const resolved = resolve(fullPath);
      const workspace = resolve(WORKSPACE_DIR);
      if (!resolved.startsWith(workspace + "/") && resolved !== workspace) {
        jsonResponse(res, 403, { error: "Path outside workspace" });
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

/**
 * List themes available on HubSpot Design Manager.
 * Returns folders at the root level that look like themes (contain theme.json).
 */
export function handleSetupRemoteThemesRoute(res: ServerResponse): void {
  const pak = getHubSpotPak();
  if (!pak) {
    jsonResponse(res, 200, { themes: [], error: "No HubSpot account connected" });
    return;
  }

  (async () => {
    const folders = await listRootFolders(pak);

    if (folders.length === 0) {
      jsonResponse(res, 200, { themes: [] });
      return;
    }

    const themes: Array<{ name: string; path: string }> = [];

    // Check which folders have a theme.json (in parallel)
    const checks = folders.map(async (folder) => {
      const folderPath = folder.path || folder.name;
      try {
        const tjMeta = await getMetadata(pak, `${folderPath}/theme.json`);
        if (tjMeta && !tjMeta.folder) {
          themes.push({ name: folder.name, path: folderPath });
        }
      } catch { /* not a theme */ }
    });

    await Promise.all(checks);
    themes.sort((a, b) => a.name.localeCompare(b.name));

    const localThemes = getLocalThemes();
    const localNames = new Set(localThemes.map((t) => t.name));

    jsonResponse(res, 200, {
      themes: themes.map((t) => ({
        ...t,
        existsLocally: localNames.has(t.name),
      })),
    });
  })().catch((err) => {
    jsonResponse(res, 200, {
      themes: [],
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
