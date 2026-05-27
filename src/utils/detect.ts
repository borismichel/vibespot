import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { run } from "./shell.js";
import { loadConfig, maskApiKey, isCliToolEnabled, getActiveHubSpotAccount, type AIEngineType, type HubSpotAccountConfig, type VibeSpotConfig } from "./config.js";
import { detectDataCenterFromPak } from "../hubspot/api.js";
import { hasValidOAuthToken, getOAuthTokenInfo } from "./claude-oauth.js";

const whichCmd = process.platform === "win32" ? "where" : "which";

// `gh auth status` and `hs accounts list` validate credentials over the network.
// run()'s default 120s ceiling is far past the settings panel's load budget, so
// cap these credential probes aggressively — a timeout is treated like any other
// failure (not authenticated), which is the safe degradation here (VIB-1834).
// These probes only ever run from the on-demand `/api/settings/tools` scan, never
// from `/api/settings/status` (which is config-only and side-effect-free).
const AUTH_PROBE_TIMEOUT_MS = 4000;

export interface ToolInfo {
  name: string;
  found: boolean;
  version: string;
  path: string;
}

export function detectNode(): ToolInfo {
  const result = run("node --version");
  return {
    name: "Node.js",
    found: result.success,
    version: result.stdout.replace(/^v/, ""),
    path: run(`${whichCmd} node`).stdout,
  };
}

export function detectGit(): ToolInfo {
  const result = run("git --version");
  return {
    name: "Git",
    found: result.success,
    version: result.stdout.replace("git version ", ""),
    path: run(`${whichCmd} git`).stdout,
  };
}

export function detectHubSpotCLI(): ToolInfo {
  const result = run("hs --version");
  return {
    name: "HubSpot CLI",
    found: result.success,
    version: result.stdout,
    path: run(`${whichCmd} hs`).stdout,
  };
}

export interface CLIToolInfo extends ToolInfo {
  authenticated: boolean;
  authDetail: string;
}

export function detectClaudeCode(): CLIToolInfo {
  const result = run("claude --version");
  if (!result.success) {
    return { name: "Claude Code", found: false, version: "", path: "", authenticated: false, authDetail: "Not installed" };
  }

  // Check for Claude Code auth by looking for credentials
  // Claude Code stores OAuth tokens in ~/.claude/ — if the dir exists with credentials, it's authenticated
  const claudeDir = join(homedir(), ".claude");
  let authenticated = false;
  let authDetail = "Not signed in — run `claude` to authenticate";

  try {
    if (existsSync(claudeDir)) {
      // If .claude dir exists with auth files, consider it authenticated
      const files = readdirSync(claudeDir);
      const hasAuth = files.some(f =>
        f.includes("credentials") || f.includes("auth") || f.includes("token") || f === ".credentials.json"
      );
      if (hasAuth || files.length > 2) {
        // Has some config — likely authenticated
        authenticated = true;
        authDetail = "Authenticated";
      }
    }
  } catch { /* ignore */ }

  return {
    name: "Claude Code",
    found: true,
    version: result.stdout,
    path: run(`${whichCmd} claude`).stdout,
    authenticated,
    authDetail,
  };
}

export function detectDataCenter(portalId: string): string {
  try {
    const configPath = join(homedir(), ".hscli", "config.yml");
    if (!existsSync(configPath)) return "na1";

    const config = readFileSync(configPath, "utf-8");

    // Find the account block matching this portal ID
    const accountIdx = config.indexOf(`accountId: ${portalId}`);
    if (accountIdx === -1) return "na1";

    // Look for personalAccessKey after this account entry
    const keyIdx = config.indexOf("personalAccessKey:", accountIdx);
    if (keyIdx === -1) return "na1";

    // Extract the key value (next non-empty trimmed line after the label)
    const keySection = config.slice(keyIdx, keyIdx + 300);
    const keyMatch = keySection.match(/personalAccessKey:[\s>-]*\n\s+(\S+)/);
    if (!keyMatch) return "na1";

    // CiRldTE = base64 prefix for "eu1" datacenter in HubSpot personal access keys
    if (keyMatch[1].startsWith("CiRldTE")) return "eu1";
  } catch {
    // Fall through to default
  }
  return "na1";
}

export interface HubSpotAccount {
  name: string;
  portalId: string;
  authType: string;
  isDefault: boolean;
}

