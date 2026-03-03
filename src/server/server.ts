/**
 * Local development server for vibeSpot vibe coding mode.
 * Serves the UI, handles WebSocket connections, and manages AI interactions.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, appendFileSync, rmSync, renameSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import {
  getSession,
  addMessage,
  updateModules,
  reorderModules,
  removeModule,
  updateFieldValue,
  getOrderedModules,
  writeModulesToDisk,
  saveSession,
  createSession,
  scanThemeFromDisk,
  loadSession,
  listSessions,
  deleteSession,
  reloadModulesFromDisk,
  getActiveTemplate,
  setActiveTemplate,
  addTemplate,
  removeTemplate,
  getModuleLibrary,
  migrateSession,
  type PageType,
  type TemplateEntry,
} from "./session.js";
import { commitThemeState, getHistory, rollbackToCommit, isGitAvailable } from "./project-git.js";
import { buildPreviewHtml, buildModulePreviewHtml } from "./preview.js";
import { handleGenerate, handleGenerateStream, setParseWarningCallback } from "./ai-handler.js";
import { analyzeSource, type SourceAnalysis } from "../wizard/source.js";
import { loadConfig, saveConfig, getApiKeyForEngine, type AIEngineType } from "../utils/config.js";
import { detectEnvironment, detectHubSpotCLI, detectHubSpotAuth, detectDataCenter, detectGitHubCLI, detectGitHubAuth } from "../utils/detect.js";
import { applyAutoFixes, parseUploadErrors } from "../server/auto-fix.js";
import { startJob, getJob, startStreamingJob, addJobListener, removeJobListener } from "./process-manager.js";
import { ensureDir, writeFile } from "../utils/fs.js";

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

  // Static files from ui/ directory
  serveStatic(url.pathname, uiDir, res);
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

    case "/api/upload":
      handleUploadRoute(res);
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

    case "/api/history":
      if (method === "GET") handleHistoryRoute(res);
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

    case "/api/module-library":
      if (method === "GET") handleModuleLibraryRoute(res);
      else jsonResponse(res, 405, { error: "Method not allowed" });
      break;

    case "/api/brand-assets":
      handleBrandAssetsRoute(method, req, res);
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

function handleSessionRoute(method: string, res: ServerResponse): void {
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

function handleModulesRoute(
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
    readBody(req, (body) => {
      const { moduleName } = JSON.parse(body);
      removeModule(moduleName);
      saveSession();
      jsonResponse(res, 200, { ok: true });
    });
    return;
  }

  jsonResponse(res, 405, { error: "Method not allowed" });
}

function handleReorderRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    const { order } = JSON.parse(body);
    if (Array.isArray(order)) {
      reorderModules(order);
      saveSession();
      jsonResponse(res, 200, { ok: true });
    } else {
      jsonResponse(res, 400, { error: "order must be an array" });
    }
  });
}

async function handleUploadRoute(res: ServerResponse): Promise<void> {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  try {
    // Write all modules to disk first
    writeModulesToDisk();

    // Apply auto-fixes before uploading
    const fixes = applyAutoFixes(session.themePath);

    // Start a streaming upload job
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

function handleFieldRoute(req: IncomingMessage, res: ServerResponse): void {
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

function handleImportRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { url } = JSON.parse(body);
      if (!url || typeof url !== "string") {
        jsonResponse(res, 400, { error: "url is required" });
        return;
      }

      // Analyze the source (clones if GitHub URL)
      const analysis = analyzeSource(url);

      // Build a component summary for the AI
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
        // Pre-built prompt the UI can send directly to the chat
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
// Setup routes — onboarding flow in the browser
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = join(homedir(), "vibespot-themes");

function handleSetupInfoRoute(res: ServerResponse): void {
  const session = getSession();
  const config = loadConfig();

  // Check if hs CLI is installed
  let hsInstalled = false;
  try {
    execSync("hs --version", { encoding: "utf-8", stdio: "pipe" });
    hsInstalled = true;
  } catch { /* not installed */ }

  // Check for API key
  const hasApiKey = !!(config.anthropicApiKey || process.env.ANTHROPIC_API_KEY);

  // Check for Claude Code
  let hasClaudeCode = false;
  try {
    execSync("claude --version", { encoding: "utf-8", stdio: "pipe" });
    hasClaudeCode = true;
  } catch { /* not installed */ }

  // List previous sessions
  const sessions = listSessions()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10);

  // Find local theme folders in workspace/
  const localThemes: string[] = [];
  if (existsSync(WORKSPACE_DIR)) {
    try {
      for (const entry of readdirSync(WORKSPACE_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const themeJson = join(WORKSPACE_DIR, entry.name, "theme.json");
          if (existsSync(themeJson)) {
            localThemes.push(entry.name);
          }
        }
      }
    } catch { /* ignore */ }
  }

  jsonResponse(res, 200, {
    hasActiveSession: !!session,
    activeSession: session ? {
      id: session.id,
      themeName: session.themeName,
      moduleCount: session.modules.length,
    } : null,
    hsInstalled,
    hasApiKey,
    hasClaudeCode,
    aiAvailable: hasApiKey || hasClaudeCode,
    sessions,
    localThemes,
  });
}

function handleSetupCreateRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
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

      // Remove existing directory if it exists (stale from a previous run)
      if (existsSync(themePath)) {
        rmSync(themePath, { recursive: true, force: true });
      }

      // hs create ALWAYS creates in process.cwd(), ignoring execSync's cwd option.
      // So we create it wherever it lands, then move it to the workspace.
      const cwdBefore = new Set(readdirSync(process.cwd()));
      execSync(`hs create website-theme "${themeName}"`, {
        encoding: "utf-8",
        stdio: "pipe",
      });

      // Find where hs create actually put the theme
      let createdAt = join(process.cwd(), themeName);
      if (!existsSync(createdAt)) {
        const cwdAfter = readdirSync(process.cwd());
        const newDir = cwdAfter.find((e) => !cwdBefore.has(e) && existsSync(join(process.cwd(), e)));
        if (newDir) createdAt = join(process.cwd(), newDir);
      }

      // Move to workspace if it was created elsewhere
      if (createdAt !== themePath && existsSync(createdAt)) {
        renameSync(createdAt, themePath);
      }

      // Clear boilerplate page templates (keep layouts/ and partials/ for extends)
      const tplDir = join(themePath, "templates");
      if (existsSync(tplDir)) {
        for (const f of readdirSync(tplDir)) {
          if (f.endsWith(".html")) rmSync(join(tplDir, f));
        }
      }

      // Create a fresh session — don't scan boilerplate modules into it
      // (boilerplate modules stay on disk but the preview shows the welcome screen)
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

function handleSetupFetchRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { name } = JSON.parse(body);
      if (!name || typeof name !== "string") {
        jsonResponse(res, 400, { error: "Theme name is required" });
        return;
      }

      const themePath = join(WORKSPACE_DIR, name);
      ensureDir(WORKSPACE_DIR);

      execSync(`hs fetch "${name}" "${themePath}"`, {
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

function handleSetupOpenRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { path: themePath } = JSON.parse(body);
      if (!themePath || typeof themePath !== "string") {
        jsonResponse(res, 400, { error: "Theme path is required" });
        return;
      }

      // Support both absolute paths and workspace-relative names
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

function handleSetupResumeRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
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

function handleSetupApiKeyRoute(req: IncomingMessage, res: ServerResponse): void {
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

// ---------------------------------------------------------------------------
// Settings routes — environment management, API keys, tool install, auth
// ---------------------------------------------------------------------------

function handleSettingsStatusRoute(res: ServerResponse): void {
  const env = detectEnvironment();
  const config = loadConfig();

  jsonResponse(res, 200, {
    environment: env,
    config: {
      aiEngine: config.aiEngine || null,
      claudeCodeModel: config.claudeCodeModel || null,
      anthropicApiModel: config.anthropicApiModel || null,
      openaiApiModel: config.openaiApiModel || null,
    },
  });
}

function handleSettingsEngineRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { engine, model } = JSON.parse(body);

      const validEngines: AIEngineType[] = [
        "claude-code", "anthropic-api", "openai-api", "gemini-cli", "gemini-api", "codex-cli",
      ];
      if (!validEngines.includes(engine)) {
        jsonResponse(res, 400, { error: `Invalid engine: ${engine}` });
        return;
      }

      const configUpdate: Record<string, unknown> = { aiEngine: engine };
      if (model) {
        switch (engine) {
          case "claude-code":
            configUpdate.claudeCodeModel = model;
            break;
          case "anthropic-api":
            configUpdate.anthropicApiModel = model;
            break;
          case "openai-api":
            configUpdate.openaiApiModel = model;
            break;
        }
      }

      saveConfig(configUpdate as any);
      jsonResponse(res, 200, { ok: true, engine });
    } catch (err) {
      jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function handleSettingsApiKeyRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { provider, apiKey } = JSON.parse(body);

      if (!provider || typeof provider !== "string") {
        jsonResponse(res, 400, { error: "provider is required" });
        return;
      }

      // Handle deletion (apiKey is null or empty)
      if (!apiKey) {
        const configUpdate: Record<string, unknown> = {};
        switch (provider) {
          case "anthropic": configUpdate.anthropicApiKey = ""; break;
          case "openai": configUpdate.openaiApiKey = ""; break;
          case "gemini": configUpdate.geminiApiKey = ""; break;
          default:
            jsonResponse(res, 400, { error: `Unknown provider: ${provider}` });
            return;
        }
        saveConfig(configUpdate as any);
        jsonResponse(res, 200, { ok: true, provider, deleted: true });
        return;
      }

      // Save the key
      const configUpdate: Record<string, unknown> = {};
      switch (provider) {
        case "anthropic": configUpdate.anthropicApiKey = apiKey; break;
        case "openai": configUpdate.openaiApiKey = apiKey; break;
        case "gemini": configUpdate.geminiApiKey = apiKey; break;
        default:
          jsonResponse(res, 400, { error: `Unknown provider: ${provider}` });
          return;
      }

      saveConfig(configUpdate as any);
      jsonResponse(res, 200, { ok: true, provider });
    } catch (err) {
      jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function handleSettingsInstallRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { tool } = JSON.parse(body);

      const installCommands: Record<string, { cmd: string; desc: string }> = {
        hubspot: { cmd: "npm install -g @hubspot/cli", desc: "Installing HubSpot CLI" },
        claude: { cmd: "npm install -g @anthropic-ai/claude-code", desc: "Installing Claude Code" },
        gemini: { cmd: "npm install -g @google/gemini-cli", desc: "Installing Gemini CLI" },
        codex: { cmd: process.platform === "darwin" ? "brew install --cask codex" : "npm install -g @openai/codex", desc: "Installing OpenAI Codex" },
        gh: { cmd: process.platform === "darwin" ? "brew install gh" : "npm install -g @cli/gh", desc: "Installing GitHub CLI" },
      };

      const config = installCommands[tool];
      if (!config) {
        jsonResponse(res, 400, { error: `Unknown tool: ${tool}. Valid: ${Object.keys(installCommands).join(", ")}` });
        return;
      }

      const jobId = startJob(config.cmd, config.desc, { timeout: 120_000 });
      jsonResponse(res, 200, { ok: true, jobId });
    } catch (err) {
      jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function handleSettingsHsAuthRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const parsed = JSON.parse(body || "{}");

      const hs = detectHubSpotCLI();
      if (!hs.found) {
        jsonResponse(res, 400, { error: "HubSpot CLI not installed", needsInstall: true });
        return;
      }

      // Check if already authenticated
      const auth = detectHubSpotAuth();
      if (auth.authenticated && !parsed.force) {
        jsonResponse(res, 200, {
          ok: true,
          alreadyAuthenticated: true,
          portalName: auth.portalName,
          portalId: auth.portalId,
        });
        return;
      }

      if (parsed.personalAccessKey) {
        // Non-interactive auth with provided key
        const jobId = startJob(
          `echo "${parsed.personalAccessKey}" | hs auth personalaccesskey`,
          "Authenticating with HubSpot",
          { timeout: 30_000 }
        );
        jsonResponse(res, 200, { ok: true, jobId });
        return;
      }

      // No key provided — return instructions for user to get one
      jsonResponse(res, 200, {
        needsKey: true,
        instructions: "Create a personal access key in HubSpot",
        url: "https://app.hubspot.com/portal-recommend/l?slug=personal-access-key",
        steps: [
          "Click the link above to open HubSpot",
          "Select your account",
          "Create a Personal Access Key with CMS permissions",
          "Copy the key and paste it below",
        ],
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function handleSettingsGhAuthRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const parsed = JSON.parse(body || "{}");

      const gh = detectGitHubCLI();
      if (!gh.found) {
        jsonResponse(res, 400, { error: "GitHub CLI not installed", needsInstall: true });
        return;
      }

      // Check if already authenticated
      const auth = detectGitHubAuth();
      if (auth.authenticated && !parsed.force) {
        jsonResponse(res, 200, {
          ok: true,
          alreadyAuthenticated: true,
          username: auth.username,
        });
        return;
      }

      if (parsed.token) {
        // Auth with provided token
        const jobId = startJob(
          `echo "${parsed.token}" | gh auth login --with-token`,
          "Authenticating with GitHub",
          { timeout: 30_000 }
        );
        jsonResponse(res, 200, { ok: true, jobId });
        return;
      }

      // Start browser-based auth flow
      const jobId = startJob(
        "gh auth login --web --git-protocol https",
        "GitHub authentication (check your browser)",
        { timeout: 300_000 }
      );
      jsonResponse(res, 200, { ok: true, jobId, browserAuthRequired: true });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function handleSettingsHsSwitchRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { portalId, action } = JSON.parse(body);

      const hs = detectHubSpotCLI();
      if (!hs.found) {
        jsonResponse(res, 400, { error: "HubSpot CLI not installed" });
        return;
      }

      if (action === "remove" && portalId) {
        // Remove account: hs accounts clean --account=<portalId>
        const jobId = startJob(
          `hs accounts remove ${portalId}`,
          `Removing HubSpot account ${portalId}`,
          { timeout: 15_000 }
        );
        jsonResponse(res, 200, { ok: true, jobId });
        return;
      }

      if (portalId) {
        // Switch default account: hs accounts use <portalId>
        const jobId = startJob(
          `hs accounts use ${portalId}`,
          `Switching to HubSpot account ${portalId}`,
          { timeout: 15_000 }
        );
        jsonResponse(res, 200, { ok: true, jobId });
        return;
      }

      jsonResponse(res, 400, { error: "portalId required" });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function handleSettingsGhLogoutRoute(res: ServerResponse): void {
  const jobId = startJob(
    "gh auth logout --hostname github.com -y",
    "Logging out of GitHub",
    { timeout: 15_000 }
  );
  jsonResponse(res, 200, { ok: true, jobId });
}

function handleSettingsCLIAuthRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { cli, apiKey } = JSON.parse(body || "{}");

      switch (cli) {
        case "claude": {
          // Claude Code auth — launch interactive login
          // We need to run `claude` without CLAUDECODE env to avoid nesting error
          const jobId = startJob(
            "CLAUDECODE= claude --print -p 'reply OK'",
            "Authenticating Claude Code (check your browser if prompted)",
            { timeout: 120_000 }
          );
          jsonResponse(res, 200, { ok: true, jobId, hint: "If Claude Code opens a browser window, complete the sign-in there." });
          break;
        }
        case "gemini": {
          // Gemini CLI auth — launch a simple prompt to trigger login
          const jobId = startJob(
            "gemini -p 'reply OK'",
            "Authenticating Gemini CLI (check your browser if prompted)",
            { timeout: 120_000 }
          );
          jsonResponse(res, 200, { ok: true, jobId, hint: "If Gemini opens a browser window, complete the sign-in there." });
          break;
        }
        case "codex": {
          // Codex CLI — two auth paths: OAuth (codex login) or API key
          if (apiKey && apiKey.trim()) {
            // API key path — save to env, config, and shell profile
            const key = apiKey.trim();
            process.env.OPENAI_API_KEY = key;
            saveConfig({ openaiApiKey: key } as any);
            const profileLine = `export OPENAI_API_KEY="${key}"`;
            const shellProfile = process.env.SHELL?.includes("zsh")
              ? join(homedir(), ".zshrc")
              : join(homedir(), ".bashrc");
            try {
              const existing = existsSync(shellProfile)
                ? readFileSync(shellProfile, "utf-8")
                : "";
              if (!existing.includes("OPENAI_API_KEY")) {
                appendFileSync(shellProfile, `\n# Added by vibeSpot\n${profileLine}\n`);
              }
            } catch { /* ignore profile write errors */ }
            jsonResponse(res, 200, { ok: true, message: "API key saved" });
          } else {
            // OAuth path — run `codex login` as background job
            const jobId = startJob(
              "codex login",
              "Authenticating Codex CLI (check your browser if prompted)",
              { timeout: 120_000 }
            );
            jsonResponse(res, 200, { ok: true, jobId, hint: "Complete the sign-in in your browser." });
          }
          break;
        }
        default:
          jsonResponse(res, 400, { error: `Unknown CLI: ${cli}` });
      }
    } catch (err) {
      jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function handleSettingsJobRoute(path: string, res: ServerResponse): void {
  const jobId = path.replace("/api/settings/job/", "");
  if (!jobId) {
    jsonResponse(res, 400, { error: "Job ID required" });
    return;
  }

  const job = getJob(jobId);
  if (!job) {
    jsonResponse(res, 404, { error: "Job not found" });
    return;
  }

  jsonResponse(res, 200, {
    id: job.id,
    status: job.status,
    description: job.description,
    output: job.output,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  });
}

// ---------------------------------------------------------------------------
// Theme routes
// ---------------------------------------------------------------------------

function handleThemesRoute(method: string, req: IncomingMessage, res: ServerResponse): void {
  if (method === "GET") {
    const session = getSession();
    const sessions = listSessions()
      .sort((a, b) => b.updatedAt - a.updatedAt);

    jsonResponse(res, 200, {
      activeTheme: session
        ? { id: session.id, themeName: session.themeName }
        : null,
      sessions,
    });
    return;
  }

  if (method === "DELETE") {
    readBody(req, (body) => {
      try {
        const { sessionId, deleteFiles } = JSON.parse(body);
        deleteSession(sessionId, deleteFiles);
        jsonResponse(res, 200, { ok: true });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  jsonResponse(res, 405, { error: "Method not allowed" });
}

function handleThemeSwitchRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { sessionId } = JSON.parse(body);
      const session = loadSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: "Session not found" });
        return;
      }

      jsonResponse(res, 200, {
        ok: true,
        themeName: session.themeName,
        themePath: session.themePath,
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function handleDeleteLocalThemeRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { themeName } = JSON.parse(body);
      if (!themeName || typeof themeName !== "string") {
        jsonResponse(res, 400, { error: "Theme name is required" });
        return;
      }
      const themePath = join(WORKSPACE_DIR, themeName);
      if (!existsSync(themePath)) {
        jsonResponse(res, 404, { error: "Theme not found on disk" });
        return;
      }
      rmSync(themePath, { recursive: true, force: true });
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Version history routes
// ---------------------------------------------------------------------------

function handleHistoryRoute(res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }
  if (!isGitAvailable()) {
    jsonResponse(res, 200, { available: false, commits: [] });
    return;
  }
  const commits = getHistory(session.themePath, 50);
  jsonResponse(res, 200, { available: true, commits });
}

function handleRollbackRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const session = getSession();
      if (!session) {
        jsonResponse(res, 404, { error: "No active session" });
        return;
      }

      const { hash } = JSON.parse(body);
      if (!hash || typeof hash !== "string") {
        jsonResponse(res, 400, { error: "Commit hash is required" });
        return;
      }

      // Add a system message to chat (chat is immutable, always grows)
      addMessage("assistant", `Rolled back to version ${hash.slice(0, 7)}.`);

      const result = rollbackToCommit(session.themePath, hash);
      if (!result.success) {
        jsonResponse(res, 500, { error: result.error || "Rollback failed" });
        return;
      }

      // Reload modules from restored files
      reloadModulesFromDisk();
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

// ---------------------------------------------------------------------------
// Dashboard & template routes
// ---------------------------------------------------------------------------

function handleDashboardRoute(res: ServerResponse): void {
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
    },
  });
}

function handleTemplatesRoute(method: string, req: IncomingMessage, res: ServerResponse): void {
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

function handleTemplateActivateRoute(req: IncomingMessage, res: ServerResponse): void {
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

function handleModuleLibraryRoute(res: ServerResponse): void {
  const library = getModuleLibrary();
  jsonResponse(res, 200, {
    modules: library.map((entry) => ({
      moduleName: entry.module.moduleName,
      usedIn: entry.usedIn,
      fieldsJson: entry.module.fieldsJson,
    })),
  });
}

function handleAddModuleToTemplateRoute(path: string, req: IncomingMessage, res: ServerResponse): void {
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

      // Find the module in the library (across all templates)
      const library = getModuleLibrary();
      const entry = library.find((e) => e.module.moduleName === moduleName);
      if (!entry) {
        jsonResponse(res, 404, { error: `Module "${moduleName}" not found in library` });
        return;
      }

      // Copy the module into the active template / session
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

function handleBrandAssetsRoute(method: string, req: IncomingMessage, res: ServerResponse): void {
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
        if (!type || !content) {
          jsonResponse(res, 400, { error: "type and content are required" });
          return;
        }
        if (type !== "styleguide" && type !== "brandvoice") {
          jsonResponse(res, 400, { error: `Invalid type: ${type}. Must be "styleguide" or "brandvoice"` });
          return;
        }

        if (!session.brandAssets) session.brandAssets = {};
        session.brandAssets[type] = content;
        session.updatedAt = Date.now();

        // Also persist to theme directory
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

        // Remove from disk too
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
        try {
          await handleGenerateStream(
            userMessage,
            (chunk) => {
              ws.send(JSON.stringify({ type: "stream", content: chunk }));
            },
            (status) => {
              ws.send(JSON.stringify({ type: "stream_status", content: status }));
            }
          );

          // Write modules to disk and commit for version history
          const currentSession = getSession();
          if (currentSession) {
            writeModulesToDisk();
            const commitHash = commitThemeState(currentSession.themePath, userMessage);
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

          // Start streaming upload job
          const jobId = startStreamingJob(
            `hs cms upload "${session.themePath}" "${session.themeName}"`,
            "Uploading to HubSpot",
            { cwd: join(session.themePath, ".."), timeout: 180_000 }
          );

          ws.send(JSON.stringify({ type: "upload_started", jobId }));

          // Stream output chunks to the client
          const chunkListener = (chunk: string) => {
            ws.send(JSON.stringify({ type: "upload_output", chunk }));
          };
          addJobListener(jobId, chunkListener);

          // Poll for job completion
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
// Static file serving
// ---------------------------------------------------------------------------

function serveStatic(pathname: string, uiDir: string, res: ServerResponse): void {
  // Default to index.html
  let filePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = join(uiDir, filePath);

  if (!existsSync(fullPath)) {
    // SPA fallback — serve index.html for unknown routes
    const indexPath = join(uiDir, "index.html");
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(content);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
    return;
  }

  const ext = extname(fullPath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    const content = readFileSync(fullPath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, callback: (body: string) => void): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => callback(Buffer.concat(chunks).toString("utf-8")));
}
