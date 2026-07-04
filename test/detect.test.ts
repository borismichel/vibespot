/**
 * Behavioral coverage for src/utils/detect.ts (VIB-1913).
 *
 * Focus: data-center detection from ~/.hscli/config.yml, the HubSpot/GitHub/
 * AI-CLI auth probes, and the three environment-status entry points
 * (detectEnvironmentLite / detectAITools / detectPlatformTools /
 * detectEnvironment) that feed the settings panel.
 *
 * Strategy: mock `../src/utils/shell.js` so no subprocess ever runs, mock
 * config/claude-oauth, and point `homedir()` at an isolated temp dir so the
 * real fs-based probes (hscli config, ~/.claude, ~/.codex, gcloud ADC) are
 * exercised against controlled files. No real network, no real home dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Mutable mock state (hoisted so the vi.mock factories can reference it)
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  home: "/nonexistent-home",
  config: {} as Record<string, unknown>,
  activeAccount: null as null | { portalId: string; portalName: string; dataCenter: string },
  enabledCliTools: new Set<string>(),
  oauthValid: false,
  oauthInfo: null as null | { expiresAt: string },
  // command → result; anything not listed fails like a missing binary
  runResults: new Map<string, { stdout: string; stderr: string; success: boolean }>(),
  runCalls: [] as Array<{ command: string; options: Record<string, unknown> | undefined }>,
}));

vi.mock("../src/utils/shell.js", () => ({
  run: (command: string, options?: Record<string, unknown>) => {
    state.runCalls.push({ command, options });
    return state.runResults.get(command) ?? { stdout: "", stderr: "command not found", success: false };
  },
}));

vi.mock("../src/utils/config.js", () => ({
  loadConfig: () => ({ ...state.config }),
  maskApiKey: (key: string) => `masked:${key.slice(0, 3)}`,
  isCliToolEnabled: (tool: string) => state.enabledCliTools.has(tool),
  getActiveHubSpotAccount: () => state.activeAccount,
}));

vi.mock("../src/utils/claude-oauth.js", () => ({
  hasValidOAuthToken: () => state.oauthValid,
  getOAuthTokenInfo: () => state.oauthInfo,
}));

vi.mock("../src/hubspot/api.js", () => ({
  detectDataCenterFromPak: vi.fn(() => "na1"),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => state.home };
});

import {
  detectNode,
  detectGit,
  detectHubSpotCLI,
  detectGitHubCLI,
  detectClaudeCode,
  detectGeminiCLI,
  detectCodexCLI,
  detectDataCenter,
  detectHubSpotAuth,
  detectGitHubAuth,
  detectHubSpotAuthFromConfig,
  detectEnvironmentLite,
  detectAITools,
  detectPlatformTools,
  detectEnvironment,
  hasAnthropicKey,
  nodeVersionOk,
  hsCliVersionOk,
} from "../src/utils/detect.js";

// ---------------------------------------------------------------------------
// Env + temp-home isolation
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_AI_API_KEY",
  "LANGDOCK_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  state.home = mkdtempSync(join(tmpdir(), "vibespot-detect-"));
  state.config = {};
  state.activeAccount = null;
  state.enabledCliTools = new Set();
  state.oauthValid = false;
  state.oauthInfo = null;
  state.runResults = new Map();
  state.runCalls = [];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(state.home, { recursive: true, force: true });
});

function setRun(command: string, stdout: string, success = true) {
  state.runResults.set(command, { stdout, stderr: "", success });
}

// ---------------------------------------------------------------------------
// Basic tool probes
// ---------------------------------------------------------------------------

describe("basic tool detection", () => {
  it("detectNode strips the leading v from the version", () => {
    setRun("node --version", "v20.11.1");
    setRun("which node", "/usr/bin/node");
    expect(detectNode()).toEqual({ name: "Node.js", found: true, version: "20.11.1", path: "/usr/bin/node" });
  });

  it("detectNode reports not-found when the binary is missing", () => {
    const info = detectNode();
    expect(info.found).toBe(false);
    expect(info.path).toBe("");
  });

  it("detectGit strips the 'git version ' prefix", () => {
    setRun("git --version", "git version 2.43.0");
    setRun("which git", "/usr/bin/git");
    expect(detectGit().version).toBe("2.43.0");
    expect(detectGit().found).toBe(true);
  });

  it("detectHubSpotCLI passes the raw version through", () => {
    setRun("hs --version", "7.6.0");
    expect(detectHubSpotCLI()).toMatchObject({ name: "HubSpot CLI", found: true, version: "7.6.0" });
  });

  it("detectGitHubCLI extracts the bare version from the banner line", () => {
    setRun("gh --version", "gh version 2.40.1 (2023-12-13)\nhttps://github.com/cli/cli/releases/tag/v2.40.1");
    expect(detectGitHubCLI().version).toBe("2.40.1");
  });

  it("detectGitHubCLI tolerates missing output", () => {
    state.runResults.set("gh --version", { stdout: "", stderr: "", success: false });
    expect(detectGitHubCLI()).toMatchObject({ found: false, version: "" });
  });
});

describe("version guards", () => {
  it("nodeVersionOk requires major >= 18", () => {
    expect(nodeVersionOk("18.19.0")).toBe(true);
    expect(nodeVersionOk("20.0.0")).toBe(true);
    expect(nodeVersionOk("16.20.2")).toBe(false);
  });

  it("hsCliVersionOk requires a numeric major >= 8", () => {
    expect(hsCliVersionOk("8.1.0")).toBe(true);
    expect(hsCliVersionOk("7.9.9")).toBe(false);
    expect(hsCliVersionOk("not-a-version")).toBe(false);
  });

  it("hasAnthropicKey reflects the env var", () => {
    expect(hasAnthropicKey()).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(hasAnthropicKey()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Data-center detection from ~/.hscli/config.yml
// ---------------------------------------------------------------------------

function writeHscliConfig(yaml: string) {
  mkdirSync(join(state.home, ".hscli"), { recursive: true });
  writeFileSync(join(state.home, ".hscli", "config.yml"), yaml);
}

describe("detectDataCenter", () => {
  it("defaults to na1 when no hscli config exists", () => {
    expect(detectDataCenter("123456")).toBe("na1");
  });

  it("returns eu1 for a personal access key with the eu1 base64 prefix", () => {
    writeHscliConfig(
      [
        "portals:",
        "  - name: prod-eu",
        "    accountId: 123456",
        "    personalAccessKey: >-",
        "      CiRldTEtZmFrZS1rZXktZm9yLXRlc3Rz",
      ].join("\n"),
    );
    expect(detectDataCenter("123456")).toBe("eu1");
  });

  it("returns na1 for a non-eu key prefix", () => {
    writeHscliConfig(
      [
        "portals:",
        "  - name: prod-us",
        "    accountId: 123456",
        "    personalAccessKey: >-",
        "      CiRuYTEtZmFrZS1rZXktZm9yLXRlc3Rz",
      ].join("\n"),
    );
    expect(detectDataCenter("123456")).toBe("na1");
  });

  it("returns na1 when the portal id is not in the config", () => {
    writeHscliConfig(
      [
        "portals:",
        "  - name: prod-eu",
        "    accountId: 999999",
        "    personalAccessKey: >-",
        "      CiRldTEtZmFrZS1rZXktZm9yLXRlc3Rz",
      ].join("\n"),
    );
    expect(detectDataCenter("123456")).toBe("na1");
  });

  it("matches the key of the requested account, not an earlier one", () => {
    writeHscliConfig(
      [
        "portals:",
        "  - name: us-portal",
        "    accountId: 111111",
        "    personalAccessKey: >-",
        "      CiRuYTEtdXMta2V5",
        "  - name: eu-portal",
        "    accountId: 222222",
        "    personalAccessKey: >-",
        "      CiRldTEtZXUta2V5",
      ].join("\n"),
    );
    expect(detectDataCenter("222222")).toBe("eu1");
    expect(detectDataCenter("111111")).toBe("na1");
  });
});

// ---------------------------------------------------------------------------
// HubSpot CLI auth probe (`hs accounts list` parsing)
// ---------------------------------------------------------------------------

const HS_ACCOUNTS_OUTPUT = [
  "Account: my-portal (123456)",
  "",
  "Name                    Account ID   Auth Type",
  "----------------------  -----------  -----------------",
  "my-portal [standard]    123456       personalaccesskey",
  "sandbox-portal          789012       oauth2",
].join("\n");

describe("detectHubSpotAuth", () => {
  it("returns unauthenticated when the CLI probe fails", () => {
    expect(detectHubSpotAuth()).toEqual({ authenticated: false, portalName: "", portalId: "", accounts: [] });
  });

  it("parses the default account and the accounts table", () => {
    setRun("hs accounts list", HS_ACCOUNTS_OUTPUT);
    const auth = detectHubSpotAuth();
    expect(auth.authenticated).toBe(true);
    expect(auth.portalName).toBe("my-portal");
    expect(auth.portalId).toBe("123456");
    expect(auth.accounts).toHaveLength(2);
    expect(auth.accounts[0]).toEqual({
      name: "my-portal [standard]",
      portalId: "123456",
      authType: "personalaccesskey",
      isDefault: true,
    });
    expect(auth.accounts[1]).toMatchObject({ portalId: "789012", authType: "oauth2", isDefault: false });
  });

  it("falls back to the first table row when no default line exists", () => {
    setRun("hs accounts list", ["some-portal    123456    personalaccesskey"].join("\n"));
    const auth = detectHubSpotAuth();
    expect(auth.authenticated).toBe(true);
    expect(auth.portalId).toBe("123456");
    expect(auth.portalName).toBe("some-portal");
  });

  it("caps the credential probe with the aggressive auth timeout (VIB-1834)", () => {
    setRun("hs accounts list", HS_ACCOUNTS_OUTPUT);
    detectHubSpotAuth();
    const call = state.runCalls.find((c) => c.command === "hs accounts list");
    expect(call?.options).toMatchObject({ timeout: 4000 });
  });
});

// ---------------------------------------------------------------------------
// GitHub auth probe
// ---------------------------------------------------------------------------

describe("detectGitHubAuth", () => {
  it("parses the username from a logged-in status", () => {
    setRun("gh auth status 2>&1", "github.com\n  ✓ Logged in to github.com account borismichel (keyring)");
    expect(detectGitHubAuth()).toEqual({ authenticated: true, username: "borismichel" });
  });

  it("reports unauthenticated when the probe produces nothing", () => {
    expect(detectGitHubAuth()).toEqual({ authenticated: false, username: "" });
  });

  it("reports unauthenticated for a not-logged-in message", () => {
    state.runResults.set("gh auth status 2>&1", {
      stdout: "You are not logged into any GitHub hosts. To log in, run: gh auth login",
      stderr: "",
      success: false,
    });
    expect(detectGitHubAuth().authenticated).toBe(false);
  });

  it("caps the probe with the aggressive auth timeout (VIB-1834)", () => {
    setRun("gh auth status 2>&1", "Logged in to github.com account qa (keyring)");
    detectGitHubAuth();
    const call = state.runCalls.find((c) => c.command === "gh auth status 2>&1");
    expect(call?.options).toMatchObject({ timeout: 4000 });
  });
});

// ---------------------------------------------------------------------------
// AI CLI probes (Claude Code / Gemini / Codex)
// ---------------------------------------------------------------------------

describe("detectClaudeCode", () => {
  it("reports not-installed when the binary is missing", () => {
    expect(detectClaudeCode()).toMatchObject({ found: false, authenticated: false, authDetail: "Not installed" });
  });

  it("reports unauthenticated when ~/.claude does not exist", () => {
    setRun("claude --version", "1.0.30 (Claude Code)");
    const info = detectClaudeCode();
    expect(info.found).toBe(true);
    expect(info.authenticated).toBe(false);
    expect(info.authDetail).toContain("Not signed in");
  });

  it("treats a credentials file in ~/.claude as authenticated", () => {
    setRun("claude --version", "1.0.30 (Claude Code)");
    mkdirSync(join(state.home, ".claude"));
    writeFileSync(join(state.home, ".claude", ".credentials.json"), "{}");
    expect(detectClaudeCode()).toMatchObject({ authenticated: true, authDetail: "Authenticated" });
  });
});

describe("detectGeminiCLI", () => {
  it("reports not-installed when the binary is missing", () => {
    expect(detectGeminiCLI()).toMatchObject({ found: false, authDetail: "Not installed" });
  });

  it("is unauthenticated with no ADC file and no env key", () => {
    setRun("gemini --version", "0.1.5");
    expect(detectGeminiCLI()).toMatchObject({ found: true, authenticated: false });
  });

  it("authenticates via GEMINI_API_KEY", () => {
    setRun("gemini --version", "0.1.5");
    process.env.GEMINI_API_KEY = "g-key";
    expect(detectGeminiCLI().authenticated).toBe(true);
  });

  it("authenticates via gcloud application default credentials", () => {
    setRun("gemini --version", "0.1.5");
    mkdirSync(join(state.home, ".config", "gcloud"), { recursive: true });
    writeFileSync(join(state.home, ".config", "gcloud", "application_default_credentials.json"), "{}");
    expect(detectGeminiCLI().authenticated).toBe(true);
  });
});

describe("detectCodexCLI", () => {
  it("reports not-installed when the binary is missing", () => {
    expect(detectCodexCLI()).toMatchObject({ found: false, authDetail: "Not installed" });
  });

  it("prefers OAuth detail when ~/.codex/auth.json holds a token", () => {
    setRun("codex --version", "0.4.0");
    mkdirSync(join(state.home, ".codex"));
    writeFileSync(join(state.home, ".codex", "auth.json"), JSON.stringify({ token: "abc123456789" }));
    expect(detectCodexCLI()).toMatchObject({ authenticated: true, authDetail: "Authenticated (OAuth)" });
  });

  it("falls back to the API key detail with OPENAI_API_KEY", () => {
    setRun("codex --version", "0.4.0");
    process.env.OPENAI_API_KEY = "sk-test";
    expect(detectCodexCLI()).toMatchObject({ authenticated: true, authDetail: "Authenticated (API key)" });
  });

  it("ignores an effectively empty auth.json", () => {
    setRun("codex --version", "0.4.0");
    mkdirSync(join(state.home, ".codex"));
    writeFileSync(join(state.home, ".codex", "auth.json"), "{}");
    expect(detectCodexCLI()).toMatchObject({ authenticated: false, authDetail: "Not authenticated" });
  });
});

// ---------------------------------------------------------------------------
// Config-based HubSpot auth (API mode)
// ---------------------------------------------------------------------------

describe("detectHubSpotAuthFromConfig", () => {
  it("is unauthenticated with no configured accounts", () => {
    expect(detectHubSpotAuthFromConfig()).toEqual({
      authenticated: false,
      portalName: "",
      portalId: "",
      dataCenter: "na1",
      accounts: [],
      uploadMode: "api",
    });
  });

  it("maps configured accounts and flags the active one as default", () => {
    state.config = {
      hubspotUploadMode: "api",
      hubspotAccounts: [
        { portalId: "111", portalName: "one", dataCenter: "na1" },
        { portalId: "222", portalName: "two", dataCenter: "eu1" },
      ],
      activeHubSpotAccount: "222",
    };
    state.activeAccount = { portalId: "222", portalName: "two", dataCenter: "eu1" };
    const auth = detectHubSpotAuthFromConfig();
    expect(auth.authenticated).toBe(true);
    expect(auth.portalId).toBe("222");
    expect(auth.dataCenter).toBe("eu1");
    expect(auth.accounts.map((a) => a.isDefault)).toEqual([false, true]);
    expect(auth.accounts[0]).toMatchObject({ authType: "personalaccesskey" });
  });
});

// ---------------------------------------------------------------------------
// Environment status entry points
// ---------------------------------------------------------------------------

describe("detectEnvironmentLite", () => {
  it("is config-only: no subprocess runs, scanned=false, tools are placeholders", () => {
    const env = detectEnvironmentLite();
    expect(state.runCalls).toHaveLength(0);
    expect(env.scanned).toBe(false);
    expect(env.tools.node.found).toBe(false);
    expect(env.tools.claudeCode.authDetail).toBe("Not scanned");
    expect(env.tools.github.authenticated).toBe(false);
  });

  it("reports API keys from config with source=config and masked values", () => {
    state.config = { anthropicApiKey: "sk-ant-secret" };
    const env = detectEnvironmentLite();
    expect(env.apiKeys.anthropic).toEqual({ configured: true, masked: "masked:sk-", source: "config" });
    expect(env.apiKeys.openai).toEqual({ configured: false, masked: "", source: null });
  });

  it("falls back to env vars with source=env (config wins over env)", () => {
    process.env.OPENAI_API_KEY = "sk-openai-env";
    process.env.GEMINI_API_KEY = "g-env";
    state.config = { geminiApiKey: "g-config" };
    const env = detectEnvironmentLite();
    expect(env.apiKeys.openai.source).toBe("env");
    expect(env.apiKeys.gemini).toMatchObject({ source: "config", masked: "masked:g-c" });
  });

  it("lists enabled CLI engines optimistically before any scan", () => {
    state.enabledCliTools = new Set(["claude-code", "codex-cli"]);
    const env = detectEnvironmentLite();
    expect(env.availableEngines).toEqual(["claude-code", "codex-cli"]);
  });

  it("includes claude-oauth and API-key engines in order", () => {
    state.oauthValid = true;
    state.oauthInfo = { expiresAt: "2027-01-01T00:00:00Z" };
    process.env.ANTHROPIC_API_KEY = "a";
    process.env.LANGDOCK_API_KEY = "l";
    const env = detectEnvironmentLite();
    expect(env.availableEngines).toEqual(["claude-oauth", "anthropic-api", "langdock-api"]);
    expect(env.tools.claudeOAuth).toEqual({ authenticated: true, expiresAt: "2027-01-01T00:00:00Z" });
  });

  it("reports HubSpot API-mode accounts from config without scanning", () => {
    state.config = {
      hubspotAccounts: [{ portalId: "111", portalName: "one", dataCenter: "na1" }],
    };
    state.activeAccount = { portalId: "111", portalName: "one", dataCenter: "na1" };
    const env = detectEnvironmentLite();
    expect(env.tools.hubspot).toMatchObject({ name: "HubSpot API", found: true, authenticated: true, uploadMode: "api" });
  });

  it("leaves HubSpot as a not-scanned placeholder in CLI upload mode", () => {
    state.config = { hubspotUploadMode: "cli" };
    const env = detectEnvironmentLite();
    expect(env.tools.hubspot).toMatchObject({ found: false, authenticated: false, uploadMode: "cli" });
    expect(state.runCalls).toHaveLength(0);
  });
});

describe("detectAITools", () => {
  it("marks disabled tools as Disabled and derives engines from keys only", () => {
    process.env.OPENAI_API_KEY = "sk";
    const result = detectAITools();
    expect(result.claudeCode.authDetail).toBe("Disabled");
    expect(result.geminiCli.authDetail).toBe("Disabled");
    expect(result.codexCli.authDetail).toBe("Disabled");
    expect(result.availableEngines).toEqual(["openai-api"]);
    // No CLI probes ran for disabled tools
    expect(state.runCalls).toHaveLength(0);
  });

  it("counts a CLI engine as available only when found AND authenticated", () => {
    state.enabledCliTools = new Set(["claude-code", "gemini-cli"]);
    // claude installed + authenticated
    setRun("claude --version", "1.0.30");
    setRun("which claude", "/usr/local/bin/claude");
    mkdirSync(join(state.home, ".claude"));
    writeFileSync(join(state.home, ".claude", ".credentials.json"), "{}");
    // gemini installed but unauthenticated
    setRun("gemini --version", "0.1.5");
    const result = detectAITools();
    expect(result.availableEngines).toContain("claude-code");
    expect(result.availableEngines).not.toContain("gemini-cli");
  });
});

describe("detectPlatformTools", () => {
  it("combines GitHub CLI presence with the auth probe", () => {
    setRun("gh --version", "gh version 2.40.1 (2023-12-13)");
    setRun("which gh", "/usr/bin/gh");
    setRun("gh auth status 2>&1", "Logged in to github.com account borismichel (keyring)");
    const result = detectPlatformTools();
    expect(result.github).toMatchObject({ found: true, authenticated: true, username: "borismichel" });
  });

  it("skips the GitHub auth probe when gh is not installed", () => {
    const result = detectPlatformTools();
    expect(result.github.authenticated).toBe(false);
    expect(state.runCalls.some((c) => c.command === "gh auth status 2>&1")).toBe(false);
  });

  it("scans HubSpot CLI mode end-to-end including the data center", () => {
    state.config = { hubspotUploadMode: "cli" };
    setRun("hs --version", "8.2.0");
    setRun("which hs", "/usr/bin/hs");
    setRun("hs accounts list", HS_ACCOUNTS_OUTPUT);
    writeHscliConfig(
      [
        "portals:",
        "  - name: my-portal",
        "    accountId: 123456",
        "    personalAccessKey: >-",
        "      CiRldTEtZmFrZS1rZXk",
      ].join("\n"),
    );
    const result = detectPlatformTools();
    expect(result.hubspot).toMatchObject({
      found: true,
      authenticated: true,
      portalId: "123456",
      dataCenter: "eu1",
      uploadMode: "cli",
    });
  });

  it("returns config-derived HubSpot info in API mode without CLI probes", () => {
    state.activeAccount = { portalId: "999", portalName: "api-portal", dataCenter: "na1" };
    state.config = { hubspotAccounts: [{ portalId: "999", portalName: "api-portal", dataCenter: "na1" }] };
    const result = detectPlatformTools();
    expect(result.hubspot).toMatchObject({ name: "HubSpot API", version: "v3", authenticated: true, uploadMode: "api" });
    expect(state.runCalls.some((c) => c.command.startsWith("hs "))).toBe(false);
  });
});

describe("detectEnvironment (full scan)", () => {
  it("produces a scanned status with accurate engine availability", () => {
    state.enabledCliTools = new Set(["claude-code"]);
    setRun("node --version", "v20.11.1");
    setRun("which node", "/usr/bin/node");
    setRun("git --version", "git version 2.43.0");
    setRun("which git", "/usr/bin/git");
    setRun("gh --version", "gh version 2.40.1 (2023-12-13)");
    setRun("which gh", "/usr/bin/gh");
    setRun("gh auth status 2>&1", "Logged in to github.com account qa-bot (keyring)");
    // claude installed but NOT authenticated → engine must not be listed
    setRun("claude --version", "1.0.30");
    setRun("which claude", "/usr/local/bin/claude");
    process.env.ANTHROPIC_API_KEY = "sk-ant";

    const env = detectEnvironment();
    expect(env.scanned).toBe(true);
    expect(env.tools.node).toMatchObject({ found: true, version: "20.11.1" });
    expect(env.tools.github).toMatchObject({ authenticated: true, username: "qa-bot" });
    expect(env.tools.claudeCode).toMatchObject({ found: true, authenticated: false });
    expect(env.availableEngines).toEqual(["anthropic-api"]);
    expect(env.tools.geminiCli.authDetail).toBe("Disabled");
  });
});