export function detectHubSpotAuth(): {
  authenticated: boolean;
  portalName: string;
  portalId: string;
  accounts: HubSpotAccount[];
} {
  const result = run("hs accounts list", { timeout: AUTH_PROBE_TIMEOUT_MS });
  if (!result.success || !result.stdout) {
    return { authenticated: false, portalName: "", portalId: "", accounts: [] };
  }

  // Parse all accounts from the table
  const accounts: HubSpotAccount[] = [];
  let defaultName = "";
  let defaultId = "";

  // Default account line: "Account: name [standard] (123456)"
  const defaultMatch = result.stdout.match(/Account:\s*(.+?)\s*\((\d+)\)/);
  if (defaultMatch) {
    defaultName = defaultMatch[1].trim();
    defaultId = defaultMatch[2].trim();
  }

  // Parse table rows: "name [standard]  123456  personalaccesskey"
  const lines = result.stdout.split("\n");
  for (const line of lines) {
    const tableMatch = line.match(/^\s*(.+?)\s+(\d{5,})\s+(.*)/);
    if (tableMatch && !/Account ID/i.test(line) && !/^-+$/.test(line.trim()) && !/^Name\s/i.test(line.trim())) {
      const name = tableMatch[1].trim();
      const portalId = tableMatch[2].trim();
      const authType = tableMatch[3]?.trim() || "unknown";
      accounts.push({
        name,
        portalId,
        authType,
        isDefault: portalId === defaultId,
      });
    }
  }

  if (defaultMatch) {
    return {
      authenticated: true,
      portalName: defaultName,
      portalId: defaultId,
      accounts,
    };
  }

  // Fallback: at least one account in table
  if (accounts.length > 0) {
    return {
      authenticated: true,
      portalName: accounts[0].name,
      portalId: accounts[0].portalId,
      accounts,
    };
  }

  return {
    authenticated: result.stdout.length > 0,
    portalName: "",
    portalId: "",
    accounts: [],
  };
}

export function detectGeminiCLI(): CLIToolInfo {
  const result = run("gemini --version");
  if (!result.success) {
    return { name: "Gemini CLI", found: false, version: "", path: "", authenticated: false, authDetail: "Not installed" };
  }

  // Gemini CLI uses Google Cloud auth — check for application default credentials
  const adcPath = join(homedir(), ".config", "gcloud", "application_default_credentials.json");
  const hasAdc = existsSync(adcPath);
  // Also check GOOGLE_API_KEY / GEMINI_API_KEY env vars
  const hasEnvKey = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY);
  const authenticated = hasAdc || hasEnvKey;

  return {
    name: "Gemini CLI",
    found: true,
    version: result.stdout,
    path: run(`${whichCmd} gemini`).stdout,
    authenticated,
    authDetail: authenticated ? "Authenticated" : "Run `gemini` to sign in with Google",
  };
}

export function detectCodexCLI(): CLIToolInfo {
  const result = run("codex --version");
  if (!result.success) {
    return { name: "OpenAI Codex CLI", found: false, version: "", path: "", authenticated: false, authDetail: "Not installed" };
  }

  // Codex CLI supports OAuth (stored in ~/.codex/auth.json) or OPENAI_API_KEY
  const hasKey = !!(process.env.OPENAI_API_KEY);
  let hasOAuth = false;
  try {
    const authFile = join(homedir(), ".codex", "auth.json");
    if (existsSync(authFile)) {
      const content = readFileSync(authFile, "utf-8");
      hasOAuth = content.length > 10; // non-empty auth file
    }
  } catch { /* ignore */ }

  const authenticated = hasKey || hasOAuth;
  const detail = hasOAuth ? "Authenticated (OAuth)" : hasKey ? "Authenticated (API key)" : "Not authenticated";
  return {
    name: "OpenAI Codex CLI",
    found: true,
    version: result.stdout,
    path: run(`${whichCmd} codex`).stdout,
    authenticated,
    authDetail: detail,
  };
}

export function detectGitHubCLI(): ToolInfo {
  const result = run("gh --version");
  return {
    name: "GitHub CLI",
    found: result.success,
    version: result.stdout.split("\n")[0]?.replace("gh version ", "").split(" ")[0] || "",
    path: run(`${whichCmd} gh`).stdout,
  };
}

export function detectGitHubAuth(): { authenticated: boolean; username: string } {
  const result = run("gh auth status 2>&1", { timeout: AUTH_PROBE_TIMEOUT_MS });
  if (!result.success && !result.stdout) {
    return { authenticated: false, username: "" };
  }
  // gh auth status outputs to stderr, but our run() captures both
  const output = result.stdout || result.stderr || "";
  const match = output.match(/Logged in to github\.com.*account\s+(\S+)/);
  if (match) {
    return { authenticated: true, username: match[1] };
  }
  // Alternate pattern: "account borismichel"
  const altMatch = output.match(/account\s+(\S+)/);
  if (altMatch && output.includes("Logged in")) {
    return { authenticated: true, username: altMatch[1] };
  }
  return { authenticated: output.includes("Logged in"), username: "" };
}

