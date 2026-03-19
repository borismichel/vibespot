/**
 * Dashboard & template routes — CRUD, activate, rename, module library, brand assets, download.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";

const _shellOpt: ExecFileSyncOptions = process.platform === "win32" ? { shell: true } : {};
import { jsonResponse, readBody } from "../route-helpers.js";
import { log } from "../log.js";
import { getHubSpotPak } from "../../utils/config.js";
import {
  getSession,
  saveSession,
  getOrderedModules,
  getActiveTemplate,
  setActiveTemplate,
  addTemplate,
  removeTemplate,
  cloneTemplate,
  getModuleLibrary,
  renameTemplate,
  type PageType,
} from "../session.js";
import { ensureDir, writeFile } from "../../utils/fs.js";

export function handleDashboardRoute(res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  const library = getModuleLibrary();
  jsonResponse(res, 200, {
    themeName: session.themeName,
    themePath: session.themePath,
    templates: session.templates.map((t) => ({
      id: t.id,
      label: t.label,
      pageType: t.pageType,
      moduleCount: t.modules.length,
      messageCount: t.messages.length,
    })),
    activeTemplateId: session.activeTemplateId,
    moduleLibrary: library.map((entry) => ({
      moduleName: entry.module.moduleName,
      usedIn: entry.usedIn,
    })),
    brandAssets: {
      hasStyleguide: !!session.brandAssets?.styleguide,
      hasBrandvoice: !!session.brandAssets?.brandvoice,
      hasThemeContext: !!session.brandAssets?.themeContext,
      humanify: session.brandAssets?.humanify !== false,
    },
  });
}

export function handleDownloadZipRoute(res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  const themePath = session.themePath;
  if (!existsSync(themePath)) {
    jsonResponse(res, 404, { error: "Theme directory not found" });
    return;
  }

  const themeName = session.themeName || "theme";
  const parentDir = join(themePath, "..");
  const folderName = basename(themePath);

  try {
    const zipFileName = `${themeName}.zip`;
    const tmpZip = join(parentDir, zipFileName);

    if (existsSync(tmpZip)) rmSync(tmpZip);

    execFileSync("zip", [
      "-r", zipFileName, folderName,
      "-x", `${folderName}/.git/*`, `${folderName}/.vibespot/*`, `${folderName}/node_modules/*`,
    ], { cwd: parentDir, timeout: 30_000, ..._shellOpt });

    const zipData = readFileSync(tmpZip);
    rmSync(tmpZip);

    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipFileName}"`,
      "Content-Length": zipData.length,
    });
    res.end(zipData);
  } catch (err: any) {
    log.error("download-zip", "Failed to create zip archive", err);
    jsonResponse(res, 500, { error: "Failed to create zip archive" });
  }
}

export function handleTemplatesRoute(method: string, req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  if (method === "GET") {
    jsonResponse(res, 200, {
      templates: session.templates.map((t) => ({
        id: t.id,
        label: t.label,
        pageType: t.pageType,
        moduleCount: t.modules.length,
      })),
      activeTemplateId: session.activeTemplateId,
    });
    return;
  }

  if (method === "POST") {
    readBody(req, (body) => {
      try {
        const { pageType, label } = JSON.parse(body);
        if (!pageType || !label) {
          jsonResponse(res, 400, { error: "pageType and label are required" });
          return;
        }
        const validTypes: PageType[] = ["landing_page", "blog_post", "website_page", "module_only"];
        if (!validTypes.includes(pageType)) {
          jsonResponse(res, 400, { error: `Invalid pageType: ${pageType}` });
          return;
        }

        const entry = addTemplate(pageType, label);
        saveSession();

        jsonResponse(res, 200, {
          ok: true,
          template: {
            id: entry.id,
            label: entry.label,
            pageType: entry.pageType,
          },
        });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  if (method === "DELETE") {
    readBody(req, (body) => {
      try {
        const { templateId } = JSON.parse(body);
        if (!templateId) {
          jsonResponse(res, 400, { error: "templateId is required" });
          return;
        }
        const removed = removeTemplate(templateId);
        if (!removed) {
          jsonResponse(res, 404, { error: "Template not found" });
          return;
        }
        saveSession();
        jsonResponse(res, 200, { ok: true });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  jsonResponse(res, 405, { error: "Method not allowed" });
}

export function handleTemplateActivateRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { templateId } = JSON.parse(body);
      if (!templateId) {
        jsonResponse(res, 400, { error: "templateId is required" });
        return;
      }
      const success = setActiveTemplate(templateId);
      if (!success) {
        jsonResponse(res, 404, { error: "Template not found" });
        return;
      }
      saveSession();
      const session = getSession();
      jsonResponse(res, 200, {
        ok: true,
        modules: getOrderedModules().map((m) => m.moduleName),
        messageCount: session?.messages.length || 0,
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleTemplateRenameRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { templateId, newLabel } = JSON.parse(body);
      if (!templateId || !newLabel || typeof newLabel !== "string") {
        jsonResponse(res, 400, { error: "templateId and newLabel are required" });
        return;
      }
      const success = renameTemplate(templateId, newLabel.trim());
      if (!success) {
        jsonResponse(res, 404, { error: "Template not found" });
        return;
      }
      saveSession();
      jsonResponse(res, 200, { ok: true, newLabel: newLabel.trim() });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleTemplateCloneRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { templateId, label } = JSON.parse(body);
      if (!templateId) {
        jsonResponse(res, 400, { error: "templateId is required" });
        return;
      }
      const entry = cloneTemplate(templateId, label);
      if (!entry) {
        jsonResponse(res, 404, { error: "Template not found" });
        return;
      }
      saveSession();
      jsonResponse(res, 200, {
        ok: true,
        template: {
          id: entry.id,
          label: entry.label,
          pageType: entry.pageType,
          moduleCount: entry.modules.length,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleModuleLibraryRoute(res: ServerResponse): void {
  const library = getModuleLibrary();
  jsonResponse(res, 200, {
    modules: library.map((entry) => ({
      moduleName: entry.module.moduleName,
      usedIn: entry.usedIn,
      fieldsJson: entry.module.fieldsJson,
    })),
  });
}

export function handleAddModuleToTemplateRoute(path: string, req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  readBody(req, (body) => {
    try {
      const { moduleName } = JSON.parse(body);
      if (!moduleName) {
        jsonResponse(res, 400, { error: "moduleName is required" });
        return;
      }

      const library = getModuleLibrary();
      const entry = library.find((e) => e.module.moduleName === moduleName);
      if (!entry) {
        jsonResponse(res, 404, { error: `Module "${moduleName}" not found in library` });
        return;
      }

      const modCopy = { ...entry.module };
      const existing = session.modules.find((m) => m.moduleName === modCopy.moduleName);
      if (!existing) {
        session.modules.push(modCopy);
        session.moduleOrder.push(modCopy.moduleName);
        session.updatedAt = Date.now();
      }

      saveSession();
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleBrandAssetsRoute(method: string, req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  if (method === "GET") {
    jsonResponse(res, 200, {
      styleguide: session.brandAssets?.styleguide || null,
      brandvoice: session.brandAssets?.brandvoice || null,
      themeContext: session.brandAssets?.themeContext || null,
    });
    return;
  }

  if (method === "POST") {
    readBody(req, (body) => {
      try {
        const { type, content } = JSON.parse(body);
        if (!type) {
          jsonResponse(res, 400, { error: "type is required" });
          return;
        }

        if (!session.brandAssets) session.brandAssets = {};

        if (type === "humanify") {
          session.brandAssets.humanify = content === "on";
          session.updatedAt = Date.now();
          saveSession();
          jsonResponse(res, 200, { ok: true });
          return;
        }

        if (!content) {
          jsonResponse(res, 400, { error: "content is required" });
          return;
        }
        if (type !== "styleguide" && type !== "brandvoice" && type !== "themeContext") {
          jsonResponse(res, 400, { error: `Invalid type: ${type}. Must be "styleguide", "brandvoice", or "themeContext"` });
          return;
        }

        const filename = type === "themeContext" ? "theme-context.md" : `${type}.md`;
        session.brandAssets[type] = content;
        session.updatedAt = Date.now();

        const assetDir = join(session.themePath, ".vibespot");
        ensureDir(assetDir);
        writeFile(join(assetDir, filename), content);

        saveSession();
        jsonResponse(res, 200, { ok: true });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  if (method === "DELETE") {
    readBody(req, (body) => {
      try {
        const { type } = JSON.parse(body);
        if (type !== "styleguide" && type !== "brandvoice" && type !== "themeContext") {
          jsonResponse(res, 400, { error: `Invalid type: ${type}` });
          return;
        }

        if (session.brandAssets) {
          delete session.brandAssets[type];
        }
        session.updatedAt = Date.now();

        const delFilename = type === "themeContext" ? "theme-context.md" : `${type}.md`;
        const filePath = join(session.themePath, ".vibespot", delFilename);
        if (existsSync(filePath)) rmSync(filePath);

        saveSession();
        jsonResponse(res, 200, { ok: true });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  jsonResponse(res, 405, { error: "Method not allowed" });
}

// ---------------------------------------------------------------------------
// Brand asset extraction from theme
// ---------------------------------------------------------------------------

/** Save a single brand asset to session + disk. */
function saveBrandAsset(
  session: ReturnType<typeof getSession>,
  type: "styleguide" | "brandvoice" | "themeContext",
  content: string,
): void {
  if (!session) return;
  if (!session.brandAssets) session.brandAssets = {};
  session.brandAssets[type] = content;
  session.updatedAt = Date.now();

  const filename = type === "themeContext" ? "theme-context.md" : `${type}.md`;
  const assetDir = join(session.themePath, ".vibespot");
  ensureDir(assetDir);
  writeFile(join(assetDir, filename), content);
}

