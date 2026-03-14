/**
 * Local development server for vibeSpot vibe coding mode.
 * Serves the UI, handles WebSocket connections, and manages AI interactions.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  getSession,
  addMessage,
  getOrderedModules,
  writeModulesToDisk,
  saveSession,
  getActiveTemplate,
} from "./session.js";
import { commitThemeState, commitTemplateState, isGitAvailable } from "./project-git.js";
import { buildPreviewHtml, buildModulePreviewHtml } from "./preview.js";
import { handleGenerateStream, setParseWarningCallback } from "./ai-handler.js";
import { loadConfig, getHubSpotPak, getActiveHubSpotAccount } from "../utils/config.js";
import { detectHubSpotAuth, detectDataCenter, detectHubSpotAuthFromConfig } from "../utils/detect.js";
import { applyAutoFixes, parseUploadErrors, parseApiErrors } from "./auto-fix.js";
import { startStreamingJob, getJob, addJobListener, removeJobListener } from "./process-manager.js";
import { uploadTheme, type UploadFileError } from "../hubspot/uploader.js";
import { jsonResponse } from "./route-helpers.js";

// Route modules
import {
  handleSetupInfoRoute,
  handleSetupCreateRoute,
  handleSetupFetchRoute,
  handleSetupOpenRoute,
  handleSetupResumeRoute,
  handleSetupApiKeyRoute,
  handleSetupRemoteThemesRoute,
} from "./routes/setup.js";
import {
  handleSettingsStatusRoute,
  handleSettingsEngineRoute,
  handleSettingsApiKeyRoute,
  handleSettingsInstallRoute,
  handleSettingsHsAuthRoute,
  handleSettingsGhAuthRoute,
  handleSettingsHsSwitchRoute,
  handleSettingsGhLogoutRoute,
  handleSettingsCLIAuthRoute,
  handleSettingsHsModeRoute,
  handleSettingsCliToggleRoute,
  handleSettingsJobRoute,
} from "./routes/settings.js";
import {
  handleThemesRoute,
  handleThemeSwitchRoute,
  handleDeleteLocalThemeRoute,
  handleRenameThemeRoute,
} from "./routes/themes.js";
import {
  handleDashboardRoute,
  handleDownloadZipRoute,
  handleTemplatesRoute,
  handleTemplateActivateRoute,
  handleTemplateRenameRoute,
  handleTemplateCloneRoute,
  handleModuleLibraryRoute,
  handleAddModuleToTemplateRoute,
  handleBrandAssetsRoute,
  handleDesignExtractRoute,
  handleReferenceImportRoute,
} from "./routes/templates.js";
import {
  handleSessionRoute,
  handleModulesRoute,
  handleReorderRoute,
  handleUploadRoute,
  handleFieldRoute,
  handleImportRoute,
  handleHistoryRoute,
  handleRollbackRoute,
  handleCodeUpdateRoute,
} from "./routes/modules.js";
import { handleFileUploadRoute } from "./routes/upload-files.js";

// ---------------------------------------------------------------------------
// MIME types for static serving
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ServerOptions {
  port: number;
  uiDir: string;
}

export function startServer(opts: ServerOptions): Promise<{ port: number; close: () => void }> {
  const { port, uiDir } = opts;

  const server = createServer((req, res) => handleRequest(req, res, uiDir));

  // WebSocket server — upgrade on the same HTTP server
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => handleWsConnection(ws));

  return new Promise((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Try next port
        server.listen(port + 1, () => {
          resolve({
            port: port + 1,
            close: () => { server.close(); wss.close(); },
          });
        });
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      resolve({
        port,
        close: () => { server.close(); wss.close(); },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

function handleRequest(req: IncomingMessage, res: ServerResponse, uiDir: string): void {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const method = req.method || "GET";

  // API routes
  if (url.pathname.startsWith("/api/")) {
    handleApiRoute(method, url.pathname, req, res);
    return;
  }

  // Preview route — returns rendered preview HTML
  if (url.pathname === "/preview") {
    const html = buildPreviewHtml();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // Single-module preview (for dashboard module library)
  if (url.pathname === "/module-preview") {
    const moduleName = url.searchParams.get("module") || "";
    const html = buildModulePreviewHtml(moduleName);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html || "<!-- module not found -->");
    return;
  }

  // Theme assets — serve uploaded images for preview
  if (url.pathname.startsWith("/theme-assets/")) {
    serveThemeAsset(url.pathname.slice("/theme-assets/".length), res);
    return;
  }

  // Static files from ui/ directory
  serveStatic(url.pathname, uiDir, req, res);
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

function handleApiRoute(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse
): void {
  // CORS headers for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  switch (path) {
    case "/api/session":
      handleSessionRoute(method, res);
      break;

    case "/api/modules":
      handleModulesRoute(method, req, res);
      break;

    case "/api/modules/reorder":
      handleReorderRoute(req, res);
      break;

    case "/api/modules/code":
      handleCodeUpdateRoute(req, res);
      break;

    case "/api/upload":
      handleUploadRoute(res);
      break;

    case "/api/upload-files":
      if (method === "POST") handleFileUploadRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/field":
      handleFieldRoute(req, res);
      break;

    case "/api/import":
      handleImportRoute(req, res);
      break;

    case "/api/setup":
      handleSetupInfoRoute(res);
      break;

    case "/api/setup/create":
      handleSetupCreateRoute(req, res);
      break;

    case "/api/setup/fetch":
      handleSetupFetchRoute(req, res);
      break;

    case "/api/setup/open":
      handleSetupOpenRoute(req, res);
      break;

    case "/api/setup/resume":
      handleSetupResumeRoute(req, res);
      break;

    case "/api/setup/apikey":
      handleSetupApiKeyRoute(req, res);
      break;

    case "/api/setup/remote-themes":
      if (method === "GET") handleSetupRemoteThemesRoute(res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    // Settings routes
    case "/api/settings/status":
      if (method === "GET") handleSettingsStatusRoute(res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/engine":
      if (method === "POST") handleSettingsEngineRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/apikey":
      if (method === "POST") handleSettingsApiKeyRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/install":
      if (method === "POST") handleSettingsInstallRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/hs-auth":
      if (method === "POST") handleSettingsHsAuthRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/gh-auth":
      if (method === "POST") handleSettingsGhAuthRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/hs-switch":
      if (method === "POST") handleSettingsHsSwitchRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/gh-logout":
      if (method === "POST") handleSettingsGhLogoutRoute(res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/cli-auth":
      if (method === "POST") handleSettingsCLIAuthRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/hs-mode":
      if (method === "POST") handleSettingsHsModeRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/cli-toggle":
      if (method === "POST") handleSettingsCliToggleRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/themes":
      handleThemesRoute(method, req, res);
      break;

    case "/api/themes/switch":
      if (method === "POST") handleThemeSwitchRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/themes/delete-local":
      if (method === "POST") handleDeleteLocalThemeRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/themes/rename":
      if (method === "POST") handleRenameThemeRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/history":
      if (method === "GET") handleHistoryRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/rollback":
      if (method === "POST") handleRollbackRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    // Dashboard & template routes
    case "/api/dashboard":
      if (method === "GET") handleDashboardRoute(res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/templates":
      handleTemplatesRoute(method, req, res);
      break;

    case "/api/templates/activate":
      if (method === "POST") handleTemplateActivateRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/templates/rename":
      if (method === "POST") handleTemplateRenameRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/templates/clone":
      if (method === "POST") handleTemplateCloneRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/module-library":
      if (method === "GET") handleModuleLibraryRoute(res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/brand-assets":
      handleBrandAssetsRoute(method, req, res);
      break;

    case "/api/brand-assets/extract":
      if (method === "POST") handleDesignExtractRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/brand-assets/import-reference":
      if (method === "POST") handleReferenceImportRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/download-zip":
      if (method === "GET") handleDownloadZipRoute(res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    default:
      // Prefix match for job polling: /api/settings/job/:id
      if (path.startsWith("/api/settings/job/") && method === "GET") {
        handleSettingsJobRoute(path, res);
      }
      // Prefix match for template add-module: /api/templates/:id/add-module
      else if (path.match(/^\/api\/templates\/[^/]+\/add-module$/) && method === "POST") {
        handleAddModuleToTemplateRoute(path, req, res);
      } else {
        jsonResponse(res, 404, { error: "Not found" });
      }
  }
}

// ---------------------------------------------------------------------------
// WebSocket handler
// ---------------------------------------------------------------------------

function handleWsConnection(ws: WebSocket): void {
  ws.on("message", async (data) => {
    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    switch (msg.type) {
      case "chat": {
        const userMessage = String(msg.message || "");
        if (!userMessage.trim()) return;

        addMessage("user", userMessage);
        saveSession();

        // Set up parse warning callback for this generation
        setParseWarningCallback((warning) => {
          ws.send(JSON.stringify({ type: "parse_warning", message: warning }));
        });

        // Stream AI response back via WebSocket
        const fileIds = Array.isArray(msg.fileIds) ? msg.fileIds as string[] : undefined;
        try {
          await handleGenerateStream(
            userMessage,
            (chunk) => {
              ws.send(JSON.stringify({ type: "stream", content: chunk }));
            },
            (status) => {
              ws.send(JSON.stringify({ type: "stream_status", content: status }));
            },
            fileIds
          );

          // Write modules to disk and commit for version history
          const currentSession = getSession();
          if (currentSession) {
            writeModulesToDisk();
            const activeTpl = getActiveTemplate();
            let commitHash: string | null = null;
            if (activeTpl) {
              const filePaths = activeTpl.moduleOrder.map((n: string) => `modules/${n}.module`);
              if (activeTpl.templateFile) filePaths.push(activeTpl.templateFile);
              if (activeTpl.sharedCss) filePaths.push(`css/${currentSession.themeName}-theme.css`);
              if (activeTpl.sharedJs) filePaths.push(`js/${currentSession.themeName}-animations.js`);
              commitHash = commitTemplateState(currentSession.themePath, activeTpl.id, userMessage, filePaths);
            } else {
              commitHash = commitThemeState(currentSession.themePath, userMessage);
            }
            if (commitHash) {
              ws.send(JSON.stringify({ type: "version_created", hash: commitHash }));
            }
          }

          // After generation, send updated preview
          ws.send(JSON.stringify({ type: "generation_complete" }));
          ws.send(JSON.stringify({
            type: "modules_updated",
            modules: getOrderedModules().map((m) => m.moduleName),
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          }));
        }
        break;
      }

      case "start_upload": {
        const session = getSession();
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "No active session" }));
          break;
        }

        try {
          writeModulesToDisk();

          // Apply auto-fixes before uploading
          const fixes = applyAutoFixes(session.themePath);
          if (fixes.length > 0) {
            ws.send(JSON.stringify({ type: "upload_status", phase: "autofix", fixes }));
          }

          const config = loadConfig();
          const uploadMode = config.hubspotUploadMode || "api";

          if (uploadMode === "api") {
            // --- API mode: direct HTTP uploads ---
            const pak = getHubSpotPak();
            if (!pak) {
              ws.send(JSON.stringify({
                type: "upload_failed",
                output: "No HubSpot account configured. Open Settings → HubSpot to add one.",
                errors: [{ file: "", message: "No HubSpot account configured", fixable: false }],
              }));
              break;
            }

            ws.send(JSON.stringify({ type: "upload_started", jobId: "api-upload" }));

            const result = await uploadTheme(pak, session.themePath, session.themeName, {
              onFileStart: (path) => {
                ws.send(JSON.stringify({ type: "upload_output", chunk: `Uploading ${path}\n` }));
              },
              onFileComplete: (path) => {
                ws.send(JSON.stringify({ type: "upload_output", chunk: `  ✓ ${path}\n` }));
              },
              onFileError: (path, err) => {
                ws.send(JSON.stringify({ type: "upload_output", chunk: `  ✗ ${path}: ${err.message}\n` }));
              },
              onProgress: (completed, total) => {
                ws.send(JSON.stringify({ type: "upload_progress", completed, total }));
              },
            });

            if (result.success) {
              const acct = getActiveHubSpotAccount();
              ws.send(JSON.stringify({
                type: "upload_complete",
                output: `Uploaded ${result.uploaded} files`,
                portalId: acct?.portalId || "",
                dataCenter: acct?.dataCenter || "na1",
                themeName: session.themeName,
              }));
            } else {
              const errors = parseApiErrors(result.errors);
              ws.send(JSON.stringify({
                type: "upload_failed",
                output: result.errors.map((e) => `${e.file}: ${e.message}`).join("\n"),
                errors,
              }));
            }
          } else {
            // --- CLI mode: legacy hs cms upload subprocess ---
            const jobId = startStreamingJob(
              `hs cms upload "${session.themePath}" "${session.themeName}"`,
              "Uploading to HubSpot",
              { cwd: join(session.themePath, ".."), timeout: 180_000 }
            );

            ws.send(JSON.stringify({ type: "upload_started", jobId }));

            const chunkListener = (chunk: string) => {
              ws.send(JSON.stringify({ type: "upload_output", chunk }));
            };
            addJobListener(jobId, chunkListener);

            const pollInterval = setInterval(() => {
              const job = getJob(jobId);
              if (!job || job.status === "running") return;

              clearInterval(pollInterval);
              removeJobListener(jobId, chunkListener);

              if (job.status === "completed") {
                const auth = detectHubSpotAuth();
                const dc = auth.portalId ? detectDataCenter(auth.portalId) : "na1";
                ws.send(JSON.stringify({
                  type: "upload_complete",
                  output: job.output,
                  portalId: auth.portalId || "",
                  dataCenter: dc,
                  themeName: session.themeName,
                }));
              } else {
                const errors = parseUploadErrors(job.output);
                ws.send(JSON.stringify({
                  type: "upload_failed",
                  output: job.output,
                  errors,
                  exitCode: job.exitCode,
                }));
              }
            }, 500);
          }
        } catch (err) {
          ws.send(JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          }));
        }
        break;
      }

      case "upload_fix_with_ai": {
        const errorContext = String(msg.errorContext || "");
        if (!errorContext.trim()) {
          ws.send(JSON.stringify({ type: "error", message: "No error context provided" }));
          break;
        }

        const fixPrompt = `The HubSpot upload ("hs cms upload") failed. Below is the upload log output containing the errors.

IMPORTANT: Be verbose in your response. For each error:
1. State exactly which file has the problem and what the error is
2. Explain WHY this error occurs (e.g. "HubSpot doesn't support textarea field type" or "field name 'name' is reserved in HubSpot modules")
3. Describe the specific fix you're applying (e.g. "Changing field type from textarea to text" or "Renaming field from 'name' to 'item_name'")
4. Apply the fix to the module files

CRITICAL: After fixing the reported errors, scan ALL other module files in the theme for the same issues. For example, if you fix "name" → "item_name" in one module, check every other module's fields.json for the same problem. Fix all occurrences, not just the ones in the error log.

After fixing all errors, summarize the changes you made.

Upload log:
${errorContext}`;
        addMessage("user", fixPrompt);
        saveSession();

        ws.send(JSON.stringify({ type: "upload_fix_started" }));

        try {
          await handleGenerateStream(fixPrompt, (chunk) => {
            // Stream to both the chat panel and the upload panel
            ws.send(JSON.stringify({ type: "stream", content: chunk }));
            ws.send(JSON.stringify({ type: "upload_fix_stream", content: chunk }));
          });

          // Write fixes to disk and commit
          const fixSession = getSession();
          if (fixSession) {
            writeModulesToDisk();
            const fixHash = commitThemeState(fixSession.themePath, "AI fix: upload errors");
            if (fixHash) {
              ws.send(JSON.stringify({ type: "version_created", hash: fixHash }));
            }
          }

          ws.send(JSON.stringify({ type: "upload_fix_complete" }));
          ws.send(JSON.stringify({
            type: "modules_updated",
            modules: getOrderedModules().map((m) => m.moduleName),
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: "upload_failed",
            output: err instanceof Error ? err.message : String(err),
            errors: [{ file: "AI fix", message: err instanceof Error ? err.message : String(err), fixable: false }],
          }));
        }
        break;
      }

      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;

      default:
        ws.send(JSON.stringify({ type: "error", message: `Unknown type: ${msg.type}` }));
    }
  });

  // Send initial state
  const session = getSession();
  if (session) {
    const cfg = loadConfig();
    const engineLabels: Record<string, string> = {
      "claude-code": "Claude Code",
      "anthropic-api": "Anthropic API",
      "openai-api": "OpenAI API",
      "gemini-cli": "Gemini CLI",
      "gemini-api": "Gemini API",
      "codex-cli": "Codex CLI",
      "api": "Anthropic API",
    };
    const activeTpl = getActiveTemplate();
    ws.send(JSON.stringify({
      type: "init",
      sessionId: session.id,
      themeName: session.themeName,
      modules: getOrderedModules().map((m) => m.moduleName),
      messageCount: session.messages.length,
      messages: session.messages,
      gitAvailable: isGitAvailable(),
      engine: cfg.aiEngine ? engineLabels[cfg.aiEngine] || cfg.aiEngine : "",
      // Multi-template context
      templateId: activeTpl?.id || null,
      pageType: activeTpl?.pageType || null,
      templates: (session.templates || []).map((t) => ({
        id: t.id,
        label: t.label,
        pageType: t.pageType,
        moduleCount: t.modules.length,
      })),
    }));
  } else {
    ws.send(JSON.stringify({ type: "needs_setup" }));
  }
}

// ---------------------------------------------------------------------------
// Theme asset serving (uploaded images for preview)
// ---------------------------------------------------------------------------

function serveThemeAsset(filename: string, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("No session");
    return;
  }
  const filePath = join(session.themePath, "assets", filename);
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Asset not found");
    return;
  }
  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const buffer = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
  });
  res.end(buffer);
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const staticCache = new Map<string, { buffer: Buffer; etag: string; contentType: string }>();

function serveStatic(pathname: string, uiDir: string, req: IncomingMessage, res: ServerResponse): void {
  // Default to index.html
  let filePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = join(uiDir, filePath);

  if (!existsSync(fullPath)) {
    // SPA fallback — serve index.html for unknown routes
    const indexPath = join(uiDir, "index.html");
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
      res.end(content);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
    return;
  }

  const ext = extname(fullPath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const isHtml = ext === ".html";

  try {
    let cached = staticCache.get(fullPath);
    if (!cached) {
      const buffer = readFileSync(fullPath);
      const etag = '"' + createHash("md5").update(buffer).digest("hex").slice(0, 16) + '"';
      cached = { buffer, etag, contentType };
      staticCache.set(fullPath, cached);
    }

    // Check If-None-Match for 304
    const clientEtag = req.headers["if-none-match"];
    if (clientEtag === cached.etag) {
      res.writeHead(304);
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": cached.contentType,
      "Cache-Control": isHtml ? "no-cache" : "public, max-age=3600",
      "ETag": cached.etag,
    });
    res.end(cached.buffer);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
}
