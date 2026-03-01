import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, fileExists } from "./fs.js";

export type AIEngineType =
  | "claude-code"
  | "anthropic-api"
  | "openai-api"
  | "gemini-cli"
  | "gemini-api"
  | "codex-cli"
  // Legacy value — migrated to "anthropic-api" on load
  | "api";

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
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
