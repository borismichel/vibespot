import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { run } from "./shell.js";
import { loadConfig, maskApiKey, isCliToolEnabled, getActiveHubSpotAccount, type AIEngineType, type HubSpotAccountConfig } from "./config.js";
import { detectDataCenterFromPak } from "../hubspot/api.js";
import { hasValidOAuthToken, getOAuthTokenInfo } from "./claude-oauth.js";

const whichCmd = process.platform === "win32" ? "where" : "which";

// `gh auth status` and `hs accounts list` validate credentials over the network.
// run()'s default 120s ceiling is far past the settings panel's load budget, so
// cap these credential probes aggressively — a timeout is treated like any other
// failure (not authenticated), which is the safe degradation here (VIB-1834).
const AUTH_PROBE_TIMEOUT_MS = 3000;

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
}

const DISABLED_CLI: CLIToolInfo = { name: "", found: false, version: "", path: "", authenticated: false, authDetail: "Disabled" };

export function detectEnvironment(): EnvironmentStatus {
  const config = loadConfig();

  const node = detectNode();
  const git = detectGit();

  // HubSpot: API mode uses config, CLI mode uses hs CLI
  const hsUploadMode = config.hubspotUploadMode || "api";
  let hsInfo: ToolInfo & { authenticated: boolean; portalName: string; portalId: string; dataCenter: string; accounts: HubSpotAccount[]; uploadMode: "api" | "cli" };

  if (hsUploadMode === "cli") {
    const hs = detectHubSpotCLI();
    const hsAuth = hs.found ? detectHubSpotAuth() : { authenticated: false, portalName: "", portalId: "", accounts: [] as HubSpotAccount[] };
    const dc = hsAuth.portalId ? detectDataCenter(hsAuth.portalId) : "na1";
    hsInfo = { ...hs, ...hsAuth, dataCenter: dc, uploadMode: "cli" };
  } else {
    // API mode — read from vibespot config, no subprocess
    const apiAuth = detectHubSpotAuthFromConfig();
    hsInfo = {
      name: "HubSpot API",
      found: true, // always available (built-in)
      version: "v3",
      path: "",
      ...apiAuth,
    };
  }

  // GitHub CLI — always checked (lightweight)
  const gh = detectGitHubCLI();
  const ghAuth = gh.found ? detectGitHubAuth() : { authenticated: false, username: "" };

  // Claude OAuth token check
  const claudeOAuth = {
    authenticated: hasValidOAuthToken(),
    expiresAt: getOAuthTokenInfo()?.expiresAt,
  };

  // AI CLI tools — only check if enabled in config (lazy loading)
  const enabledTools = config.enabledCLITools || [];
  const claude = isCliToolEnabled("claude-code") ? detectClaudeCode() : { ...DISABLED_CLI, name: "Claude Code" };
  const gemini = isCliToolEnabled("gemini-cli") ? detectGeminiCLI() : { ...DISABLED_CLI, name: "Gemini CLI" };
  const codex = isCliToolEnabled("codex-cli") ? detectCodexCLI() : { ...DISABLED_CLI, name: "OpenAI Codex CLI" };

  // Determine API key status
  function keyStatus(configKey: string | undefined, ...envVars: string[]): { configured: boolean; masked: string; source: "config" | "env" | null } {
    if (configKey) return { configured: true, masked: maskApiKey(configKey), source: "config" };
    for (const v of envVars) {
      if (process.env[v]) return { configured: true, masked: maskApiKey(process.env[v]!), source: "env" };
    }
    return { configured: false, masked: "", source: null };
  }

  const anthropicKey = keyStatus(config.anthropicApiKey, "ANTHROPIC_API_KEY");
  const openaiKey = keyStatus(config.openaiApiKey, "OPENAI_API_KEY");
  const geminiKey = keyStatus(config.geminiApiKey, "GEMINI_API_KEY", "GOOGLE_AI_API_KEY");
  const langdockKey = keyStatus(config.langdockApiKey, "LANGDOCK_API_KEY");
  const langfusePublic = keyStatus(config.langfusePublicKey, "LANGFUSE_PUBLIC_KEY");
  const langfuseSecret = keyStatus(config.langfuseSecretKey, "LANGFUSE_SECRET_KEY");

  // Build available engines — CLI tools must be enabled + authenticated
  const available: AIEngineType[] = [];
  if (claude.found && claude.authenticated) available.push("claude-code");
  if (claudeOAuth.authenticated) available.push("claude-oauth");
  if (anthropicKey.configured) available.push("anthropic-api");
  if (openaiKey.configured) available.push("openai-api");
  if (gemini.found && gemini.authenticated) available.push("gemini-cli");
  if (geminiKey.configured) available.push("gemini-api");
  if (codex.found && codex.authenticated) available.push("codex-cli");
  if (langdockKey.configured) available.push("langdock-api");

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
    apiKeys: {
      anthropic: anthropicKey,
      openai: openaiKey,
      gemini: geminiKey,
      langdock: langdockKey,
      langfusePublic,
      langfuseSecret,
    },
    activeEngine: config.aiEngine || null,
    availableEngines: available,
    enabledCLITools: enabledTools,
  };
}
