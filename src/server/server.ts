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
import { handleGenerateStream, handleAgenticGenerate, handleAgenticResume, handleFigmaImport, applyPipelineResult, shouldUseAgenticMode, setParseWarningCallback, resolveAgenticEngine, handlePlanModeStream, isPlanModeActive, isGenerating, cancelActiveGeneration } from "./ai-handler.js";
import { discardCheckpoint } from "./agent/pipeline.js";
import type { PipelineResult } from "./agent/types.js";
import type { CheckpointResolution, CheckpointAction } from "./agent/types.js";
import { handlePlanEditRoute, handlePlanDiscardRoute, handlePlanTemplatesRoute, handlePlanTemplateRoute, savePlan, clearPlan } from "./routes/plan.js";
import { parsePlanResponse } from "./plan-parser.js";
import { loadConfig, saveConfig, getHubSpotPak, getActiveHubSpotAccount } from "../utils/config.js";
import { detectHubSpotAuth, detectDataCenter, detectHubSpotAuthFromConfig } from "../utils/detect.js";
import { applyAutoFixes, parseUploadErrors, parseApiErrors } from "./auto-fix.js";
import { startStreamingJob, startJobSafe, getJob, addJobListener, removeJobListener } from "./process-manager.js";
import { isSafeThemeName } from "../utils/validate.js";
import { uploadTheme, type UploadFileError } from "../hubspot/uploader.js";
import { jsonResponse } from "./route-helpers.js";
import { publicErrorMessage } from "./errors.js";
import {
  resolveSecurityConfig,
  checkDisabledAuthBind,
  checkRequestAuth,
  isAllowedOrigin,
  AUTH_COOKIE,
  type SecurityConfig,
} from "./security.js";
import { startPreviewOrigin, type StartedPreviewOrigin } from "./preview-origin.js";
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
  handleWhatsNewRoute,
  handleWhatsNewDismissRoute,
} from "./routes/whats-new.js";
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

/**
 * Apply a completed agentic pipeline result to the session, persist + commit it
 * for version history, and notify the client (cost, preview, module list).
 * Shared by the chat, checkpoint-resume, and plan-approve paths (VIB-1880) so
 * the build+commit tail lives in exactly one place.
 */
