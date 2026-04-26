/**
 * Module, field, import, session, upload, and history routes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { jsonResponse, readBody, readJsonBody } from "../route-helpers.js";
import {
  getSession,
  getOrderedModules,
  removeModule,
  detachModule,
  reorderModules,
  updateFieldValue,
  saveSession,
  writeModulesToDisk,
  addMessage,
  reloadModulesFromDisk,
  reloadActiveTemplateFromDisk,
  getActiveTemplate,
  syncFlatFieldsToTemplate,
} from "../session.js";
import { isGenerating } from "../ai-handler.js";
import { applyAutoFixes } from "../auto-fix.js";
import { startStreamingJob } from "../process-manager.js";
import { analyzeSource } from "../../wizard/source.js";
import { commitThemeState, commitTemplateState, getHistory, getTemplateHistory, rollbackToCommit, rollbackTemplateToCommit, isGitAvailable } from "../project-git.js";

export function handleSessionRoute(method: string, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  jsonResponse(res, 200, {
    id: session.id,
    themeName: session.themeName,
    themePath: session.themePath,
    messageCount: session.messages.length,
    moduleCount: session.modules.length,
    moduleOrder: session.moduleOrder,
  });
}

export function handleModulesRoute(
  method: string,
  req: IncomingMessage,
  res: ServerResponse
): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  if (method === "GET") {
    const ordered = getOrderedModules();
    jsonResponse(res, 200, {
      modules: ordered.map((m) => ({
        moduleName: m.moduleName,
        fieldsJson: m.fieldsJson,
        moduleHtml: m.moduleHtml,
        moduleCss: m.moduleCss,
        moduleJs: m.moduleJs || null,
      })),
      sharedCss: session.sharedCss,
      sharedJs: session.sharedJs,
    });
    return;
  }

  if (method === "DELETE") {
    readJsonBody(req, res, (data: { moduleName: string; deleteEntirely?: boolean }) => {
      if (data.deleteEntirely) {
        removeModule(data.moduleName);
      } else {
        detachModule(data.moduleName);
      }
      saveSession();
      jsonResponse(res, 200, { ok: true });
    });
    return;
  }

  jsonResponse(res, 405, { error: "Method not allowed" });
}

export function handleCodeUpdateRoute(req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  readBody(req, (body) => {
    try {
      const data = JSON.parse(body);

      // Shared CSS/JS
      if (data.shared) {
        if (data.shared === "css") {
          session.sharedCss = data.content;
        } else if (data.shared === "js") {
          session.sharedJs = data.content;
        } else {
          jsonResponse(res, 400, { error: "Invalid shared type" });
          return;
        }
        // Also update the active template's shared fields
        const tpl = getActiveTemplate();
        if (tpl) {
          if (data.shared === "css") tpl.sharedCss = data.content;
          else tpl.sharedJs = data.content;
        }
        session.updatedAt = Date.now();
        syncFlatFieldsToTemplate();
        saveSession();
        writeModulesToDisk();
        jsonResponse(res, 200, { ok: true });
        return;
      }

      // Module file
      const { moduleName, fileType, content } = data;
      if (!moduleName || !fileType) {
        jsonResponse(res, 400, { error: "moduleName and fileType required" });
        return;
      }

      const mod = session.modules.find((m) => m.moduleName === moduleName);
      if (!mod) {
        jsonResponse(res, 404, { error: `Module "${moduleName}" not found` });
        return;
      }

      switch (fileType) {
        case "html": mod.moduleHtml = content; break;
        case "css": mod.moduleCss = content; break;
        case "js": mod.moduleJs = content || undefined; break;
        case "fields":
          // Validate JSON before saving
          try { JSON.parse(content); } catch {
            jsonResponse(res, 400, { error: "Invalid JSON in fields.json" });
            return;
          }
          mod.fieldsJson = content;
          break;
        default:
          jsonResponse(res, 400, { error: `Invalid fileType: ${fileType}` });
          return;
      }

      session.updatedAt = Date.now();
      syncFlatFieldsToTemplate();
      saveSession();
      writeModulesToDisk();
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 400, { error: String(err) });
    }
  });
}

export function handleReorderRoute(req: IncomingMessage, res: ServerResponse): void {
  readJsonBody(req, res, (data: { order: unknown }) => {
    if (Array.isArray(data.order)) {
      reorderModules(data.order);
      saveSession();
      jsonResponse(res, 200, { ok: true });
    } else {
      jsonResponse(res, 400, { error: "order must be an array" });
    }
  });
}

export async function handleUploadRoute(res: ServerResponse): Promise<void> {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  try {
    writeModulesToDisk();
    const fixes = applyAutoFixes(session.themePath);

    const jobId = startStreamingJob(
      `hs cms upload "${session.themePath}" "${session.themeName}"`,
      "Uploading to HubSpot",
      { cwd: join(session.themePath, ".."), timeout: 180_000 }
    );

    jsonResponse(res, 200, {
      ok: true,
      jobId,
      fixes,
    });
  } catch (err) {
    jsonResponse(res, 500, { error: String(err) });
  }
}

export function handleFieldRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { moduleName, fieldPath, value } = JSON.parse(body);
      updateFieldValue(moduleName, fieldPath, value);
      saveSession();
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 400, { error: String(err) });
    }
  });
}

export function handleImportRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { url } = JSON.parse(body);
      if (!url || typeof url !== "string") {
        jsonResponse(res, 400, { error: "url is required" });
        return;
      }

      const analysis = analyzeSource(url);

      const componentSummary = analysis.components
        .map((c) => `- ${c.name}: ${c.description}`)
        .join("\n");

      const summary = {
        sourceDir: analysis.sourceDir,
        componentCount: analysis.components.length,
        components: analysis.components.map((c) => ({
          name: c.name,
          description: c.description,
        })),
        hasTailwind: analysis.hasTailwind,
        cssVarCount: analysis.cssVarCount,
        fonts: analysis.fonts,
        interactions: analysis.interactions,
        conversionPrompt: `Import and convert the React landing page from ${url} to native HubSpot modules.

Source analysis found ${analysis.components.length} components:
${componentSummary}

Design system: ${analysis.hasTailwind ? "Tailwind CSS" : "Custom CSS"}, ${analysis.cssVarCount} CSS variables
Fonts: ${analysis.fonts.length > 0 ? analysis.fonts.join(", ") : "System fonts"}
Interactions: ${analysis.interactions.join(", ")}

Read the React source files from ${analysis.sourceDir} and convert each component to a HubSpot module. Preserve the design, layout, colors, and content. Generate fields.json so marketers can edit all text, images, colors, and links in the HubSpot page editor.`,
      };

      jsonResponse(res, 200, summary);
    } catch (err) {
      jsonResponse(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Version history routes
// ---------------------------------------------------------------------------

export function handleHistoryRoute(req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }
  if (!isGitAvailable()) {
    jsonResponse(res, 200, { available: false, commits: [] });
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  const templateId = url.searchParams.get("templateId");

  const commits = templateId
    ? getTemplateHistory(session.themePath, templateId, 50)
    : getHistory(session.themePath, 50);
  jsonResponse(res, 200, { available: true, commits, filtered: !!templateId });
}

export function handleRollbackRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const session = getSession();
      if (!session) {
        jsonResponse(res, 404, { error: "No active session" });
        return;
      }

      const { hash, templateId } = JSON.parse(body);
      if (!hash || typeof hash !== "string") {
        jsonResponse(res, 400, { error: "Commit hash is required" });
        return;
      }

      addMessage("assistant", `Rolled back to version ${hash.slice(0, 7)}.`);

      if (templateId) {
        const tpl = session.templates.find((t) => t.id === templateId);
        if (!tpl) {
          jsonResponse(res, 404, { error: "Template not found" });
          return;
        }
        const filePaths = tpl.moduleOrder.map((n) => `modules/${n}.module`);
        if (tpl.templateFile) filePaths.push(tpl.templateFile);

        const result = rollbackTemplateToCommit(session.themePath, templateId, hash, filePaths);
        if (!result.success) {
          jsonResponse(res, 500, { error: result.error || "Rollback failed" });
          return;
        }
        reloadActiveTemplateFromDisk();
      } else {
        const result = rollbackToCommit(session.themePath, hash);
        if (!result.success) {
          jsonResponse(res, 500, { error: result.error || "Rollback failed" });
          return;
        }
        reloadModulesFromDisk();
      }

      saveSession();
      jsonResponse(res, 200, {
        ok: true,
        modules: getOrderedModules().map((m) => m.moduleName),
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