export function hasAnthropicKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export function nodeVersionOk(version: string): boolean {
  const major = parseInt(version.split(".")[0], 10);
  return major >= 18;
}

export function hsCliVersionOk(version: string): boolean {
  const major = parseInt(version.split(".")[0], 10);
  return !isNaN(major) && major >= 8;
}

// ---------------------------------------------------------------------------
// Comprehensive environment status (used by GET /api/settings/status)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config-based HubSpot auth (for API mode — no CLI subprocess)
// ---------------------------------------------------------------------------

export function detectHubSpotAuthFromConfig(): {
  authenticated: boolean;
  portalName: string;
  portalId: string;
  dataCenter: string;
  accounts: HubSpotAccount[];
  uploadMode: "api" | "cli";
} {
  const config = loadConfig();
  const uploadMode = config.hubspotUploadMode || "api";
  const configAccounts = config.hubspotAccounts || [];

  const accounts: HubSpotAccount[] = configAccounts.map((a) => ({
    name: a.portalName,
    portalId: a.portalId,
    authType: "personalaccesskey",
    isDefault: a.portalId === (config.activeHubSpotAccount || configAccounts[0]?.portalId),
  }));

  const active = getActiveHubSpotAccount();

  return {
    authenticated: !!active,
    portalName: active?.portalName || "",
    portalId: active?.portalId || "",
    dataCenter: active ? active.dataCenter : "na1",
    accounts,
    uploadMode,
  };
}

// ---------------------------------------------------------------------------
// Comprehensive environment status (used by GET /api/settings/status)
// ---------------------------------------------------------------------------

export interface EnvironmentStatus {
  tools: {
    node: ToolInfo;
    git: ToolInfo;
    hubspot: ToolInfo & { authenticated: boolean; portalName: string; portalId: string; dataCenter: string; accounts: HubSpotAccount[]; uploadMode: "api" | "cli" };
    github: ToolInfo & { authenticated: boolean; username: string };
    claudeCode: CLIToolInfo;
    claudeOAuth: { authenticated: boolean; expiresAt?: string };
    geminiCli: CLIToolInfo;
    codexCli: CLIToolInfo;
  };
  apiKeys: {
    anthropic: { configured: boolean; masked: string; source: "config" | "env" | null };
    openai: { configured: boolean; masked: string; source: "config" | "env" | null };
    gemini: { configured: boolean; masked: string; source: "config" | "env" | null };
    langdock: { configured: boolean; masked: string; source: "config" | "env" | null };
    langfusePublic: { configured: boolean; masked: string; source: "config" | "env" | null };
    langfuseSecret: { configured: boolean; masked: string; source: "config" | "env" | null };
  };
  activeEngine: AIEngineType | null;
  availableEngines: AIEngineType[];
  enabledCLITools: string[];
  // false when produced by the config-only `detectEnvironmentLite()` (no
  // subprocess detection has run yet); true after a full/grouped scan. The
  // settings UI uses this to render tool/auth cards as "not scanned" until the
  // user (or the one-time background scan) triggers `/api/settings/tools`.
  scanned: boolean;
}

const DISABLED_CLI: CLIToolInfo = { name: "", found: false, version: "", path: "", authenticated: false, authDetail: "Disabled" };

type ApiKeyStatus = { configured: boolean; masked: string; source: "config" | "env" | null };

function keyStatus(configKey: string | undefined, ...envVars: string[]): ApiKeyStatus {
  if (configKey) return { configured: true, masked: maskApiKey(configKey), source: "config" };
  for (const v of envVars) {
    if (process.env[v]) return { configured: true, masked: maskApiKey(process.env[v]!), source: "env" };
  }
  return { configured: false, masked: "", source: null };
}

// API-key status is derived purely from config + env vars — no subprocess, no
// network — so it is safe to compute on the fast `/status` path.
function detectApiKeys(config: VibeSpotConfig): EnvironmentStatus["apiKeys"] {
  return {
    anthropic: keyStatus(config.anthropicApiKey, "ANTHROPIC_API_KEY"),
    openai: keyStatus(config.openaiApiKey, "OPENAI_API_KEY"),
    gemini: keyStatus(config.geminiApiKey, "GEMINI_API_KEY", "GOOGLE_AI_API_KEY"),
    langdock: keyStatus(config.langdockApiKey, "LANGDOCK_API_KEY"),
    langfusePublic: keyStatus(config.langfusePublicKey, "LANGFUSE_PUBLIC_KEY"),
    langfuseSecret: keyStatus(config.langfuseSecretKey, "LANGFUSE_SECRET_KEY"),
  };
}

