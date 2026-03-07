/**
 * Dashboard & template routes — CRUD, activate, rename, module library, brand assets, download.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { jsonResponse, readBody } from "../route-helpers.js";
import { log } from "../log.js";
import {
  getSession,
  saveSession,
  getOrderedModules,
  getActiveTemplate,
  setActiveTemplate,
  addTemplate,
  removeTemplate,
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

    execSync(
      `zip -r "${zipFileName}" "${folderName}" -x "${folderName}/.git/*" "${folderName}/.vibespot/*" "${folderName}/node_modules/*"`,
      { cwd: parentDir, timeout: 30_000 }
    );

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
        if (type !== "styleguide" && type !== "brandvoice") {
          jsonResponse(res, 400, { error: `Invalid type: ${type}. Must be "styleguide" or "brandvoice"` });
          return;
        }

        session.brandAssets[type] = content;
        session.updatedAt = Date.now();

        const assetDir = join(session.themePath, ".vibespot");
        ensureDir(assetDir);
        writeFile(join(assetDir, `${type}.md`), content);

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
        if (type !== "styleguide" && type !== "brandvoice") {
          jsonResponse(res, 400, { error: `Invalid type: ${type}` });
          return;
        }

        if (session.brandAssets) {
          delete session.brandAssets[type];
        }
        session.updatedAt = Date.now();

        const filePath = join(session.themePath, ".vibespot", `${type}.md`);
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
