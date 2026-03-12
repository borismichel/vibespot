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
import { startJob, getJob } from "../process-manager.js";

// ---------------------------------------------------------------------------
// Live model catalog — fetched from provider APIs, cached 10 minutes
// ---------------------------------------------------------------------------

type ModelEntry = { id: string; label: string };
const modelCache: { data: Record<string, ModelEntry[]>; ts: number } = { data: {}, ts: 0 };
const MODEL_CACHE_TTL = 10 * 60 * 1000;

const STATIC_MODELS: Record<string, ModelEntry[]> = {
  "claude-code": [
    { id: "sonnet", label: "Claude Sonnet (default)" },
    { id: "opus", label: "Claude Opus" },
    { id: "haiku", label: "Claude Haiku" },
  ],
  "codex-cli": [
    { id: "o4-mini", label: "o4 Mini (default)" },
    { id: "o3", label: "o3" },
    { id: "gpt-4o", label: "GPT-4o" },
  ],
};

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

async function fetchOpenAIModels(apiKey: string): Promise<ModelEntry[]> {
  const resp = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json() as { data: { id: string }[] };
  const keep = /^(gpt-4o|gpt-4o-mini|o[1-4](-mini)?|o[1-4]-pro)$/;
  return data.data
    .filter((m) => keep.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({ id: m.id, label: m.id }));
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
        .then((models) => { if (models.length) catalog["anthropic-api"] = models; })
        .catch(() => {}),
    );
  }

  const openaiKey = getApiKeyForEngine("openai-api", config);
  if (openaiKey) {
    jobs.push(
      fetchOpenAIModels(openaiKey)
        .then((models) => { if (models.length) catalog["openai-api"] = models; })
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
    hubspotUploadMode: config.hubspotUploadMode || "api",
    hubspotAccounts: (config.hubspotAccounts || []).map((a: HubSpotAccountConfig) => ({
      portalId: a.portalId,
      portalName: a.portalName,
      dataCenter: a.dataCenter,
    })),
    activeHubSpotAccount: config.activeHubSpotAccount || null,
    enabledCLITools: config.enabledCLITools || [],
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
          const jobId = startJob(
            `hs auth --pak="${parsed.personalAccessKey}"`,
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
        const jobId = startJob(
          `echo "${parsed.token}" | gh auth login --with-token`,
          "Authenticating with GitHub",
          { timeout: 30_000 }
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
        if (action === "remove" && portalId) {
          const jobId = startJob(`hs accounts remove ${portalId}`, `Removing HubSpot account ${portalId}`, { timeout: 15_000 });
          jsonResponse(res, 200, { ok: true, jobId });
          return;
        }
        if (portalId) {
          const jobId = startJob(`hs accounts use ${portalId}`, `Switching to HubSpot account ${portalId}`, { timeout: 15_000 });
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