// Engine availability. API engines depend only on key presence (cheap); the
// three CLI engines depend on the tool being usable — which means
// `found && authenticated` after a scan, or (optimistically) just "enabled" on
// the config-only path before any scan has run. Ordering matches the engine
// selector in the settings UI.
function computeAvailableEngines(opts: {
  apiKeys: EnvironmentStatus["apiKeys"];
  claudeOAuth: boolean;
  claudeCode: boolean;
  geminiCli: boolean;
  codexCli: boolean;
}): AIEngineType[] {
  const a: AIEngineType[] = [];
  if (opts.claudeCode) a.push("claude-code");
  if (opts.claudeOAuth) a.push("claude-oauth");
  if (opts.apiKeys.anthropic.configured) a.push("anthropic-api");
  if (opts.apiKeys.openai.configured) a.push("openai-api");
  if (opts.geminiCli) a.push("gemini-cli");
  if (opts.apiKeys.gemini.configured) a.push("gemini-api");
  if (opts.codexCli) a.push("codex-cli");
  if (opts.apiKeys.langdock.configured) a.push("langdock-api");
  return a;
}

// HubSpot tool info. API mode is config-derived (no subprocess) so it is always
// safe; CLI mode shells out and so only runs on a scan.
function detectHubSpotTool(
  uploadMode: "api" | "cli",
  scan: boolean,
): ToolInfo & { authenticated: boolean; portalName: string; portalId: string; dataCenter: string; accounts: HubSpotAccount[]; uploadMode: "api" | "cli" } {
  if (uploadMode === "cli") {
    if (!scan) {
      return { name: "HubSpot CLI", found: false, version: "", path: "", authenticated: false, portalName: "", portalId: "", dataCenter: "na1", accounts: [], uploadMode: "cli" };
    }
    const hs = detectHubSpotCLI();
    const hsAuth = hs.found ? detectHubSpotAuth() : { authenticated: false, portalName: "", portalId: "", accounts: [] as HubSpotAccount[] };
    const dc = hsAuth.portalId ? detectDataCenter(hsAuth.portalId) : "na1";
    return { ...hs, ...hsAuth, dataCenter: dc, uploadMode: "cli" };
  }
  // API mode — read from vibespot config, no subprocess.
  return {
    name: "HubSpot API",
    found: true, // always available (built-in)
    version: "v3",
    path: "",
    ...detectHubSpotAuthFromConfig(),
  };
}

// Config-only, side-effect-free environment status for the fast settings
// `/status` path: no subprocesses, no network. Tool/auth state for the AI CLIs
// and the GitHub/HubSpot-CLI probes is left "not scanned" (placeholders); only
// the cheap config/env reads (API keys, Claude OAuth token file, HubSpot API
// accounts) are populated. Engine availability is optimistic — enabled CLI
// engines are listed without verifying install — and is refined by a later
// `/api/settings/tools` scan (VIB-1834).
export function detectEnvironmentLite(): EnvironmentStatus {
  const config = loadConfig();
  const uploadMode = config.hubspotUploadMode || "api";
  const apiKeys = detectApiKeys(config);

  const claudeOAuth = {
    authenticated: hasValidOAuthToken(),
    expiresAt: getOAuthTokenInfo()?.expiresAt,
  };

  const notScannedCli = (name: string): CLIToolInfo => ({ name, found: false, version: "", path: "", authenticated: false, authDetail: "Not scanned" });
  const notScannedTool = (name: string): ToolInfo => ({ name, found: false, version: "", path: "" });

  return {
    tools: {
      node: notScannedTool("Node.js"),
      git: notScannedTool("Git"),
      hubspot: detectHubSpotTool(uploadMode, false),
      github: { ...notScannedTool("GitHub CLI"), authenticated: false, username: "" },
      claudeCode: notScannedCli("Claude Code"),
      claudeOAuth,
      geminiCli: notScannedCli("Gemini CLI"),
      codexCli: notScannedCli("OpenAI Codex CLI"),
    },
    apiKeys,
    activeEngine: config.aiEngine || null,
    availableEngines: computeAvailableEngines({
      apiKeys,
      claudeOAuth: claudeOAuth.authenticated,
      claudeCode: isCliToolEnabled("claude-code"),
      geminiCli: isCliToolEnabled("gemini-cli"),
      codexCli: isCliToolEnabled("codex-cli"),
    }),
    enabledCLITools: config.enabledCLITools || [],
    scanned: false,
  };
}