function finalizeAgenticGeneration(
  result: PipelineResult,
  opts: {
    steps: { step: string; label: string; decisions?: string[] }[];
    modules: { name: string; status: "complete" | "failed" }[];
    commitLabel: string;
  },
): void {
  applyPipelineResult(result, {
    steps: opts.steps,
    modules: opts.modules,
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
      commitHash = commitTemplateState(currentSession.themePath, activeTpl.id, opts.commitLabel, filePaths);
    } else {
      commitHash = commitThemeState(currentSession.themePath, opts.commitLabel);
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
}

// ---------------------------------------------------------------------------
// Plan mode as a checkpoint variant (VIB-1880)
//
// Plan mode is the heaviest checkpoint: the whole deliberation phase is one
// "plan" checkpoint. These helpers are shared by the chat plan-mode branch and
// the `checkpoint_resolve {kind:"plan"}` path so plan deliberation, approval,
// and discard each live in one place — collapsing the old plan_approve branch.
// ---------------------------------------------------------------------------

/** Stream a plan-mode deliberation turn, persist the plan, and park a "plan"
 * checkpoint so the user can approve/steer/cancel through checkpoint_resolve. */
async function runPlanDeliberation(userMessage: string, fileIds?: string[]): Promise<void> {
  addMessage("user", userMessage);
  saveSession();

  try {
    sendToClient({ type: "stream_status", content: "Planning..." });
    let fullResponse = "";
    const fullText = await handlePlanModeStream(
      userMessage,
      (chunk) => {
        fullResponse += chunk;
        sendToClient({ type: "stream", content: chunk });
      },
      fileIds,
    );

    const parsed = parsePlanResponse(fullText || fullResponse);

    if (parsed.plan) {
      savePlan(parsed.plan);
      sendToClient({ type: "plan_updated", plan: parsed.plan });
      const sess = getSession();
      if (sess) {
        sess.pendingCheckpoint = {
          kind: "plan",
          resumeToken: "plan",
          preview: { kind: "plan", headline: "Plan ready for review", data: { plan: parsed.plan } },
          createdAt: new Date().toISOString(),
        };
        saveSession();
      }
    }
    if (parsed.choices) {
      sendToClient({
        type: "plan_choices",
        question: parsed.choices.question,
        options: parsed.choices.options,
      });
    }

    addMessage("assistant", parsed.cleanedContent);
    saveSession();

    sendToClient({ type: "plan_complete", cleanedContent: parsed.cleanedContent });
    sendToClient({ type: "generation_complete" });
  } catch (err) {
    sendToClient({ type: "error", message: publicErrorMessage(err) });
  }
}

/** Approve the parked plan: exit plan mode and run the build (the approved plan
 * is auto-prepended as the brief by handleAgenticGenerate). One-shot — the plan
 * has already gated, so no design checkpoint. */
async function runPlanApproval(): Promise<void> {
  const session = getSession();
  if (!session) {
    sendToClient({ type: "error", message: "No active session" });
    return;
  }
  const planMd = session.brandAssets?.plan;
  if (!planMd || !planMd.trim()) {
    sendToClient({ type: "error", message: "No plan to approve. Send a chat message first." });
    return;
  }

  saveConfig({ planMode: false });
  if (session.pendingCheckpoint?.kind === "plan") session.pendingCheckpoint = undefined;

  const approvalMessage = "Implement the approved plan.";
  addMessage("user", approvalMessage);
  saveSession();

  try {
    clearPipelineEventLog();
    const steps: { step: string; label: string; decisions?: string[] }[] = [];
    const modules: { name: string; status: "complete" | "failed" }[] = [];

    const result = await handleAgenticGenerate(
      approvalMessage,
      buildPipelineOnEvent(steps, modules),
    );

    if (result.canceled) {
      clearPipelineEventLog();
      return;
    }

    finalizeAgenticGeneration(result, { steps, modules, commitLabel: "Approved plan: implementation" });
  } catch (err) {
    clearPipelineEventLog();
    sendToClient({ type: "error", message: publicErrorMessage(err) });
  }
}

/** Discard the plan and exit plan mode (the plan checkpoint's "cancel"). */
function runPlanDiscard(): void {
  const session = getSession();
  if (session?.pendingCheckpoint?.kind === "plan") session.pendingCheckpoint = undefined;
  clearPlan();
  saveConfig({ planMode: false });
  saveSession();
  sendToClient({ type: "plan_discarded" });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ServerOptions {
  port: number;
  uiDir: string;
  contentMode?: "page" | "email";
  /** Bind address; defaults to VIBESPOT_HOST or 127.0.0.1 (VIB-1889). */
  host?: string;
  /**
   * Start the separate preview origin (VIB-1892). Default ON — the live
   * preview iframe loads from this origin so AI-generated page code runs
   * cross-origin to the app. Pass `false` only in tests that don't need it.
   */
  enablePreviewOrigin?: boolean;
}

export interface StartedServer {
  port: number;
  host: string;
  /** Shared-secret auth token, when token auth is active (VIB-1889). */
  authToken: string | null;
  /** The separate preview origin when enabled, else null (VIB-1892). */
  previewOrigin: StartedPreviewOrigin | null;
  close: () => void;
}

let serverContentMode: "page" | "email" = "page";

// The running preview origin (VIB-1892) — set by startServer, read by the
// /api/preview-origin route so the UI can point the preview iframe at it.
let activePreviewOrigin: StartedPreviewOrigin | null = null;

// Security policy for the running server — set once in startServer, read by
// the request/upgrade handlers (same module-state pattern as contentMode).
let security: SecurityConfig = resolveSecurityConfig();

export function getServerContentMode(): "page" | "email" {
  return serverContentMode;
}

export function startServer(opts: ServerOptions): Promise<StartedServer> {
  const { port, uiDir } = opts;
  serverContentMode = opts.contentMode || "page";
  security = resolveSecurityConfig(opts.host);

  // VIB-1906: disabling auth on a non-loopback bind is refused outright unless
  // VIBESPOT_TRUST_PROXY=1 acknowledges that an authenticating proxy is the
  // sole ingress to the app port (and even then it warns loudly). The only way
  // to reach a token-less non-loopback config is VIBESPOT_DISABLE_AUTH=1, so
  // this gate subsumes the old soft warning.
  const disabledAuthGate = checkDisabledAuthBind(security);
  if (disabledAuthGate.severity === "refuse") {
    throw new Error(disabledAuthGate.message!);
  }
  if (disabledAuthGate.severity === "warn") {
    console.warn(disabledAuthGate.message);
  }

  const server = createServer((req, res) => handleRequest(req, res, uiDir));

  // WebSocket server — upgrade on the same HTTP server. Browsers do not apply
  // CORS to WebSockets, so the upgrade enforces the Origin allow-list
  // (anti-CSWSH) plus the same auth gate as HTTP routes (VIB-1889).
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { origin?: string; req: IncomingMessage }) => {
      if (!isAllowedOrigin(info.origin, info.req.headers.host)) return false;
      return checkRequestAuth(info.req, security).ok;
    },
  });
  wss.on("connection", (ws) => handleWsConnection(ws));

  // The separate preview origin (VIB-1892): started alongside the app server
  // so AI-generated preview code runs cross-origin to the app. `port + 1` is
  // the app's own EADDRINUSE fallback, so the preview origin starts at
  // `port + 2` (and walks forward itself if that is taken).
  const started = async (boundPort: number): Promise<StartedServer> => {
    let previewOrigin: StartedPreviewOrigin | null = null;
    if (opts.enablePreviewOrigin !== false) {
      // frame-ancestors: on a loopback bind, allow both loopback spellings so
      // a user browsing via `localhost` still embeds a `127.0.0.1`-announced
      // preview. On a non-loopback bind (Docker/tailnet) the browser-facing
      // hostname is unknowable at boot, so fall back to any ancestor — the
      // access token still gates who can load the doc at all.
      const isLoopback = security.host === "127.0.0.1" || security.host === "localhost" || security.host === "::1";
      const frameAncestors = isLoopback
        ? [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]
        : ["*"];
      previewOrigin = await startPreviewOrigin({
        port: boundPort + 2,
        host: security.host,
        frameAncestors,
        uiDir,
      });
    }
    activePreviewOrigin = previewOrigin;
    return {
      port: boundPort,
      host: security.host,
      authToken: security.authToken,
      previewOrigin,
      close: () => {
        server.close();
        wss.close();
        previewOrigin?.close();
        if (activePreviewOrigin === previewOrigin) activePreviewOrigin = null;
      },
    };
  };

  return new Promise((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Try next port
        server.listen(port + 1, security.host, () => {
          started(port + 1).then(resolve, reject);
        });
      } else {
        reject(err);
      }
    });

    server.listen(port, security.host, () => {
      started(port).then(resolve, reject);
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

  // Auth gate (VIB-1889) — every route except /healthz and CORS preflights.
  // OPTIONS is exempt because preflights never carry credentials and
  // trigger no state change.
  if (method !== "OPTIONS") {
    const auth = checkRequestAuth(req, security);
    if (!auth.ok) {
      if (url.pathname.startsWith("/api/")) {
        jsonResponse(res, 401, { error: "Authentication required" });
      } else {
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>vibeSpot</title><body style=\"font-family:system-ui;padding:2rem\"><h1>Authentication required</h1><p>Open vibeSpot using the exact URL printed in the terminal where it was started (it includes a <code>?token=</code> secret).</p></body>");
      }
      return;
    }
    // First page load via the tokenized URL: persist the token as a session
    // cookie (rides on every later request incl. the WebSocket upgrade) and
    // strip the secret out of the address bar.
    if (auth.viaQueryToken && method === "GET" && !url.pathname.startsWith("/api/") && security.authToken) {
      url.searchParams.delete("token");
      res.writeHead(302, {
        "Set-Cookie": `${AUTH_COOKIE}=${security.authToken}; HttpOnly; SameSite=Strict; Path=/`,
        Location: url.pathname + url.search,
      });
      res.end();
      return;
    }
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
  // CORS — reflect only same-origin or local/private origins (VIB-1889).
  const origin = req.headers.origin;
  const originAllowed = isAllowedOrigin(origin, req.headers.host);
  if (origin && originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Vibespot-Token");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Cross-origin mutation guard (VIB-1889): CORS stops reads but not simple
  // no-preflight writes (e.g. text/plain POSTs from a hostile page). Reject
  // state-changing requests whose browser Origin fails the allow-list.
  if (origin && !originAllowed && method !== "GET" && method !== "HEAD") {
    jsonResponse(res, 403, { error: "Origin not allowed" });
    return;
  }

  switch (path) {
    case "/api/session":
      handleSessionRoute(method, res);
      break;

    case "/api/preview-origin":
      handlePreviewOriginRoute(req, res);
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

    // "What's new" release dialog (VIB-1885)
    case "/api/whats-new":
      if (method === "GET") handleWhatsNewRoute(res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/whats-new/dismiss":
      if (method === "POST") handleWhatsNewDismissRoute(req, res);
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

/**
 * Tell the UI where the separate preview origin lives (VIB-1892). The origin
 * hostname is derived from the request's Host header so the answer is
 * reachable from wherever the browser actually is (localhost vs 127.0.0.1 vs
 * a Docker/tailnet hostname); only the port differs between app and preview.
 * The token doubles as the postMessage handshake secret — this route sits
 * behind the app auth gate, so only an authenticated UI can read it.
 */
function handlePreviewOriginRoute(req: IncomingMessage, res: ServerResponse): void {
  if (!activePreviewOrigin) {
    jsonResponse(res, 200, { origin: null });
    return;
  }
  const hostHeader = req.headers.host || `${activePreviewOrigin.host}:0`;
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : hostHeader.split(":")[0];
  jsonResponse(res, 200, {
    origin: `http://${hostname}:${activePreviewOrigin.port}`,
    token: activePreviewOrigin.token,
  });
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

        // Barge-in (VIB-1880): a message that arrives mid-build supersedes the
        // running generation. Cancel it (cancel-and-replan); the replacement
        // run serializes behind it on the per-session generation lock in
        // ai-handler (VIB-1895) — no timed wait that could give up and let two
        // pipelines mutate the same session.
        if (isGenerating() && cancelActiveGeneration()) {
          sendToClient({ type: "generation_superseded" });
        }

        // A fresh chat supersedes any parked checkpoint gate (VIB-1877). Also
        // drop its in-memory resume state — otherwise every superseded gate
        // leaks its entry in the resume store for the life of the process
        // (VIB-1895). No-op for "plan" gates (they never enter the store).
        {
          const sess = getSession();
          if (sess?.pendingCheckpoint) {
            discardCheckpoint(sess.pendingCheckpoint.resumeToken);
            sess.pendingCheckpoint = undefined;
            saveSession();
          }
        }

        // ---------------------------------------------------------------
        // Plan-mode branch — DELIBERATION PHASE, no module generation.
        //
        // While planMode is active, the chat handler routes to the plan-mode
        // stream and refuses to enter the agentic pipeline. When a plan is
        // produced it parks a "plan" checkpoint (VIB-1880) so approval/discard
        // run through the same `checkpoint_resolve` protocol as design — plan
        // mode is just the heaviest checkpoint variant.
        // ---------------------------------------------------------------
        if (isPlanModeActive()) {
          await runPlanDeliberation(userMessage, fileIds);
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

            // Barge-in (VIB-1880): this run was itself superseded by an even
            // newer message. Stop quietly — the superseding run owns the UI and
            // will emit its own completion. Nothing was built or committed.
            if (result.canceled) {
              clearPipelineEventLog();
              break;
            }

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
            message: publicErrorMessage(err),
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
            message: publicErrorMessage(err),
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
              message: publicErrorMessage(err),
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
            if (!isSafeThemeName(session.themeName)) {
              ws.send(JSON.stringify({
                type: "upload_failed",
                output: "Theme name contains unsupported characters and cannot be uploaded via the HubSpot CLI.",
                errors: [{ file: "", message: "Unsafe theme name", fixable: false }],
              }));
              break;
            }
            const jobId = startStreamingJob(
              "hs", ["cms", "upload", session.themePath, session.themeName],
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
            message: publicErrorMessage(err),
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
            output: publicErrorMessage(err),
            errors: [{ file: "AI fix", message: publicErrorMessage(err), fixable: false }],
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
      // Plan approve/discard are now thin aliases over the unified plan
      // checkpoint (VIB-1880). The canonical path is checkpoint_resolve
      // {kind:"plan"}; these remain for older clients.
      case "plan_approve": {
        await runPlanApproval();
        break;
      }

      case "plan_discard": {
        runPlanDiscard();
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

        // Structure checkpoint (VIB-1879) carries an edited module outline back
        // on approve/skip. Coerce defensively — the build re-sanitizes names.
        const outline = Array.isArray(msg.outline)
          ? msg.outline
              .filter((it: unknown): it is Record<string, unknown> => !!it && typeof (it as Record<string, unknown>).name === "string")
              .map((it: Record<string, unknown>) => ({
                name: String(it.name),
                description: typeof it.description === "string" ? it.description : undefined,
                sourceIndex: Number.isInteger(it.sourceIndex) ? (it.sourceIndex as number) : undefined,
              }))
          : undefined;

        const resolution: CheckpointResolution = {
          kind: pending.kind,
          action: action as CheckpointAction,
          note: typeof msg.note === "string" ? msg.note : undefined,
          // Structure checkpoint (VIB-1879) carries the edited outline.
          outline,
          // Brand-intake channels (VIB-1878) — only meaningful for a
          // brand_intake gate resolved with "Bring your brand" (approve).
          ...(pending.kind === "brand_intake" && msg.brandIntake && typeof msg.brandIntake === "object"
            ? { brandIntake: msg.brandIntake as CheckpointResolution["brandIntake"] }
            : {}),
        };

        // Plan checkpoint (VIB-1880): resolved through the same protocol, but
        // the plan lives on the session — no in-memory resume store. approve →
        // build, steer → re-deliberate + re-park, cancel → drop plan.
        if (pending.kind === "plan") {
          session.pendingCheckpoint = undefined;
          saveSession();
          if (action === "cancel") {
            runPlanDiscard();
          } else if (action === "steer") {
            await runPlanDeliberation(resolution.note?.trim() || "Refine the plan further.");
          } else {
            await runPlanApproval();
          }
          break;
        }

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
            // Rehydrate the in-memory resume store from the persisted state if
            // the server restarted while parked (VIB-1883). `pending` is the
            // pre-clear snapshot taken at the top of this handler.
            pending.resumeState,
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

          // approve / skip — the build completed. Apply, commit, finish.
          finalizeAgenticGeneration(result, {
            steps: pipelineSteps,
            modules: pipelineModules,
            commitLabel: "Checkpoint approved: implementation",
          });
        } catch (err) {
          clearPipelineEventLog();
          sendToClient({
            type: "error",
            message: publicErrorMessage(err),
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
      // A parked checkpoint survives a client refresh / device sleep — the
      // server keeps the gate, so re-send it so the client can resume (VIB-1876).
      // Strip the internal `resumeState` (VIB-1883): it's a server-only disk
      // payload (plan/design system/blueprint); the UI only needs the preview.
      pendingCheckpoint: session.pendingCheckpoint
        ? { ...session.pendingCheckpoint, resumeState: undefined }
        : null,
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