/** Extract a single brand asset by type. */
async function extractSingleAsset(
  session: NonNullable<ReturnType<typeof getSession>>,
  type: "styleguide" | "brandvoice" | "themeContext",
  sourcePath?: string,
): Promise<string | null> {
  if (type === "styleguide") {
    const { extractDesignContext } = await import("../../ai/design-extractor.js");
    return extractDesignContext(sourcePath || session.themePath);
  }

  // brandvoice and themeContext need AI + rendered preview HTML
  const { resolveAgenticEngine } = await import("../ai-handler.js");
  const { loadConfig } = await import("../../utils/config.js");
  const config = loadConfig();
  const { engine, apiKey, model } = resolveAgenticEngine(config);

  const { buildPreviewHtml } = await import("../preview.js");
  const previewHtml = buildPreviewHtml();
  if (!previewHtml || previewHtml.length < 50) return null;

  if (type === "brandvoice") {
    const { extractBrandvoice } = await import("../agent/stages/brandvoice-extractor.js");
    return extractBrandvoice(previewHtml, engine, apiKey, model);
  }

  // themeContext
  const { extractThemeContext } = await import("../agent/stages/context-extractor.js");
  return extractThemeContext(previewHtml, session.brandAssets?.themeContext, engine, apiKey, model);
}