// Subprocess scan of just the AI CLI tools (Claude Code / Gemini / Codex) plus
// the cheap Claude OAuth check. Because engine availability depends only on API
// keys + OAuth + these three CLIs, this also returns an accurate
// `availableEngines` to replace the optimistic one from `/status`.
export function detectAITools(): {
  claudeCode: CLIToolInfo;
  geminiCli: CLIToolInfo;
  codexCli: CLIToolInfo;
  claudeOAuth: { authenticated: boolean; expiresAt?: string };
  availableEngines: AIEngineType[];
} {
  const config = loadConfig();
  const apiKeys = detectApiKeys(config);
  const claudeOAuth = {
    authenticated: hasValidOAuthToken(),
    expiresAt: getOAuthTokenInfo()?.expiresAt,
  };
  const claude = isCliToolEnabled("claude-code") ? detectClaudeCode() : { ...DISABLED_CLI, name: "Claude Code" };
  const gemini = isCliToolEnabled("gemini-cli") ? detectGeminiCLI() : { ...DISABLED_CLI, name: "Gemini CLI" };
  const codex = isCliToolEnabled("codex-cli") ? detectCodexCLI() : { ...DISABLED_CLI, name: "OpenAI Codex CLI" };
  return {
    claudeCode: claude,
    geminiCli: gemini,
    codexCli: codex,
    claudeOAuth,
    availableEngines: computeAvailableEngines({
      apiKeys,
      claudeOAuth: claudeOAuth.authenticated,
      claudeCode: claude.found && claude.authenticated,
      geminiCli: gemini.found && gemini.authenticated,
      codexCli: codex.found && codex.authenticated,
    }),
  };
}

// Subprocess scan of the platform tools (GitHub CLI + auth, HubSpot CLI + auth
// when in CLI mode). These never affect engine availability.
export function detectPlatformTools(): {
  github: ToolInfo & { authenticated: boolean; username: string };
  hubspot: ToolInfo & { authenticated: boolean; portalName: string; portalId: string; dataCenter: string; accounts: HubSpotAccount[]; uploadMode: "api" | "cli" };
} {
  const config = loadConfig();
  const uploadMode = config.hubspotUploadMode || "api";
  const gh = detectGitHubCLI();
  const ghAuth = gh.found ? detectGitHubAuth() : { authenticated: false, username: "" };
  return {
    github: { ...gh, ...ghAuth },
    hubspot: detectHubSpotTool(uploadMode, true),
  };
}

export function detectEnvironment(): EnvironmentStatus {
  const config = loadConfig();
  const uploadMode = config.hubspotUploadMode || "api";

  const node = detectNode();
  const git = detectGit();
  const hsInfo = detectHubSpotTool(uploadMode, true);

  // GitHub CLI — always checked (lightweight)
  const gh = detectGitHubCLI();
  const ghAuth = gh.found ? detectGitHubAuth() : { authenticated: false, username: "" };

  // Claude OAuth token check
  const claudeOAuth = {
    authenticated: hasValidOAuthToken(),
    expiresAt: getOAuthTokenInfo()?.expiresAt,
  };

  // AI CLI tools — only check if enabled in config (lazy loading)
  const claude = isCliToolEnabled("claude-code") ? detectClaudeCode() : { ...DISABLED_CLI, name: "Claude Code" };
  const gemini = isCliToolEnabled("gemini-cli") ? detectGeminiCLI() : { ...DISABLED_CLI, name: "Gemini CLI" };
  const codex = isCliToolEnabled("codex-cli") ? detectCodexCLI() : { ...DISABLED_CLI, name: "OpenAI Codex CLI" };

  const apiKeys = detectApiKeys(config);

  return {
    tools: {
      node,
      git,
      hubspot: hsInfo,
      github: { ...gh, ...ghAuth },
      claudeCode: claude,
      claudeOAuth,
      geminiCli: gemini,
      codexCli: codex,
    },
    apiKeys,
    activeEngine: config.aiEngine || null,
    availableEngines: computeAvailableEngines({
      apiKeys,
      claudeOAuth: claudeOAuth.authenticated,
      claudeCode: claude.found && claude.authenticated,
      geminiCli: gemini.found && gemini.authenticated,
      codexCli: codex.found && codex.authenticated,
    }),
    enabledCLITools: config.enabledCLITools || [],
    scanned: true,
  };
}
