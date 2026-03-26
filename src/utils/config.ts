import { join } from "node:path";
import { homedir } from "node:os";
import { chmodSync } from "node:fs";
import { readFile, writeFile, fileExists } from "./fs.js";

export type AIEngineType =
  | "claude-code"
  | "anthropic-api"
  | "claude-oauth"
  | "openai-api"
  | "gemini-cli"
  | "gemini-api"
  | "codex-cli"
  // Legacy value — migrated to "anthropic-api" on load
  | "api";

export interface HubSpotAccountConfig {
  portalId: string;
  portalName: string;
  personalAccessKey: string;
  dataCenter: "na1" | "eu1";
  addedAt: string;
}

export interface VibeSpotConfig {
  aiEngine?: AIEngineType;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  claudeCodeModel?: string;
  anthropicApiModel?: string;
  openaiApiModel?: string;
  lastThemePath?: string;
  lastSourcePath?: string;
  // HubSpot account management
  hubspotAccounts?: HubSpotAccountConfig[];
  activeHubSpotAccount?: string; // portalId
  hubspotUploadMode?: "api" | "cli"; // default "api"
  // CLI tool toggles — only enabled tools get checked on settings load
  enabledCLITools?: string[];
  // Agentic pipeline — multi-stage decomposed AI generation
  agenticMode?: boolean;           // undefined = never prompted, true/false = user choice
  agenticConcurrency?: number;     // max parallel module generation calls (default 3)
}

const CONFIG_DIR = join(homedir(), ".vibespot");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function loadConfig(): VibeSpotConfig {
  if (!fileExists(CONFIG_PATH)) return {};

  try {
    const raw = JSON.parse(readFile(CONFIG_PATH));
    // Migrate legacy "api" engine type
    if (raw.aiEngine === "api") {
      raw.aiEngine = "anthropic-api";
    }
    return raw;
  } catch {
    return {};
  }
}

/**
 * Get the API key for a given engine, checking config first then env vars.
 */
export function getApiKeyForEngine(engine: AIEngineType, config?: VibeSpotConfig): string | undefined {
  const c = config || loadConfig();
  switch (engine) {
    case "anthropic-api":
    case "api":
      return c.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    case "openai-api":
      return c.openaiApiKey || process.env.OPENAI_API_KEY;
    case "gemini-api":
      return c.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    default:
      return undefined;
  }
}

/**
 * Mask an API key for display (show first 7 + last 4 chars).
 */
export function maskApiKey(key: string): string {
  if (key.length <= 12) return "***";
  return key.slice(0, 7) + "..." + key.slice(-4);
}

export function saveConfig(config: VibeSpotConfig): void {
  const existing = loadConfig();
  const merged = { ...existing, ...config };
  writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2));
  // Restrict file permissions — config contains API keys
  if (process.platform !== "win32") {
    try { chmodSync(CONFIG_PATH, 0o600); } catch { /* ignore */ }
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

// ---------------------------------------------------------------------------
// HubSpot account helpers
// ---------------------------------------------------------------------------

export function getActiveHubSpotAccount(): HubSpotAccountConfig | null {
  const config = loadConfig();
  if (!config.hubspotAccounts?.length) return null;
  const activeId = config.activeHubSpotAccount;
  if (activeId) {
    const found = config.hubspotAccounts.find((a) => a.portalId === activeId);
    if (found) return found;
  }
  // Fallback to first account
  return config.hubspotAccounts[0] || null;
}

export function addHubSpotAccount(
  pak: string,
  portalId: string,
  portalName: string,
  dataCenter: "na1" | "eu1",
): void {
  const config = loadConfig();
  const accounts = config.hubspotAccounts || [];

  // Replace if same portalId exists
  const idx = accounts.findIndex((a) => a.portalId === portalId);
  const entry: HubSpotAccountConfig = {
    portalId,
    portalName,
    personalAccessKey: pak,
    dataCenter,
    addedAt: new Date().toISOString(),
  };

  if (idx >= 0) {
    accounts[idx] = entry;
  } else {
    accounts.push(entry);
  }

  saveConfig({
    hubspotAccounts: accounts,
    activeHubSpotAccount: portalId,
  } as VibeSpotConfig);
}

export function removeHubSpotAccount(portalId: string): void {
  const config = loadConfig();
  const accounts = (config.hubspotAccounts || []).filter((a) => a.portalId !== portalId);
  const update: Partial<VibeSpotConfig> = { hubspotAccounts: accounts };

  // If we removed the active account, switch to the first remaining
  if (config.activeHubSpotAccount === portalId) {
    update.activeHubSpotAccount = accounts[0]?.portalId || undefined;
  }

  saveConfig(update as VibeSpotConfig);
}

export function setActiveHubSpotAccount(portalId: string): void {
  saveConfig({ activeHubSpotAccount: portalId } as VibeSpotConfig);
}

export function getHubSpotPak(): string | null {
  const acct = getActiveHubSpotAccount();
  return acct?.personalAccessKey || null;
}

// ---------------------------------------------------------------------------
// CLI tool toggle helpers
// ---------------------------------------------------------------------------

export function isCliToolEnabled(toolId: string): boolean {
  const config = loadConfig();
  return config.enabledCLITools?.includes(toolId) ?? false;
}

export function setCliToolEnabled(toolId: string, enabled: boolean): void {
  const config = loadConfig();
  const tools = new Set(config.enabledCLITools || []);
  if (enabled) tools.add(toolId);
  else tools.delete(toolId);
  saveConfig({ enabledCLITools: [...tools] } as VibeSpotConfig);
}