export function handleDesignExtractRoute(req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  readBody(req, (body) => {
    (async () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const type = parsed.type || "styleguide";
        const sourcePath = parsed.sourcePath;

        if (type === "all") {
          // Extract all three in parallel
          const types = ["styleguide", "brandvoice", "themeContext"] as const;
          const results = await Promise.allSettled(
            types.map((t) => extractSingleAsset(session, t, sourcePath)),
          );

          const extracted: Record<string, string | null> = {};
          for (let i = 0; i < types.length; i++) {
            const r = results[i];
            const content = r.status === "fulfilled" ? r.value : null;
            if (content) {
              saveBrandAsset(session, types[i], content);
            }
            extracted[types[i]] = content;
          }

          saveSession();
          jsonResponse(res, 200, { ok: true, type: "all", extracted });
          return;
        }

        if (type !== "styleguide" && type !== "brandvoice" && type !== "themeContext") {
          jsonResponse(res, 400, { error: `Invalid type: ${type}` });
          return;
        }

        const content = await extractSingleAsset(session, type, sourcePath);
        if (!content) {
          jsonResponse(res, 200, { ok: false, type, error: "No content to extract from" });
          return;
        }

        saveBrandAsset(session, type, content);
        saveSession();
        jsonResponse(res, 200, { ok: true, type, content });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Reference theme import — download from HubSpot + extract design
// ---------------------------------------------------------------------------

export function handleReferenceImportRoute(req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  readBody(req, (body) => {
    (async () => {
      try {
        const { source, themeName, localPath } = JSON.parse(body);

        let sourcePath: string;

        if (source === "hubspot") {
          // Download theme from HubSpot to temp location
          if (!themeName) {
            jsonResponse(res, 400, { error: "themeName is required for HubSpot import" });
            return;
          }
          const pak = getHubSpotPak();
          if (!pak) {
            jsonResponse(res, 400, { error: "No HubSpot account connected" });
            return;
          }

          // Strip leading/trailing slashes (HubSpot DM "Copy path" gives "/@marketplace/Theme")
          const cleanName = themeName.replace(/^\/+|\/+$/g, "");
          if (!cleanName) {
            jsonResponse(res, 400, { error: "Invalid theme name" });
            return;
          }

          // Sanitize for local directory name (replace @ and / with safe chars)
          const safeDirName = cleanName.replace(/[@/]/g, "_").replace(/_+/g, "_");
          const { homedir } = await import("node:os");
          const refDir = join(homedir(), "vibespot-themes", ".references", safeDirName);
          ensureDir(refDir);

          const { fetchTheme } = await import("../../hubspot/fetcher.js");
          await fetchTheme(pak, cleanName, refDir);
          sourcePath = refDir;
        } else if (source === "local") {
          if (!localPath) {
            jsonResponse(res, 400, { error: "localPath is required for local import" });
            return;
          }
          if (!existsSync(localPath)) {
            jsonResponse(res, 400, { error: `Path not found: ${localPath}` });
            return;
          }
          sourcePath = localPath;
        } else {
          jsonResponse(res, 400, { error: "source must be 'hubspot' or 'local'" });
          return;
        }

        // Extract design context and save to current theme
        const { extractDesignContext } = await import("../../ai/design-extractor.js");
        const styleguide = await extractDesignContext(sourcePath);

        if (!session.brandAssets) session.brandAssets = {};
        session.brandAssets.styleguide = styleguide;
        session.updatedAt = Date.now();

        const assetDir = join(session.themePath, ".vibespot");
        ensureDir(assetDir);
        writeFile(join(assetDir, "styleguide.md"), styleguide);

        saveSession();
        jsonResponse(res, 200, { ok: true, styleguide, source: sourcePath });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}
