/**
 * Settings routes — environment management, API keys, tool install, auth.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { jsonResponse, readBody } from "../route-helpers.js";
import { loadConfig, saveConfig, getApiKeyForEngine, addHubSpotAccount, removeHubSpotAccount, setActiveHubSpotAccount, setCliToolEnabled, type AIEngineType, type HubSpotAccountConfig } from "../../utils/config.js";
import { listSessions } from "../session.js";
import { getLocalThemes } from "./setup.js";
import { detectEnvironment, detectHubSpotCLI, detectHubSpotAuth, detectGitHubCLI, detectGitHubAuth } from "../../utils/detect.js";
import { validatePak } from "../../hubspot/api.js";
import { getVersion } from "../../utils/fs.js";
import { startJob, startJobSafe, getJob } from "../process-manager.js";

// ---------------------------------------------------------------------------
// Live model catalog — fetched from provider APIs, cached 10 minutes
// ---------------------------------------------------------------------------

type ModelEntry = { id: string; label: string };
const modelCache: { data: Record<string, ModelEntry[]>; ts: number } = { data: {}, ts: 0 };
const MODEL_CACHE_TTL = 10 * 60 * 1000;

const STATIC_MODELS: Record<string, ModelEntry[]> = {
  "claude-code": [
    { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (default)" },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  "codex-cli": [
    { id: "gpt-5.5", label: "GPT-5.5 (default)" },
    { id: "gpt-5.5-pro", label: "GPT-5.5 Pro" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
    { id: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { id: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
    { id: "codex-mini-latest", label: "Codex Mini (latest)" },
  ],
  "anthropic-api": [
    { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (default)" },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  "claude-oauth": [
    { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (default)" },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  "openai-api": [
    { id: "gpt-5.5", label: "GPT-5.5 (default)" },
    { id: "gpt-5.5-pro", label: "GPT-5.5 Pro" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { id: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  ],
  "gemini-api": [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (default)" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  ],
  "gemini-cli": [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (default)" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  ],
};

// Models we want to surface for OpenAI API + Codex CLI dropdowns.
// Inclusive of current reasoning/coding families; matches `id` exactly.
// Supports decimal-versioned variants like gpt-5.5, gpt-4.1.
const OPENAI_MODEL_REGEX =
  /^(gpt-[45](\.\d+)?(-[a-z0-9-]+)?|o[1-4](-(mini|pro|nano)(-high)?)?|codex(-[a-z0-9-]+)?)$/;

const CODEX_MODEL_REGEX = OPENAI_MODEL_REGEX;

function labelForOpenAIModel(id: string): string {
  // gpt-X[.Y] or gpt-X[.Y]-suffix → "GPT-X[.Y] Suffix"
  const gptMatch = id.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/);
  if (gptMatch) {
    const version = gptMatch[1];
    const suffix = gptMatch[2];
    if (!suffix) return `GPT-${version}`;
    const pretty = suffix.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return `GPT-${version} ${pretty}`;
  }
  // codex-* → "Codex *"
  if (id.startsWith("codex-")) {
    const suffix = id.slice(6).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return `Codex ${suffix}`;
  }
  // o-series: keep as-is, just spaces
  if (/^o\d/.test(id)) return id.replace(/-/g, " ");
  return id;
}

async function fetchAnthropicModels(apiKey: string): Promise<ModelEntry[]> {
  const resp = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!resp.ok) return [];
  const data = await resp.json() as { data: { id: string; display_name: string }[] };
  return data.data
    .filter((m) => !m.id.startsWith("claude-3-") && !m.id.startsWith("claude-2"))
    .map((m) => ({ id: m.id, label: m.display_name }));
}

async function fetchOpenAIModelIds(apiKey: string): Promise<string[]> {
  const resp = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json() as { data: { id: string }[] };
  return data.data.map((m) => m.id);
}

function filterAndLabel(ids: string[], regex: RegExp): ModelEntry[] {
  return ids
    .filter((id) => regex.test(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, label: labelForOpenAIModel(id) }));
}

async function fetchGeminiModels(apiKey: string): Promise<ModelEntry[]> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
  );
  if (!resp.ok) return [];
  const data = await resp.json() as { models: { name: string; displayName: string }[] };
  return data.models
    .filter((m) => m.name.includes("gemini-2"))
    .map((m) => ({ id: m.name.replace("models/", ""), label: m.displayName }));
}

async function getModelCatalog(): Promise<Record<string, ModelEntry[]>> {
  if (Date.now() - modelCache.ts < MODEL_CACHE_TTL && Object.keys(modelCache.data).length > 0) {
    return modelCache.data;
  }

  const config = loadConfig();
  const catalog: Record<string, ModelEntry[]> = { ...STATIC_MODELS };

  const jobs: Promise<void>[] = [];

  const anthropicKey = getApiKeyForEngine("anthropic-api", config);
  if (anthropicKey) {
    jobs.push(
      fetchAnthropicModels(anthropicKey)
        .then((models) => {
          if (models.length) {
            catalog["anthropic-api"] = models;
            catalog["claude-oauth"] = models; // same model list
          }
        })
        .catch(() => {}),
    );
  }

  const openaiKey = getApiKeyForEngine("openai-api", config);
  if (openaiKey) {
    jobs.push(
      fetchOpenAIModelIds(openaiKey)
        .then((ids) => {
          if (!ids.length) return;
          const openaiModels = filterAndLabel(ids, OPENAI_MODEL_REGEX);
          if (openaiModels.length) catalog["openai-api"] = openaiModels;
          // Codex CLI talks to the OpenAI API — reuse the same account's
          // model list, filtered to families codex actually supports.
          const codexModels = filterAndLabel(ids, CODEX_MODEL_REGEX);
          if (codexModels.length) catalog["codex-cli"] = codexModels;
        })
        .catch(() => {}),
    );
  }

  const geminiKey = getApiKeyForEngine("gemini-api", config);
  if (geminiKey) {
    jobs.push(
      fetchGeminiModels(geminiKey)
        .then((models) => {
          if (models.length) {
            catalog["gemini-api"] = models;
            catalog["gemini-cli"] = models;
          }
        })
        .catch(() => {}),
    );
  }

  await Promise.all(jobs);

  modelCache.data = catalog;
  modelCache.ts = Date.now();
  return catalog;
}

export function handleSettingsStatusRoute(res: ServerResponse): void {
  const env = detectEnvironment();
  const config = loadConfig();

  const configPayload = {
    aiEngine: config.aiEngine || null,
    claudeCodeModel: config.claudeCodeModel || null,
    anthropicApiModel: config.anthropicApiModel || null,
    openaiApiModel: config.openaiApiModel || null,
    codexCliModel: config.codexCliModel || null,
    geminiCliModel: config.geminiCliModel || null,
    geminiApiModel: config.geminiApiModel || null,
    langdockApiModel: config.langdockApiModel || null,
    langdockBaseUrl: config.langdockBaseUrl || null,
    hubspotUploadMode: config.hubspotUploadMode || "api",
    hubspotAccounts: (config.hubspotAccounts || []).map((a: HubSpotAccountConfig) => ({
      portalId: a.portalId,
      portalName: a.portalName,
      dataCenter: a.dataCenter,
    })),
    activeHubSpotAccount: config.activeHubSpotAccount || null,
    enabledCLITools: config.enabledCLITools || [],
    agenticMode: config.agenticMode,
    agenticConcurrency: config.agenticConcurrency,
    planMode: config.planMode || false,
    extendedThinking: config.extendedThinking || false,
    extendedThinkingBudget: config.extendedThinkingBudget || "medium",
    webSearch: config.webSearch || false,
    figmaToken: config.figmaToken ? "••••" + config.figmaToken.slice(-4) : null,
  };

  const sessionCount = listSessions().length;
  const localThemeCount = getLocalThemes().length;

  const version = getVersion();

  getModelCatalog().then((models) => {
    jsonResponse(res, 200, {
      version,
      environment: env,
      config: configPayload,
      models,
      sessionCount,
      localThemeCount,
    });
  }).catch(() => {
    jsonResponse(res, 200, {
      version,
      environment: env,
      config: configPayload,
      models: STATIC_MODELS,
      sessionCount,
      localThemeCount,
    });
  });
}

export function handleSettingsEngineRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { engine, model } = JSON.parse(body);

      const validEngines: AIEngineType[] = [
        "claude-code", "anthropic-api", "claude-oauth", "openai-api", "gemini-cli", "gemini-api", "codex-cli", "langdock-api",
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
          case "claude-oauth":
            configUpdate.anthropicApiModel = model;
            break;
          case "openai-api":
            configUpdate.openaiApiModel = model;
            break;
          case "codex-cli":
            configUpdate.codexCliModel = model;
            break;
          case "gemini-cli":
            configUpdate.geminiCliModel = model;
            break;
          case "gemini-api":
            configUpdate.geminiApiModel = model;
            break;
          case "langdock-api":
            configUpdate.langdockApiModel = model;
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

export function handleSettingsApiKeyRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { provider, apiKey } = JSON.parse(body);

      if (!provider || typeof provider !== "string") {
        jsonResponse(res, 400, { error: "provider is required" });
        return;
      }

      if (!apiKey) {
        const configUpdate: Record<string, unknown> = {};
        switch (provider) {
          case "anthropic": configUpdate.anthropicApiKey = ""; break;
          case "openai": configUpdate.openaiApiKey = ""; break;
          case "gemini": configUpdate.geminiApiKey = ""; break;
          case "figma": configUpdate.figmaToken = ""; break;
          default:
            jsonResponse(res, 400, { error: `Unknown provider: ${provider}` });
            return;
        }
        saveConfig(configUpdate as any);
        jsonResponse(res, 200, { ok: true, provider, deleted: true });
        return;
      }

      const configUpdate: Record<string, unknown> = {};
      switch (provider) {
        case "anthropic": configUpdate.anthropicApiKey = apiKey; break;
        case "openai": configUpdate.openaiApiKey = apiKey; break;
        case "gemini": configUpdate.geminiApiKey = apiKey; break;
        case "figma": configUpdate.figmaToken = apiKey; break;
        default:
          jsonResponse(res, 400, { error: `Unknown provider: ${provider}` });
          return;
      }

      saveConfig(configUpdate as any);

      let autoSelectedEngine: string | null = null;
      const currentConfig = loadConfig();
      if (!currentConfig.aiEngine) {
        const engineMap: Record<string, string> = {
          anthropic: "anthropic-api",
          openai: "openai-api",
          gemini: "gemini-api",
        };
        const engine = engineMap[provider];
        if (engine) {
          saveConfig({ aiEngine: engine } as any);
          autoSelectedEngine = engine;
        }
      }

      jsonResponse(res, 200, { ok: true, provider, autoSelectedEngine });
    } catch (err) {
      jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleSettingsInstallRoute(req: IncomingMessage, res: ServerResponse): void {
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

export function handleSettingsHsAuthRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const parsed = JSON.parse(body || "{}");
      const config = loadConfig();
      const uploadMode = config.hubspotUploadMode || "api";

      if (parsed.personalAccessKey) {
        if (uploadMode === "api") {
          // API mode: validate PAK directly via HTTP, store in config
          validatePak(parsed.personalAccessKey).then((info) => {
            addHubSpotAccount(parsed.personalAccessKey, info.portalId, info.portalName, info.dataCenter);
            jsonResponse(res, 200, {
              ok: true,
              portalName: info.portalName,
              portalId: info.portalId,
              dataCenter: info.dataCenter,
            });
          }).catch((err) => {
            jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
          });
          return;
        } else {
          // CLI mode: use hs auth command
          const hs = detectHubSpotCLI();
          if (!hs.found) {
            jsonResponse(res, 400, { error: "HubSpot CLI not installed", needsInstall: true });
            return;
          }
          const jobId = startJobSafe(
            "hs", ["auth", `--pak=${parsed.personalAccessKey}`],
            "Authenticating with HubSpot",
            { timeout: 30_000 }
          );
          jsonResponse(res, 200, { ok: true, jobId });
          return;
        }
      }

      // No key provided — check existing auth
      if (uploadMode === "api") {
        const accounts = config.hubspotAccounts || [];
        if (accounts.length > 0 && !parsed.force) {
          const active = accounts.find((a) => a.portalId === config.activeHubSpotAccount) || accounts[0];
          jsonResponse(res, 200, {
            ok: true,
            alreadyAuthenticated: true,
            portalName: active.portalName,
            portalId: active.portalId,
          });
          return;
        }
      } else {
        const hs = detectHubSpotCLI();
        if (!hs.found) {
          jsonResponse(res, 400, { error: "HubSpot CLI not installed", needsInstall: true });
          return;
        }
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
      }

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

export function handleSettingsGhAuthRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const parsed = JSON.parse(body || "{}");

      const gh = detectGitHubCLI();
      if (!gh.found) {
        jsonResponse(res, 400, { error: "GitHub CLI not installed", needsInstall: true });
        return;
      }

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
        const jobId = startJobSafe(
          "gh", ["auth", "login", "--with-token"],
          "Authenticating with GitHub",
          { timeout: 30_000, stdin: parsed.token }
        );
        jsonResponse(res, 200, { ok: true, jobId });
        return;
      }

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

export function handleSettingsHsSwitchRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { portalId, action } = JSON.parse(body);
      const config = loadConfig();
      const uploadMode = config.hubspotUploadMode || "api";

      if (uploadMode === "api") {
        // API mode: synchronous config updates (no subprocess)
        if (action === "remove" && portalId) {
          removeHubSpotAccount(portalId);
          jsonResponse(res, 200, { ok: true });
          return;
        }
        if (portalId) {
          setActiveHubSpotAccount(portalId);
          jsonResponse(res, 200, { ok: true });
          return;
        }
      } else {
        // CLI mode: use hs accounts commands
        const hs = detectHubSpotCLI();
        if (!hs.found) {
          jsonResponse(res, 400, { error: "HubSpot CLI not installed" });
          return;
        }
        // Validate portalId is numeric to prevent injection
        const safePortalId = String(portalId).replace(/[^0-9]/g, "");
        if (!safePortalId) {
          jsonResponse(res, 400, { error: "Invalid portalId" });
          return;
        }
        if (action === "remove") {
          const jobId = startJobSafe("hs", ["accounts", "remove", safePortalId], `Removing HubSpot account ${safePortalId}`, { timeout: 15_000 });
          jsonResponse(res, 200, { ok: true, jobId });
          return;
        }
        if (safePortalId) {
          const jobId = startJobSafe("hs", ["accounts", "use", safePortalId], `Switching to HubSpot account ${safePortalId}`, { timeout: 15_000 });
          jsonResponse(res, 200, { ok: true, jobId });
          return;
        }
      }

      jsonResponse(res, 400, { error: "portalId required" });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleSettingsGhLogoutRoute(res: ServerResponse): void {
  const jobId = startJob(
    "gh auth logout --hostname github.com -y",
    "Logging out of GitHub",
    { timeout: 15_000 }
  );
  jsonResponse(res, 200, { ok: true, jobId });
}

export function handleSettingsCLIAuthRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { cli, apiKey } = JSON.parse(body || "{}");

      switch (cli) {
        case "claude": {
          const jobId = startJob(
            "CLAUDECODE= claude --print -p 'reply OK'",
            "Authenticating Claude Code (check your browser if prompted)",
            { timeout: 120_000 }
          );
          jsonResponse(res, 200, { ok: true, jobId, hint: "If Claude Code opens a browser window, complete the sign-in there." });
          break;
        }
        case "gemini": {
          const jobId = startJob(
            "gemini -p 'reply OK'",
            "Authenticating Gemini CLI (check your browser if prompted)",
            { timeout: 120_000 }
          );
          jsonResponse(res, 200, { ok: true, jobId, hint: "If Gemini opens a browser window, complete the sign-in there." });
          break;
        }
        case "codex": {
          if (apiKey && apiKey.trim()) {
            const key = apiKey.trim();
            process.env.OPENAI_API_KEY = key;
            saveConfig({ openaiApiKey: key } as any);
            if (process.platform !== "win32") {
              // Sanitize key to prevent shell profile injection — only allow
              // alphanumeric chars, dashes, underscores, and dots (valid API key chars)
              const safeKey = /^[A-Za-z0-9_\-.:]+$/.test(key) ? key : "";
              if (safeKey) {
                const profileLine = `export OPENAI_API_KEY="${safeKey}"`;
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
              }
            }
            jsonResponse(res, 200, { ok: true, message: "API key saved" });
          } else {
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

// ---------------------------------------------------------------------------
// HubSpot upload mode toggle
// ---------------------------------------------------------------------------

export function handleSettingsHsModeRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { mode } = JSON.parse(body);
      if (mode !== "api" && mode !== "cli") {
        jsonResponse(res, 400, { error: `Invalid mode: ${mode}. Must be "api" or "cli".` });
        return;
      }
      saveConfig({ hubspotUploadMode: mode } as any);
      jsonResponse(res, 200, { ok: true, mode });
    } catch (err) {
      jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// CLI tool toggle
// ---------------------------------------------------------------------------

export function handleSettingsCliToggleRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { toolId, enabled } = JSON.parse(body);
      if (!toolId || typeof enabled !== "boolean") {
        jsonResponse(res, 400, { error: "toolId (string) and enabled (boolean) required" });
        return;
      }
      setCliToolEnabled(toolId, enabled);
      jsonResponse(res, 200, { ok: true, toolId, enabled });
    } catch (err) {
      jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Generic settings save (used for agentic mode, etc.)
// ---------------------------------------------------------------------------

export function handleSettingsGenericRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const data = JSON.parse(body);
      const allowedKeys = [
        "agenticMode",
        "agenticConcurrency",
        "planMode",
        "extendedThinking",
        "extendedThinkingBudget",
        "webSearch",
      ];
      // Validate enum
      if (data.extendedThinkingBudget !== undefined &&
          !["low", "medium", "high"].includes(data.extendedThinkingBudget)) {
        jsonResponse(res, 400, { error: "extendedThinkingBudget must be 'low' | 'medium' | 'high'" });
        return;
      }
      const update: Record<string, unknown> = {};

      for (const key of allowedKeys) {
        if (key in data) update[key] = data[key];
      }

      if (Object.keys(update).length === 0) {
        jsonResponse(res, 400, { error: "No valid settings fields provided" });
        return;
      }

      saveConfig(update as import("../../utils/config.js").VibeSpotConfig);
      jsonResponse(res, 200, { ok: true, updated: Object.keys(update) });
    } catch (err) {
      jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Job polling
// ---------------------------------------------------------------------------

export function handleSettingsJobRoute(path: string, res: ServerResponse): void {
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
