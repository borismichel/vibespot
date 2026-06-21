/**
 * Local development server for vibeSpot vibe coding mode.
 * Serves the UI, handles WebSocket connections, and manages AI interactions.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  getSession,
  addMessage,
  getOrderedModules,
  updateModules,
  reorderModules,
  writeModulesToDisk,
  saveSession,
  getActiveTemplate,
  createSession,
} from "./session.js";
import { commitThemeState, commitTemplateState, isGitAvailable } from "./project-git.js";
import { buildPreviewHtml, buildModulePreviewHtml } from "./preview.js";
import { handleGenerateStream, handleAgenticGenerate, handleAgenticResume, handleFigmaImport, applyPipelineResult, shouldUseAgenticMode, setParseWarningCallback, resolveAgenticEngine, handlePlanModeStream, isPlanModeActive, isGenerating } from "./ai-handler.js";
import type { CheckpointResolution, CheckpointAction } from "./agent/types.js";
import { handlePlanEditRoute, handlePlanDiscardRoute, handlePlanTemplatesRoute, handlePlanTemplateRoute, savePlan, clearPlan } from "./routes/plan.js";
import { parsePlanResponse } from "./plan-parser.js";
import { loadConfig, saveConfig, getHubSpotPak, getActiveHubSpotAccount } from "../utils/config.js";
import { detectHubSpotAuth, detectDataCenter, detectHubSpotAuthFromConfig } from "../utils/detect.js";
import { applyAutoFixes, parseUploadErrors, parseApiErrors } from "./auto-fix.js";
import { startStreamingJob, startJobSafe, getJob, addJobListener, removeJobListener } from "./process-manager.js";
import { uploadTheme, type UploadFileError } from "../hubspot/uploader.js";
import { jsonResponse } from "./route-helpers.js";
import { getChangelog } from "../utils/fs.js";
import { runWithTrace, runWithSpan } from "./langfuse.js";

// Route modules
import {
  handleSetupInfoRoute,
  handleSetupCreateRoute,
  handleSetupFetchRoute,
  handleSetupOpenRoute,
  handleSetupResumeRoute,
  handleSetupApiKeyRoute,
  handleSetupRemoteThemesRoute,
  handleStartersListRoute,
} from "./routes/setup.js";
import {
  handleSettingsStatusRoute,
  handleSettingsModelsRoute,
  handleSettingsToolsRoute,
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
  handleSettingsGenericRoute,
  handleSettingsJobRoute,
} from "./routes/settings.js";
import {
  handleClaudeOAuthSaveRoute,
  handleClaudeOAuthStatusRoute,
  handleClaudeOAuthLogoutRoute,
} from "./routes/claude-oauth.js";
import {
  handleThemesRoute,
  handleThemeSwitchRoute,
  handleDeleteLocalThemeRoute,
  handleRenameThemeRoute,
  handleDuplicateThemeRoute,
} from "./routes/themes.js";
import {
  handleDashboardRoute,
  handleDownloadZipRoute,
  handleTemplatesRoute,
  handleTemplateActivateRoute,
  handleTemplateRenameRoute,
  handleTemplateCloneRoute,
  handleTemplateReorderRoute,
  handleModuleLibraryRoute,
  handleAddModuleToTemplateRoute,
  handleBrandAssetsRoute,
  handleBrandKitRoute,
  handleDesignExtractRoute,
  handleReferenceImportRoute,
  handleFontsRoute,
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
import { handleFigmaTestTokenRoute, handleFigmaExtractRoute, handleFigmaGenerateRoute } from "./routes/figma.js";
import {
  handleMarketplaceCheckRoute,
  handleMarketplaceFixRoute,
  handleMarketplaceListingRoute,
} from "./routes/marketplace.js";
import {
  handleInverseAnalyzeRoute,
  handleInverseApplyTokensRoute,
} from "./routes/inverse.js";

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
// Live WebSocket tracking — allows reconnecting clients to catch up on
// an in-flight pipeline that started on a previous connection.
// ---------------------------------------------------------------------------

let activeClientWs: WebSocket | null = null;
let pipelineEventLog: object[] = [];

function sendToClient(data: object): void {
  if (activeClientWs && activeClientWs.readyState === WebSocket.OPEN) {
    activeClientWs.send(JSON.stringify(data));
  }
}

function logAndSend(data: object): void {
  pipelineEventLog.push(data);
  sendToClient(data);
}

function clearPipelineEventLog(): void {
  pipelineEventLog = [];
}

// ---------------------------------------------------------------------------
// Shared pipeline event handler — builds the onEvent callback used by all
// three generation entry points (chat, figma import, plan approval).
// ---------------------------------------------------------------------------

function buildPipelineOnEvent(
  pipelineSteps: { step: string; label: string; decisions?: string[] }[],
  pipelineModules: { name: string; status: "complete" | "failed" }[],
): (event: import("./agent/types.js").PipelineEvent) => void {
  return (event) => {
    if (event.type === "module_progress" && event.moduleFiles) {
      const { moduleFiles, ...wsEvent } = event;
      logAndSend(wsEvent);
    } else {
      logAndSend(event);
    }

    if (event.type === "agent_step") {
      pipelineSteps.push({ step: event.step, label: event.label });
    } else if (event.type === "agent_decision") {
      const last = pipelineSteps[pipelineSteps.length - 1];
      if (last) {
        if (!last.decisions) last.decisions = [];
        last.decisions.push(event.decision);
      }
    } else if (event.type === "design_system_ready") {
      updateModules({ sharedCss: event.sharedCss, sharedJs: event.sharedJs });
    } else if (event.type === "blueprint_ready") {
      updateModules({ sharedCss: event.sharedCss, sharedJs: event.sharedJs });
      reorderModules(event.moduleOrder);
      logAndSend({
        type: "modules_updated",
        modules: getOrderedModules().map((m) => m.moduleName),
      });
    } else if (event.type === "module_progress" && event.status === "complete" && event.moduleFiles) {
      updateModules({ modules: [{
        moduleName: event.module,
        fieldsJson: event.moduleFiles.fieldsJson,
        metaJson: event.moduleFiles.metaJson,
        moduleHtml: event.moduleFiles.moduleHtml,
        moduleCss: event.moduleFiles.moduleCss,
        moduleJs: event.moduleFiles.moduleJs,
      }] });
      logAndSend({
        type: "modules_updated",
        modules: getOrderedModules().map((m) => m.moduleName),
      });
      pipelineModules.push({ name: event.module, status: "complete" });
    } else if (event.type === "module_progress" && event.status === "failed") {
      pipelineModules.push({ name: event.module, status: "failed" });
    }
  };
}

// ---------------------------------------------------------------------------
// Generation cost (VIB-1770) — push the per-page token/USD estimate plus the
// updated per-project running total to the UI after a generation completes.
// Call AFTER applyPipelineResult so the session's running total is current.
// No-op when there's no priced usage (e.g. CLI engines report none).
// ---------------------------------------------------------------------------

function sendGenerationCost(result: import("./agent/types.js").PipelineResult): void {
  const cost = result.cost;
  if (!cost || cost.calls === 0) return;
  const sess = getSession();
  sendToClient({
    type: "generation_cost",
    cost,
    projectTotal: sess?.costTotal,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ServerOptions {
  port: number;
  uiDir: string;
  contentMode?: "page" | "email";
}

let serverContentMode: "page" | "email" = "page";

export function getServerContentMode(): "page" | "email" {
  return serverContentMode;
}

export function startServer(opts: ServerOptions): Promise<{ port: number; close: () => void }> {
  const { port, uiDir } = opts;
  serverContentMode = opts.contentMode || "page";

  const server = createServer((req, res) => handleRequest(req, res, uiDir));

  // WebSocket server — upgrade on the same HTTP server
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => handleWsConnection(ws));

  return new Promise((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Try next port
        server.listen(port + 1, "0.0.0.0", () => {
          resolve({
            port: port + 1,
            close: () => { server.close(); wss.close(); },
          });
        });
      } else {
        reject(err);
      }
    });

    server.listen(port, "0.0.0.0", () => {
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

  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Health check — used by Docker HEALTHCHECK, CI smoke tests, and load
  // balancers. Returns 200 with a tiny JSON body and is unauthenticated.
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

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

  // Documentation — served from ui/docs/ directory
  if (url.pathname === "/docs") {
    res.writeHead(301, { Location: "/docs/" });
    res.end();
    return;
  }
  if (url.pathname.startsWith("/docs/")) {
    const docPath = url.pathname.slice(5) || "/index.html"; // strip "/docs"
    serveStatic(docPath, join(uiDir, "docs"), req, res);
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
  // CORS — allow localhost and private/Tailscale IPs
  const origin = req.headers.origin || "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1|100\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
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

    case "/api/starters":
      if (method === "GET") handleStartersListRoute(res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    // Settings routes
    case "/api/settings/status":
      if (method === "GET") handleSettingsStatusRoute(res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/models":
      if (method === "GET") handleSettingsModelsRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/tools":
      if (method === "GET") handleSettingsToolsRoute(req, res);
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

    case "/api/settings/claude-oauth/save":
      if (method === "POST") handleClaudeOAuthSaveRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/claude-oauth/status":
      if (method === "GET") handleClaudeOAuthStatusRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings/claude-oauth/logout":
      if (method === "POST") handleClaudeOAuthLogoutRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/settings":
      if (method === "POST") handleSettingsGenericRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/changelog":
      if (method === "GET") {
        jsonResponse(res, 200, { changelog: getChangelog() });
      } else {
        jsonResponse(res, 405, { error: "Method not allowed" });
      }
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

    case "/api/themes/duplicate":
      if (method === "POST") handleDuplicateThemeRoute(req, res);
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

    case "/api/templates/reorder":
      if (method === "POST") handleTemplateReorderRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/module-library":
      if (method === "GET") handleModuleLibraryRoute(res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/brand-assets":
      handleBrandAssetsRoute(method, req, res);
      break;

    case "/api/brand-kit":
      handleBrandKitRoute(method, req, res);
      break;

    case "/api/fonts":
      if (method === "GET") handleFontsRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
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

    case "/api/figma/test-token":
      if (method === "POST") handleFigmaTestTokenRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/figma/extract":
      if (method === "POST") handleFigmaExtractRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/figma/generate":
      if (method === "POST") handleFigmaGenerateRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/plan/edit":
      if (method === "POST") handlePlanEditRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/plan/discard":
      if (method === "POST") handlePlanDiscardRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/plan/templates":
      if (method === "GET") handlePlanTemplatesRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/plan/template":
      if (method === "POST") handlePlanTemplateRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/marketplace/check":
      if (method === "GET") handleMarketplaceCheckRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/marketplace/fix":
      if (method === "POST") handleMarketplaceFixRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/marketplace/listing":
      handleMarketplaceListingRoute(method, req, res);
      break;

    case "/api/inverse/analyze":
      if (method === "GET") handleInverseAnalyzeRoute(req, res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/inverse/apply-tokens":
      if (method === "POST") handleInverseApplyTokensRoute(req, res);
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

        const fileIds = Array.isArray(msg.fileIds) ? msg.fileIds as string[] : undefined;

        // A fresh chat supersedes any parked checkpoint gate (VIB-1877).
        {
          const sess = getSession();
          if (sess?.pendingCheckpoint) {
            sess.pendingCheckpoint = undefined;
            saveSession();
          }
        }

        // ---------------------------------------------------------------
        // Plan-mode branch — DELIBERATION PHASE, no module generation.
        //
        // While planMode is active, the chat handler routes to the
        // plan-mode stream and refuses to enter the agentic pipeline.
        // Generation is reachable only via an explicit `plan_approve`
        // WebSocket message, which clears the gate for one call.
        // ---------------------------------------------------------------
        if (isPlanModeActive()) {
          addMessage("user", userMessage);
          saveSession();

          try {
            ws.send(JSON.stringify({ type: "stream_status", content: "Planning..." }));
            let fullResponse = "";
            const fullText = await handlePlanModeStream(
              userMessage,
              (chunk) => {
                fullResponse += chunk;
                ws.send(JSON.stringify({ type: "stream", content: chunk }));
              },
              fileIds,
            );

            // Parse out plan + choices blocks; persist plan; emit cleaned chat.
            const parsed = parsePlanResponse(fullText || fullResponse);

            if (parsed.plan) {
              savePlan(parsed.plan);
              ws.send(JSON.stringify({ type: "plan_updated", plan: parsed.plan }));
            }
            if (parsed.choices) {
              ws.send(JSON.stringify({
                type: "plan_choices",
                question: parsed.choices.question,
                options: parsed.choices.options,
              }));
            }

            // Persist the cleaned (chat-visible) content as the assistant message.
            addMessage("assistant", parsed.cleanedContent);
            saveSession();

            ws.send(JSON.stringify({ type: "plan_complete", cleanedContent: parsed.cleanedContent }));
            ws.send(JSON.stringify({ type: "generation_complete" }));
          } catch (err) {
            ws.send(JSON.stringify({
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            }));
          }
          break;
        }

        addMessage("user", userMessage);
        saveSession();

        // Check if agentic mode should be used
        const agenticCheck = shouldUseAgenticMode();

        // Notify frontend if agentic mode needs first-run prompt
        if (agenticCheck.needsPrompt) {
          ws.send(JSON.stringify({ type: "agentic_prompt" }));
          // Don't block — fall through to single-call mode for now.
          // User can choose agentic mode from the prompt, which saves to config.
        }

        try {
          if (agenticCheck.useAgentic) {
            // --- Agentic pipeline mode ---
            clearPipelineEventLog();
            const pipelineSteps: { step: string; label: string; decisions?: string[] }[] = [];
            const pipelineModules: { name: string; status: "complete" | "failed" }[] = [];

            // Checkpoints are ON by default (VIB-1877). The send-button's
            // "one-shot it" affordance sets msg.oneShot to skip all gates
            // (= today's behavior).
            const checkpointsEnabled = !msg.oneShot;

            const result = await handleAgenticGenerate(
              userMessage,
              buildPipelineOnEvent(pipelineSteps, pipelineModules),
              fileIds,
              checkpointsEnabled,
            );

            // Parked at a checkpoint gate: persist the resume token on the
            // session and stop here. No modules were built, nothing is written
            // or committed. The UI shows the checkpoint card (sent via the
            // checkpoint_requested event) and resolves it with checkpoint_resolve.
            if (result.pendingCheckpoint) {
              const sess = getSession();
              if (sess) {
                sess.pendingCheckpoint = result.pendingCheckpoint;
                saveSession();
              }
              sendGenerationCost(result);
              clearPipelineEventLog();
              break;
            }

            applyPipelineResult(result, {
              steps: pipelineSteps,
              modules: pipelineModules,
              stats: result.stats,
              cost: result.cost,
            });
            sendGenerationCost(result);

          } else {
            // --- Single-call mode (existing behavior) ---
            setParseWarningCallback((warning) => {
              sendToClient({ type: "parse_warning", message: warning });
            });

            await handleGenerateStream(
              userMessage,
              (chunk) => {
                sendToClient({ type: "stream", content: chunk });
              },
              (status) => {
                sendToClient({ type: "stream_status", content: status });
              },
              fileIds
            );
          }

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
              sendToClient({ type: "version_created", hash: commitHash });
            }
          }

          // After generation, send updated preview
          sendToClient({ type: "generation_complete" });
          {
            const sess = getSession();
            sendToClient({
              type: "modules_updated",
              modules: getOrderedModules().map((m) => m.moduleName),
              templateId: sess?.activeTemplateId || null,
              templates: (sess?.templates || []).map((t) => ({
                id: t.id, label: t.label, pageType: t.pageType, moduleCount: t.modules.length,
              })),
            });
          }
          clearPipelineEventLog();

          // Suggest brand asset extraction if none exist yet
          {
            const sess = getSession();
            if (sess && agenticCheck.useAgentic && !sess.brandAssets?.styleguide && !sess.brandAssets?.brandvoice && !sess.brandAssets?.themeContext) {
              sendToClient({ type: "suggest_brand_extraction" });
            }
          }
        } catch (err) {
          clearPipelineEventLog();
          sendToClient({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "figma_import": {
        const extractionId = String(msg.extractionId || "");
        const themeName = String(msg.themeName || "");
        if (!extractionId || !themeName) {
          ws.send(JSON.stringify({ type: "error", message: "Missing extractionId or themeName" }));
          break;
        }

        // Retrieve cached extraction
        const { getCachedExtraction } = await import("./routes/figma.js");
        const extraction = getCachedExtraction(extractionId);
        if (!extraction) {
          ws.send(JSON.stringify({ type: "error", message: "Extraction expired or not found. Please re-extract." }));
          break;
        }

        try {
          // Theme + session should already exist (created via /api/setup/create)
          // Fall back to creating them if not (e.g. direct WebSocket call)
          const session = getSession();
          if (!session || session.themeName !== themeName) {
            const { join } = await import("node:path");
            const { homedir } = await import("node:os");
            const { existsSync } = await import("node:fs");
            const { createThemeScaffold } = await import("../hubspot/theme-scaffold.js");
            const workspaceDir = join(homedir(), "vibespot-themes");
            const themePath = join(workspaceDir, themeName);

            if (!existsSync(workspaceDir)) {
              const { mkdirSync } = await import("node:fs");
              mkdirSync(workspaceDir, { recursive: true });
            }
            if (!existsSync(themePath)) {
              createThemeScaffold(themePath, themeName);
            }
            createSession(themePath, themeName);
            saveSession();
          }

          sendToClient({ type: "figma_import_started", fileName: extraction.fileName });

          clearPipelineEventLog();
          const pipelineSteps: { step: string; label: string; decisions?: string[] }[] = [];
          const pipelineModules: { name: string; status: "complete" | "failed" }[] = [];

          const result = await handleFigmaImport(
            extraction,
            themeName,
            buildPipelineOnEvent(pipelineSteps, pipelineModules),
          );

          applyPipelineResult(result, {
            steps: pipelineSteps,
            modules: pipelineModules,
            stats: result.stats,
            cost: result.cost,
          });
          sendGenerationCost(result);

          writeModulesToDisk();
          commitThemeState(getSession()!.themePath, `Figma import: ${extraction.fileName}`);

          sendToClient({ type: "generation_complete" });
          {
            const sess = getSession();
            sendToClient({
              type: "modules_updated",
              modules: getOrderedModules().map((m) => m.moduleName),
              templateId: sess?.activeTemplateId || null,
              templates: (sess?.templates || []).map((t) => ({
                id: t.id, label: t.label, pageType: t.pageType, moduleCount: t.modules.length,
              })),
            });
          }
          clearPipelineEventLog();
        } catch (err) {
          clearPipelineEventLog();
          sendToClient({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "extract_brand_assets": {
        const session = getSession();
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "No active session" }));
          break;
        }

        // Fire-and-forget — run extraction in background, never block the UI
        (async () => {
          try {
            const config = loadConfig();
            const { engine, apiKey, model } = resolveAgenticEngine(config);

            // Extract theme context from rendered preview HTML
            const { buildPreviewHtml } = await import("./preview.js");
            const previewHtml = buildPreviewHtml();
            if (!previewHtml || previewHtml.length < 50) return;

            const { extractThemeContext } = await import("./agent/stages/context-extractor.js");
            const themeContext = await runWithTrace(
              {
                name: "brand_extract",
                sessionId: session.themeName,
                metadata: { type: "themeContext" },
                tags: ["vibespot", "brand-extract"],
              },
              () =>
                runWithSpan("extract-theme-context", () =>
                  extractThemeContext(
                    previewHtml,
                    session.brandAssets?.themeContext,
                    engine,
                    apiKey,
                    model,
                  ),
                ),
            );

            const { mkdirSync, writeFileSync } = await import("node:fs");

            if (themeContext) {
              if (!session.brandAssets) session.brandAssets = {};
              session.brandAssets.themeContext = themeContext;
              session.updatedAt = Date.now();

              const assetDir = join(session.themePath, ".vibespot");
              if (!existsSync(assetDir)) mkdirSync(assetDir, { recursive: true });
              writeFileSync(join(assetDir, "theme-context.md"), themeContext);

              saveSession();
              ws.send(JSON.stringify({ type: "brand_asset_extracted", assetType: "themeContext" }));
            }

            // Also extract styleguide if missing
            if (!session.brandAssets?.styleguide) {
              try {
                const { extractDesignContext } = await import("../ai/design-extractor.js");
                const styleguide = await runWithTrace(
                  {
                    name: "brand_extract",
                    sessionId: session.themeName,
                    metadata: { type: "styleguide" },
                    tags: ["vibespot", "brand-extract"],
                  },
                  () => runWithSpan("extract-styleguide", () => extractDesignContext(session.themePath)),
                );
                if (styleguide) {
                  if (!session.brandAssets) session.brandAssets = {};
                  session.brandAssets.styleguide = styleguide;
                  session.updatedAt = Date.now();

                  const assetDir = join(session.themePath, ".vibespot");
                  if (!existsSync(assetDir)) mkdirSync(assetDir, { recursive: true });
                  writeFileSync(join(assetDir, "styleguide.md"), styleguide);

                  saveSession();
                  ws.send(JSON.stringify({ type: "brand_asset_extracted", assetType: "styleguide" }));
                }
              } catch { /* non-critical */ }
            }

            ws.send(JSON.stringify({ type: "brand_extraction_complete" }));
          } catch (err) {
            ws.send(JSON.stringify({
              type: "brand_extraction_error",
              message: err instanceof Error ? err.message : String(err),
            }));
          }
        })();
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
                contentMode: getServerContentMode(),
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
                  contentMode: getServerContentMode(),
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
          {
            const sess = getSession();
            ws.send(JSON.stringify({
              type: "modules_updated",
              modules: getOrderedModules().map((m) => m.moduleName),
              templateId: sess?.activeTemplateId || null,
              templates: (sess?.templates || []).map((t: any) => ({
                id: t.id, label: t.label, pageType: t.pageType, moduleCount: t.modules.length,
              })),
            }));
          }
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

      // ---------------------------------------------------------------
      // Plan approval — explicit gate clearance.
      //
      // The user clicked "Approve plan" in the Plan pane. We exit plan
      // mode (so the next agentic call is allowed), prepend the plan as
      // a design brief, and run the existing agentic pipeline.
      // ---------------------------------------------------------------
      case "plan_approve": {
        const session = getSession();
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "No active session" }));
          break;
        }
        const planMd = session.brandAssets?.plan;
        if (!planMd || !planMd.trim()) {
          ws.send(JSON.stringify({ type: "error", message: "No plan to approve. Send a chat message first." }));
          break;
        }

        // Flip plan mode off so this agentic call (and any subsequent ones
        // until the user re-enables) goes through the normal pipeline.
        saveConfig({ planMode: false });

        const approvalMessage = "Implement the approved plan.";
        addMessage("user", approvalMessage);
        saveSession();

        try {
          clearPipelineEventLog();
          const pipelineSteps: { step: string; label: string; decisions?: string[] }[] = [];
          const pipelineModules: { name: string; status: "complete" | "failed" }[] = [];

          const result = await handleAgenticGenerate(
            approvalMessage,
            buildPipelineOnEvent(pipelineSteps, pipelineModules),
          );

          applyPipelineResult(result, {
            steps: pipelineSteps,
            modules: pipelineModules,
            stats: result.stats,
            cost: result.cost,
          });
          sendGenerationCost(result);

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
              commitHash = commitTemplateState(currentSession.themePath, activeTpl.id, "Approved plan: implementation", filePaths);
            } else {
              commitHash = commitThemeState(currentSession.themePath, "Approved plan: implementation");
            }
            if (commitHash) {
              sendToClient({ type: "version_created", hash: commitHash });
            }
          }

          sendToClient({ type: "generation_complete" });
          {
            const sess = getSession();
            sendToClient({
              type: "modules_updated",
              modules: getOrderedModules().map((m) => m.moduleName),
              templateId: sess?.activeTemplateId || null,
              templates: (sess?.templates || []).map((t) => ({
                id: t.id, label: t.label, pageType: t.pageType, moduleCount: t.modules.length,
              })),
            });
          }
          clearPipelineEventLog();
        } catch (err) {
          clearPipelineEventLog();
          sendToClient({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      // ---------------------------------------------------------------
      // Plan discard — clear plan and exit plan mode in one step.
      // ---------------------------------------------------------------
      case "plan_discard": {
        clearPlan();
        saveConfig({ planMode: false });
        ws.send(JSON.stringify({ type: "plan_discarded" }));
        break;
      }

      // ---------------------------------------------------------------
      // Checkpoint resolution (VIB-1877) — the user clicked approve /
      // steer / skip / cancel on a checkpoint card. Re-enters the parked
      // pipeline at the gate. approve/skip build & commit; steer re-parks
      // with a fresh card; cancel drops the run.
      // ---------------------------------------------------------------
      case "checkpoint_resolve": {
        const session = getSession();
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "No active session" }));
          break;
        }
        const pending = session.pendingCheckpoint;
        if (!pending) {
          ws.send(JSON.stringify({ type: "error", message: "No checkpoint is awaiting resolution." }));
          break;
        }

        const action = String(msg.action || "");
        if (!["approve", "steer", "skip", "cancel"].includes(action)) {
          ws.send(JSON.stringify({ type: "error", message: `Invalid checkpoint action: ${action}` }));
          break;
        }

        const resolution: CheckpointResolution = {
          kind: pending.kind,
          action: action as CheckpointAction,
          note: typeof msg.note === "string" ? msg.note : undefined,
        };
        const resumeToken = pending.resumeToken;

        // Clear the gate up front; a `steer` re-parks with a fresh token below.
        session.pendingCheckpoint = undefined;
        saveSession();

        try {
          clearPipelineEventLog();
          const pipelineSteps: { step: string; label: string; decisions?: string[] }[] = [];
          const pipelineModules: { name: string; status: "complete" | "failed" }[] = [];

          const result = await handleAgenticResume(
            resumeToken,
            resolution,
            buildPipelineOnEvent(pipelineSteps, pipelineModules),
          );

          // Cancelled — nothing built.
          if (result.canceled) {
            sendToClient({ type: "checkpoint_cancelled" });
            sendToClient({ type: "generation_complete" });
            clearPipelineEventLog();
            break;
          }

          // Steered — re-parked at a fresh gate. Persist and wait again.
          if (result.pendingCheckpoint) {
            const sess = getSession();
            if (sess) {
              sess.pendingCheckpoint = result.pendingCheckpoint;
              saveSession();
            }
            sendGenerationCost(result);
            clearPipelineEventLog();
            break;
          }

          // approve / skip — the build completed. Apply, commit, finish
          // (mirrors the agentic chat path).
          applyPipelineResult(result, {
            steps: pipelineSteps,
            modules: pipelineModules,
            stats: result.stats,
            cost: result.cost,
          });
          sendGenerationCost(result);

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
              commitHash = commitTemplateState(currentSession.themePath, activeTpl.id, "Checkpoint approved: implementation", filePaths);
            } else {
              commitHash = commitThemeState(currentSession.themePath, "Checkpoint approved: implementation");
            }
            if (commitHash) {
              sendToClient({ type: "version_created", hash: commitHash });
            }
          }

          sendToClient({ type: "generation_complete" });
          {
            const sess = getSession();
            sendToClient({
              type: "modules_updated",
              modules: getOrderedModules().map((m) => m.moduleName),
              templateId: sess?.activeTemplateId || null,
              templates: (sess?.templates || []).map((t) => ({
                id: t.id, label: t.label, pageType: t.pageType, moduleCount: t.modules.length,
              })),
            });
          }
          clearPipelineEventLog();
        } catch (err) {
          clearPipelineEventLog();
          sendToClient({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      default:
        ws.send(JSON.stringify({ type: "error", message: `Unknown type: ${msg.type}` }));
    }
  });

  // Track this as the active client so in-flight pipelines send to it
  activeClientWs = ws;

  // Send initial state
  const session = getSession();
  if (session) {
    const cfg = loadConfig();
    const engineLabels: Record<string, string> = {
      "claude-code": "Claude Code",
      "anthropic-api": "Anthropic API",
      "claude-oauth": "Claude (OAuth)",
      "openai-api": "OpenAI API",
      "gemini-cli": "Gemini CLI",
      "gemini-api": "Gemini API",
      "codex-cli": "Codex CLI",
      "api": "Anthropic API",
    };
    const generating = isGenerating();
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
      updatedAt: session.updatedAt,
      // Multi-template context
      templateId: activeTpl?.id || null,
      pageType: activeTpl?.pageType || null,
      templates: (session.templates || []).map((t) => ({
        id: t.id,
        label: t.label,
        pageType: t.pageType,
        moduleCount: t.modules.length,
      })),
      // Plan-mode state
      planMode: !!cfg.planMode,
      plan: session.brandAssets?.plan || "",
      // Active generation state for reconnecting clients
      isGenerating: generating,
      // Per-project running generation cost (VIB-1770)
      costTotal: session.costTotal || null,
    }));

    // Replay accumulated pipeline events so reconnecting clients catch up
    if (generating && pipelineEventLog.length > 0) {
      for (const event of pipelineEventLog) {
        ws.send(JSON.stringify(event));
      }
    }
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
    // Always re-read from disk to pick up changes during development
    const buffer = readFileSync(fullPath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(buffer);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
}
