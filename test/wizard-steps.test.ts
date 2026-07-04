/**
 * Behavioral coverage for the src/wizard/ step implementations (VIB-1915).
 *
 * Covers the full wizard flow: preflight → source → theme-setup →
 * conversion → uploader → next-steps.
 *
 * Strategy (same conventions as test/detect.test.ts / settings-routes.test.ts):
 * mock the external-I/O seams — shell subprocesses, ~/.vibespot config,
 * @clack prompts (scriptable answer queues), the HubSpot API/fetcher/uploader,
 * the AI engines, and browser-opening execFileSync — while exercising the real
 * fs-based logic (base.html patching, fields.json auto-fixes, source analysis)
 * against isolated temp dirs. No subprocess, no network, no real home dir.
 * process.exit is stubbed to throw so exit paths are assertable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Mutable mock state (hoisted so the vi.mock factories can reference it)
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  // prompter answer queues + records
  textAnswers: [] as string[],
  textCalls: [] as Array<{ message: string; validate?: (v: string) => string | undefined }>,
  confirmAnswers: [] as boolean[],
  selectAnswers: [] as string[],
  selectCalls: [] as Array<{ message: string; options: Array<{ value: string; label: string }> }>,
  logs: [] as Array<{ level: string; message: string }>,
  // shell
  runImpl: (() => ({ stdout: "", stderr: "", success: true })) as (
    cmd: string, opts?: unknown) => { stdout: string; stderr: string; success: boolean },
  runGitImpl: (() => ({ stdout: "", stderr: "", success: true })) as (
    args: string[], opts?: unknown) => { stdout: string; stderr: string; success: boolean },
  runGitCalls: [] as string[][],
  runFileImpl: (() => ({ stdout: "", stderr: "", success: true })) as (
    file: string, args: string[], opts?: unknown) => { stdout: string; stderr: string; success: boolean },
  runFileCalls: [] as Array<{ file: string; args: string[] }>,
  runPassthroughResult: true,
  // config
  config: {} as Record<string, unknown>,
  savedConfigs: [] as Array<Record<string, unknown>>,
  pak: null as string | null,
  activeAccount: null as null | { portalId: string; portalName: string },
  addAccountCalls: [] as unknown[][],
  // detect
  tools: {
    node: { name: "Node.js", found: true, version: "20.11.1", path: "/usr/bin/node" },
    git: { name: "Git", found: true, version: "2.43.0", path: "/usr/bin/git" },
    hs: { name: "HubSpot CLI", found: false, version: "", path: "" },
    claude: { name: "Claude Code", found: false, version: "", path: "" },
    gemini: { name: "Gemini CLI", found: false, version: "", path: "" },
    codex: { name: "Codex CLI", found: false, version: "", path: "" },
  },
  nodeVersionOk: true,
  hasAnthropicKey: false,
  hsAuth: { authenticated: false, portalId: "", portalName: "" },
  dataCenter: "na1" as string,
  oauthValid: false,
  // hubspot api / fetcher / scaffold / uploader
  validatePakImpl: (async (_key: string) => ({
    portalId: "0", portalName: "", dataCenter: "na1",
  })) as (key: string) => Promise<{ portalId: string; portalName: string; dataCenter: string }>,
  scaffoldImpl: ((_path: string, _name: string) => {}) as (path: string, name: string) => void,
  fetchThemeImpl: (async (_pak: string, _name: string, _path: string) => {}) as (
    pak: string, name: string, path: string) => Promise<void>,
  uploadThemeResults: [] as Array<{ success: boolean; uploaded: number; errors: unknown[] }>,
  uploadThemeCalls: 0,
  deleteFileCalls: [] as string[],
  // auto-fix
  parsedErrors: [] as Array<{ file: string; message: string; fixable: boolean }>,
  autoFixResult: false,
  autoFixCalls: [] as string[],
  // AI engines
  engineCtors: [] as Array<{ type: string; model?: string }>,
  convertImpl: (async (_opts: unknown) => {
    throw new Error("convertImpl not configured");
  }) as (opts: {
    sourceDir: string; themePath: string; conversionGuide: string;
    onProgress: (step: string, detail: string) => void;
  }) => Promise<unknown>,
  // child_process (browser open in next-steps)
  execCalls: [] as unknown[][],
  execThrows: false,
}));

vi.mock("../src/prompts/prompter.js", () => ({
  isCancel: (v: unknown) => typeof v === "symbol",
  handleCancel: () => {},
  intro: async () => {},
  outro: async () => {},
  note: async () => {},
  text: async (opts: { message: string; validate?: (v: string) => string | undefined }) => {
    state.textCalls.push({ message: opts.message, validate: opts.validate });
    if (state.textAnswers.length === 0) throw new Error(`No queued text answer for: ${opts.message}`);
    return state.textAnswers.shift()!;
  },
  confirm: async (opts: { message: string }) => {
    if (state.confirmAnswers.length === 0) throw new Error(`No queued confirm answer for: ${opts.message}`);
    return state.confirmAnswers.shift()!;
  },
  select: async (opts: { message: string; options: Array<{ value: string; label: string }> }) => {
    state.selectCalls.push({ message: opts.message, options: opts.options });
    if (state.selectAnswers.length === 0) throw new Error(`No queued select answer for: ${opts.message}`);
    return state.selectAnswers.shift()!;
  },
  spinner: async () => ({ start: () => {}, stop: () => {}, message: () => {} }),
  log: (m: string) => state.logs.push({ level: "log", message: m }),
  logSuccess: (m: string) => state.logs.push({ level: "success", message: m }),
  logWarn: (m: string) => state.logs.push({ level: "warn", message: m }),
  logError: (m: string) => state.logs.push({ level: "error", message: m }),
  logStep: (m: string) => state.logs.push({ level: "step", message: m }),
}));

vi.mock("../src/utils/shell.js", () => ({
  run: (cmd: string, opts?: unknown) => state.runImpl(cmd, opts),
  runGit: (args: string[], opts?: unknown) => {
    state.runGitCalls.push(args);
    return state.runGitImpl(args, opts);
  },
  runFile: (file: string, args: string[], opts?: unknown) => {
    state.runFileCalls.push({ file, args });
    return state.runFileImpl(file, args, opts);
  },
  runPassthrough: () => state.runPassthroughResult,
  runOrThrow: () => { throw new Error("runOrThrow not expected in wizard tests"); },
}));

vi.mock("../src/utils/config.js", () => ({
  loadConfig: () => ({ ...state.config }),
  saveConfig: (update: Record<string, unknown>) => {
    state.savedConfigs.push(update);
    Object.assign(state.config, update);
  },
  getHubSpotPak: () => state.pak,
  getActiveHubSpotAccount: () => state.activeAccount,
  addHubSpotAccount: (...args: unknown[]) => state.addAccountCalls.push(args),
}));

vi.mock("../src/utils/detect.js", () => ({
  detectNode: () => state.tools.node,
  detectGit: () => state.tools.git,
  detectHubSpotCLI: () => state.tools.hs,
  detectClaudeCode: () => state.tools.claude,
  detectGeminiCLI: () => state.tools.gemini,
  detectCodexCLI: () => state.tools.codex,
  detectHubSpotAuth: () => state.hsAuth,
  hasAnthropicKey: () => state.hasAnthropicKey,
  nodeVersionOk: () => state.nodeVersionOk,
  detectDataCenter: () => state.dataCenter,
}));

vi.mock("../src/utils/claude-oauth.js", () => ({
  hasValidOAuthToken: () => state.oauthValid,
}));

vi.mock("../src/hubspot/api.js", () => ({
  validatePak: (key: string) => state.validatePakImpl(key),
}));

vi.mock("../src/hubspot/theme-scaffold.js", () => ({
  createThemeScaffold: (path: string, name: string) => state.scaffoldImpl(path, name),
}));

vi.mock("../src/hubspot/fetcher.js", () => ({
  fetchTheme: (pak: string, name: string, path: string) => state.fetchThemeImpl(pak, name, path),
}));

vi.mock("../src/hubspot/uploader.js", () => ({
  uploadTheme: async (_pak: string, _themePath: string, _themeName: string) => {
    state.uploadThemeCalls++;
    const r = state.uploadThemeResults.shift();
    if (!r) throw new Error("No queued uploadTheme result");
    return r;
  },
  deleteFile: async (_pak: string, remotePath: string) => {
    state.deleteFileCalls.push(remotePath);
  },
}));

vi.mock("../src/server/auto-fix.js", () => ({
  parseUploadErrors: () => state.parsedErrors,
  parseApiErrors: () => state.parsedErrors,
  autoFixError: (_themePath: string, error: { message: string }) => {
    state.autoFixCalls.push(error.message);
    return state.autoFixResult;
  },
}));

vi.mock("../src/ai/claude-code.js", () => ({
  ClaudeCodeEngine: class {
    constructor(model?: string) { state.engineCtors.push({ type: "claude-code", model }); }
    convert(opts: never) { return state.convertImpl(opts); }
  },
}));
vi.mock("../src/ai/claude-api.js", () => ({
  ClaudeAPIEngine: class {
    constructor() { state.engineCtors.push({ type: "anthropic-api" }); }
    convert(opts: never) { return state.convertImpl(opts); }
  },
}));
vi.mock("../src/ai/gemini-cli.js", () => ({
  GeminiCLIEngine: class {
    constructor() { state.engineCtors.push({ type: "gemini-cli" }); }
    convert(opts: never) { return state.convertImpl(opts); }
  },
}));
vi.mock("../src/ai/codex-cli.js", () => ({
  CodexCLIEngine: class {
    constructor() { state.engineCtors.push({ type: "codex-cli" }); }
    convert(opts: never) { return state.convertImpl(opts); }
  },
}));
vi.mock("../src/ai/prompts.js", () => ({
  getConversionGuide: () => "CONVERSION GUIDE",
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => {
      state.execCalls.push(args);
      if (state.execThrows) throw new Error("no browser available");
    },
  };
});

import { runPreflight } from "../src/wizard/preflight.js";
import { isValidGitSource, analyzeSource, setupSource } from "../src/wizard/source.js";
import { setupTheme } from "../src/wizard/theme-setup.js";
import {
  runConversion,
  validateAndFix,
  validateTemplates,
  validateModuleMeta,
} from "../src/wizard/conversion.js";
import { runUpload } from "../src/wizard/uploader.js";
import { showNextSteps } from "../src/wizard/next-steps.js";

// ---------------------------------------------------------------------------
// Test harness: exit-as-throw, temp dirs, state reset
// ---------------------------------------------------------------------------

class ExitError extends Error {
  constructor(public code: number | undefined) { super(`process.exit(${code})`); }
}

let tmp: string;
const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vibespot-wizard-"));
  delete process.env.ANTHROPIC_API_KEY;

  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code);
  }) as never);

  // reset queues/records
  state.textAnswers = [];
  state.textCalls = [];
  state.confirmAnswers = [];
  state.selectAnswers = [];
  state.selectCalls = [];
  state.logs = [];
  state.runImpl = () => ({ stdout: "", stderr: "", success: true });
  state.runGitImpl = () => ({ stdout: "", stderr: "", success: true });
  state.runGitCalls = [];
  state.runFileImpl = () => ({ stdout: "", stderr: "", success: true });
  state.runFileCalls = [];
  state.runPassthroughResult = true;
  state.config = {};
  state.savedConfigs = [];
  state.pak = null;
  state.activeAccount = null;
  state.addAccountCalls = [];
  state.tools = {
    node: { name: "Node.js", found: true, version: "20.11.1", path: "/usr/bin/node" },
    git: { name: "Git", found: true, version: "2.43.0", path: "/usr/bin/git" },
    hs: { name: "HubSpot CLI", found: false, version: "", path: "" },
    claude: { name: "Claude Code", found: false, version: "", path: "" },
    gemini: { name: "Gemini CLI", found: false, version: "", path: "" },
    codex: { name: "Codex CLI", found: false, version: "", path: "" },
  };
  state.nodeVersionOk = true;
  state.hasAnthropicKey = false;
  state.hsAuth = { authenticated: false, portalId: "", portalName: "" };
  state.dataCenter = "na1";
  state.oauthValid = false;
  state.validatePakImpl = async () => ({ portalId: "0", portalName: "", dataCenter: "na1" });
  state.scaffoldImpl = () => {};
  state.fetchThemeImpl = async () => {};
  state.uploadThemeResults = [];
  state.uploadThemeCalls = 0;
  state.deleteFileCalls = [];
  state.parsedErrors = [];
  state.autoFixResult = false;
  state.autoFixCalls = [];
  state.engineCtors = [];
  state.convertImpl = async () => { throw new Error("convertImpl not configured"); };
  state.execCalls = [];
  state.execThrows = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
});

function errorLogs(): string {
  return state.logs.filter((l) => l.level === "error").map((l) => l.message).join("\n");
}

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** Point process.cwd() at the temp dir (source/theme-setup write under cwd()/workspace). */
function mockCwd() {
  vi.spyOn(process, "cwd").mockReturnValue(tmp);
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

describe("runPreflight", () => {
  function connectHubSpotApiMode() {
    state.pak = "pat-na1-existing";
    state.activeAccount = { portalId: "123", portalName: "Acme" };
  }

  it("exits when Node.js is missing", async () => {
    state.tools.node = { name: "Node.js", found: false, version: "", path: "" };
    await expect(runPreflight()).rejects.toThrow(ExitError);
    expect(errorLogs()).toContain("Node.js not found");
  });

  it("exits when the Node.js version is too old", async () => {
    state.tools.node.version = "16.0.0";
    state.nodeVersionOk = false;
    await expect(runPreflight()).rejects.toThrow(ExitError);
    expect(errorLogs()).toContain("too old");
  });

  it("exits when Git is missing", async () => {
    state.tools.git = { name: "Git", found: false, version: "", path: "" };
    await expect(runPreflight()).rejects.toThrow(ExitError);
    expect(errorLogs()).toContain("Git not found");
  });

  it("API mode with a connected account auto-selects the only engine and asks for a model", async () => {
    connectHubSpotApiMode();
    state.tools.claude.found = true;
    state.selectAnswers = ["sonnet"]; // model prompt only — engine is auto-selected

    const result = await runPreflight();

    expect(result).toEqual({
      aiEngine: "claude-code",
      model: "sonnet",
      portalId: "123",
      portalName: "Acme",
    });
    // only the model prompt fired
    expect(state.selectCalls).toHaveLength(1);
    expect(state.selectCalls[0].message).toContain("model");
    expect(state.savedConfigs).toContainEqual({ aiEngine: "claude-code" });
  });

  it("API mode without a PAK prompts for a key and registers the validated account", async () => {
    state.tools.claude.found = true;
    state.textAnswers = ["pat-na1-newkey"];
    state.selectAnswers = ["sonnet"];
    state.validatePakImpl = async (key) => {
      expect(key).toBe("pat-na1-newkey");
      return { portalId: "777", portalName: "Fresh Portal", dataCenter: "na1" };
    };

    const result = await runPreflight();

    expect(state.addAccountCalls).toEqual([["pat-na1-newkey", "777", "Fresh Portal", "na1"]]);
    expect(result.portalId).toBe("777");
    expect(result.portalName).toBe("Fresh Portal");
  });

  it("API mode exits when the pasted key fails validation", async () => {
    state.textAnswers = ["pat-na1-bad"];
    state.validatePakImpl = async () => { throw new Error("401 Unauthorized"); };

    await expect(runPreflight()).rejects.toThrow(ExitError);
    expect(errorLogs()).toContain("Invalid key");
    expect(errorLogs()).toContain("401 Unauthorized");
  });

  it("CLI mode exits when the HubSpot CLI is missing and the user declines the install", async () => {
    state.config = { hubspotUploadMode: "cli" };
    state.confirmAnswers = [false]; // decline "Install HubSpot CLI globally?"

    await expect(runPreflight()).rejects.toThrow(ExitError);
    expect(errorLogs()).toContain("npm install -g @hubspot/cli");
  });

  it("CLI mode with an authenticated portal carries the portal into the result", async () => {
    state.config = { hubspotUploadMode: "cli" };
    state.tools.hs = { name: "HubSpot CLI", found: true, version: "7.0.0", path: "/usr/bin/hs" };
    state.hsAuth = { authenticated: true, portalId: "456", portalName: "CLI Portal" };
    state.tools.gemini.found = true; // single engine, no model prompt

    const result = await runPreflight();

    expect(result.portalId).toBe("456");
    expect(result.portalName).toBe("CLI Portal");
    expect(result.aiEngine).toBe("gemini-cli");
    expect(result.model).toBeUndefined();
  });

  it("offers all detected engines and sorts the last-used engine first", async () => {
    connectHubSpotApiMode();
    state.tools.claude.found = true;
    state.tools.gemini.found = true;
    state.hasAnthropicKey = true;
    state.config.aiEngine = "gemini-cli";
    state.selectAnswers = ["gemini-cli"];

    const result = await runPreflight();

    const engineSelect = state.selectCalls[0];
    expect(engineSelect.message).toContain("AI engine");
    expect(engineSelect.options.map((o) => o.value)).toEqual(["gemini-cli", "claude-code", "api"]);
    expect(engineSelect.options[0].hint).toContain("last used");
    expect(result.aiEngine).toBe("gemini-cli");
    expect(result.model).toBeUndefined(); // model prompt is claude-code only
  });

  it("includes the OAuth engine when a valid token exists", async () => {
    connectHubSpotApiMode();
    state.tools.claude.found = true;
    state.oauthValid = true;
    state.selectAnswers = ["claude-oauth"];

    const result = await runPreflight();

    expect(state.selectCalls[0].options.map((o) => o.value)).toContain("claude-oauth");
    expect(result.aiEngine).toBe("claude-oauth");
  });

  it("with no engines available, guides setup and stores an entered API key", async () => {
    connectHubSpotApiMode();
    state.selectAnswers = ["api"];
    state.textAnswers = ["sk-ant-api03-secret"];

    const result = await runPreflight();

    expect(result.aiEngine).toBe("api");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-secret");
    expect(state.savedConfigs).toContainEqual({ anthropicApiKey: "sk-ant-api03-secret" });
    // the key prompt validates the sk-ant- prefix
    const keyPrompt = state.textCalls.find((c) => c.message.includes("Anthropic API key"));
    expect(keyPrompt?.validate?.("nope")).toContain("sk-ant-");
    expect(keyPrompt?.validate?.("sk-ant-ok")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** Minimal React project fixture under `dir`. */
function makeReactProject(dir: string) {
  write(join(dir, "src/components/Hero.tsx"), "export const Hero = () => <h1>headline tagline</h1>;");
  write(join(dir, "src/components/PricingTable.tsx"), "export const P = () => <div>pricing plan tier</div>;");
  write(join(dir, "src/components/index.ts"), "export {};"); // skipped: not tsx
  write(
    join(dir, "src/index.css"),
    `@import url(https://fonts.googleapis.com/css2?family=Inter&display=swap);\n` +
      `:root { --primary: #fff; --secondary: #000; }\n` +
      `body { font-family: 'Space Grotesk', sans-serif; }\n`
  );
  writeFileSync(join(dir, "tailwind.config.ts"), "export default {};");
}

describe("isValidGitSource", () => {
  it("accepts https and git@ SSH URLs", () => {
    expect(isValidGitSource("https://github.com/user/repo")).toBe(true);
    expect(isValidGitSource("https://github.com/user/repo.git")).toBe(true);
    expect(isValidGitSource("git@github.com:user/repo.git")).toBe(true);
  });

  it("rejects other schemes, shell metacharacters, and oversized input", () => {
    expect(isValidGitSource("file:///etc/passwd")).toBe(false);
    expect(isValidGitSource("ext::sh -c whoami")).toBe(false);
    expect(isValidGitSource("https://x.com/repo;rm -rf ~")).toBe(false);
    expect(isValidGitSource("https://x.com/$(id)")).toBe(false);
    expect(isValidGitSource("https://x.com/a|b")).toBe(false);
    expect(isValidGitSource("")).toBe(false);
    expect(isValidGitSource("https://x.com/" + "a".repeat(2048))).toBe(false);
  });
});

describe("analyzeSource", () => {
  it("analyzes a local project: components, tailwind, CSS vars, fonts, default interactions", () => {
    const dir = join(tmp, "proj");
    makeReactProject(dir);

    const analysis = analyzeSource(dir);

    expect(analysis.sourceDir).toBe(dir);
    expect(analysis.wasCloned).toBe(false);
    expect(analysis.components.map((c) => c.name).sort()).toEqual(["Hero", "PricingTable"]);
    const hero = analysis.components.find((c) => c.name === "Hero")!;
    expect(hero.description).toContain("hero");
    expect(analysis.hasTailwind).toBe(true);
    expect(analysis.cssVarCount).toBe(2);
    expect(analysis.fonts).toEqual(expect.arrayContaining(["Space Grotesk", "Inter"]));
    expect(analysis.interactions).toEqual(["Scroll animations"]); // fallback when none detected
  });

  it("throws for a missing local directory", () => {
    expect(() => analyzeSource(join(tmp, "nope"))).toThrow("Directory not found");
  });

  it("refuses unsafe clone URLs without invoking git", () => {
    expect(() => analyzeSource("https://evil.com/repo;id")).toThrow("Refusing to clone");
    expect(state.runGitCalls).toHaveLength(0);
  });

  it("clones a valid URL with --depth 1 -- separator and analyzes the result", () => {
    mockCwd();
    state.runGitImpl = (args) => {
      makeReactProject(args[args.length - 1]); // clone target dir
      return { stdout: "", stderr: "", success: true };
    };

    const analysis = analyzeSource("https://github.com/user/my-page.git");

    expect(analysis.wasCloned).toBe(true);
    expect(analysis.sourceDir).toBe(join(tmp, "workspace", "my-page"));
    expect(state.runGitCalls).toEqual([
      ["clone", "--depth", "1", "--", "https://github.com/user/my-page.git", join(tmp, "workspace", "my-page")],
    ]);
    expect(analysis.components.length).toBe(2);
  });

  it("reuses an existing clone instead of cloning again", () => {
    mockCwd();
    makeReactProject(join(tmp, "workspace", "my-page"));

    const analysis = analyzeSource("https://github.com/user/my-page");

    expect(state.runGitCalls).toHaveLength(0);
    expect(analysis.wasCloned).toBe(true);
  });

  it("throws when the clone fails", () => {
    mockCwd();
    state.runGitImpl = () => ({ stdout: "", stderr: "repo not found", success: false });
    expect(() => analyzeSource("https://github.com/user/gone")).toThrow(/Failed to clone .*repo not found/);
  });
});

describe("setupSource", () => {
  it("analyzes a confirmed local source", async () => {
    const dir = join(tmp, "proj");
    makeReactProject(dir);
    state.textAnswers = [dir];
    state.confirmAnswers = [true]; // "Does this look right?"

    const analysis = await setupSource();

    expect(analysis.sourceDir).toBe(dir);
    expect(analysis.components).toHaveLength(2);
  });

  it("exits when no components are found", async () => {
    const dir = join(tmp, "empty");
    mkdirSync(join(dir, "src/components"), { recursive: true });
    state.textAnswers = [dir];

    await expect(setupSource()).rejects.toThrow(ExitError);
    expect(state.logs.some((l) => l.level === "warn" && l.message.includes("No components found"))).toBe(true);
  });

  it("exits (code 0) when the user rejects the analysis summary", async () => {
    const dir = join(tmp, "proj");
    makeReactProject(dir);
    state.textAnswers = [dir];
    state.confirmAnswers = [false];

    await expect(setupSource()).rejects.toThrow("process.exit(0)");
  });

  it("exits when the entered local directory does not exist", async () => {
    state.textAnswers = [join(tmp, "missing")];
    await expect(setupSource()).rejects.toThrow(ExitError);
    expect(errorLogs()).toContain("Directory not found");
  });
});

// ---------------------------------------------------------------------------
// Theme setup
// ---------------------------------------------------------------------------

const BASE_HTML_UNPATCHED = `<!doctype html>
<html>
<head>
  {{ require_css(get_asset_url("../../css/main.css")) }}
  {{ require_css(get_asset_url("../../css/theme-overrides.css")) }}
</head>
<body>
  {% block body %}{% endblock body %}
  {{ require_js(get_asset_url("../../js/main.js")) }}
</body>
</html>
`;

const BASE_HTML_PATCHED = BASE_HTML_UNPATCHED
  .replace(
    `  {{ require_css(get_asset_url("../../css/theme-overrides.css")) }}`,
    `  {% if template_css %}\n    {{ require_css(get_asset_url(template_css)) }}\n  {% endif %}\n` +
      `  {{ require_css(get_asset_url("../../css/theme-overrides.css")) }}`
  )
  .replace(
    `  {{ require_js(get_asset_url("../../js/main.js")) }}`,
    `  {{ require_js(get_asset_url("../../js/main.js")) }}\n` +
      `  {% if template_js %}\n    {{ require_js(get_asset_url(template_js)) }}\n  {% endif %}`
  );

describe("setupTheme", () => {
  it("creates a fresh theme, patches base.html with template_css/js, and writes .hsignore", async () => {
    mockCwd();
    state.selectAnswers = ["create"];
    state.textAnswers = ["my-theme"];
    state.scaffoldImpl = (path) => {
      write(join(path, "templates/layouts/base.html"), BASE_HTML_UNPATCHED);
    };

    const info = await setupTheme();

    expect(info).toEqual({ themePath: join(tmp, "workspace", "my-theme"), themeName: "my-theme" });
    const baseHtml = readFileSync(join(info.themePath, "templates/layouts/base.html"), "utf8");
    expect(baseHtml).toContain("{% if template_css %}");
    expect(baseHtml).toContain("{{ require_css(get_asset_url(template_css)) }}");
    expect(baseHtml).toContain("{% if template_js %}");
    expect(baseHtml).toContain("{{ require_js(get_asset_url(template_js)) }}");
    const hsignore = readFileSync(join(info.themePath, ".hsignore"), "utf8");
    expect(hsignore).toContain("docs/");
    expect(hsignore).toContain("node_modules/");
  });

  it("leaves an already-compatible base.html untouched and appends docs/ to an existing .hsignore", async () => {
    mockCwd();
    state.selectAnswers = ["create"];
    state.textAnswers = ["ready-theme"];
    state.scaffoldImpl = (path) => {
      write(join(path, "templates/layouts/base.html"), BASE_HTML_PATCHED);
      writeFileSync(join(path, ".hsignore"), "*.log\n");
    };

    const info = await setupTheme();

    const baseHtml = readFileSync(join(info.themePath, "templates/layouts/base.html"), "utf8");
    expect(baseHtml).toBe(BASE_HTML_PATCHED); // no double patch
    expect(readFileSync(join(info.themePath, ".hsignore"), "utf8")).toBe("*.log\n\ndocs/\n");
  });

  it("exits when the scaffold produces no base.html", async () => {
    mockCwd();
    state.selectAnswers = ["create"];
    state.textAnswers = ["broken-theme"];
    state.scaffoldImpl = () => {}; // writes nothing

    await expect(setupTheme()).rejects.toThrow(ExitError);
    expect(errorLogs()).toContain("base.html not found");
  });

  it("exits when scaffold creation throws", async () => {
    mockCwd();
    state.selectAnswers = ["create"];
    state.textAnswers = ["fail-theme"];
    state.scaffoldImpl = () => { throw new Error("disk full"); };

    await expect(setupTheme()).rejects.toThrow(ExitError);
    expect(errorLogs()).toContain("disk full");
  });

  it("fetches an existing theme via the API when a PAK is configured", async () => {
    mockCwd();
    state.pak = "pat-na1-key";
    state.selectAnswers = ["fetch"];
    state.textAnswers = ["Remote-Theme"];
    state.fetchThemeImpl = async (pak, name, path) => {
      expect(pak).toBe("pat-na1-key");
      expect(name).toBe("Remote-Theme");
      write(join(path, "templates/layouts/base.html"), BASE_HTML_PATCHED);
    };

    const info = await setupTheme();

    expect(info.themeName).toBe("Remote-Theme");
    expect(state.runFileCalls).toHaveLength(0); // no CLI fallback
  });

  it("exits when the API fetch fails", async () => {
    mockCwd();
    state.pak = "pat-na1-key";
    state.selectAnswers = ["fetch"];
    state.textAnswers = ["Gone-Theme"];
    state.fetchThemeImpl = async () => { throw new Error("404 not found"); };

    await expect(setupTheme()).rejects.toThrow(ExitError);
    expect(errorLogs()).toContain("404 not found");
  });

  it("falls back to the hs CLI in CLI mode and exits when the fetch fails", async () => {
    mockCwd();
    state.config = { hubspotUploadMode: "cli" };
    state.selectAnswers = ["fetch"];
    state.textAnswers = ["Cli-Theme"];
    state.runFileImpl = () => ({ stdout: "", stderr: "", success: false });

    await expect(setupTheme()).rejects.toThrow(ExitError);
    expect(state.runFileCalls).toEqual([
      { file: "hs", args: ["cms", "fetch", "Cli-Theme", join(tmp, "workspace", "Cli-Theme")] },
    ]);
    expect(errorLogs()).toContain('Could not fetch theme "Cli-Theme"');
  });

  it("rejects unsafe theme names in the fetch prompt validator", async () => {
    mockCwd();
    state.pak = "pat-na1-key";
    state.selectAnswers = ["fetch"];
    state.textAnswers = ["Ok-Theme"];
    state.fetchThemeImpl = async (_pak, _name, path) => {
      write(join(path, "templates/layouts/base.html"), BASE_HTML_PATCHED);
    };

    await setupTheme();

    const validate = state.textCalls.find((c) => c.message.includes("theme name"))?.validate;
    expect(validate?.("../escape")).toBeTruthy();
    expect(validate?.("theme;rm")).toBeTruthy();
    expect(validate?.("")).toBeTruthy();
    expect(validate?.("My-Theme_2.0")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/** GeneratedAssets that pass every checklist item. */
function goodAssets() {
  return {
    sharedCss: ":root { --primary: #123456; } ".repeat(4),
    sharedJs: "document.addEventListener('scroll', () => {}); ".repeat(3),
    template: "<!-- templateType: page -->\n{% dnd_area 'main' %}{% end_dnd_area %}",
    modules: [
      {
        moduleName: "hero",
        fieldsJson: '[{"name": "heading", "type": "text", "tab": "STYLE"}]',
        metaJson: "{}",
        moduleHtml: "<div>{{ module.heading }}</div>",
        moduleCss: ".hero { color: red; }",
      },
    ],
  };
}

/** Theme dir with an annotated dnd_area template so the checklist passes. */
function makeConvertibleTheme(): string {
  const themePath = join(tmp, "theme");
  write(
    join(themePath, "templates/landing.html"),
    "<!--\n  templateType: page\n  isAvailableForNewContent: true\n-->\n{% dnd_area 'main' %}{% end_dnd_area %}\n"
  );
  return themePath;
}

describe("runConversion", () => {
  it("rejects unsupported engine types", async () => {
    await expect(
      runConversion({ aiEngine: "openai-api" as never, sourceDir: tmp, themePath: tmp })
    ).rejects.toThrow(/does not support the "openai-api" engine/);
  });

  it("runs the engine, surfaces progress, and returns the generated assets", async () => {
    const themePath = makeConvertibleTheme();
    const assets = goodAssets();
    state.convertImpl = async (opts) => {
      expect(opts.sourceDir).toBe(join(tmp, "src"));
      expect(opts.themePath).toBe(themePath);
      expect(opts.conversionGuide).toBe("CONVERSION GUIDE");
      opts.onProgress("created", "hero.module");
      opts.onProgress("working", "generating css");
      return assets;
    };

    const result = await runConversion({
      aiEngine: "claude-code",
      model: "opus",
      sourceDir: join(tmp, "src"),
      themePath,
    });

    expect(result).toBe(assets);
    expect(state.engineCtors).toEqual([{ type: "claude-code", model: "opus" }]);
    expect(state.logs.some((l) => l.level === "success" && l.message === "hero.module")).toBe(true);
  });

  it("legacy 'api' and 'claude-oauth' engines route to the Anthropic SDK engine", async () => {
    const themePath = makeConvertibleTheme();
    state.convertImpl = async () => goodAssets();

    await runConversion({ aiEngine: "api", sourceDir: tmp, themePath });
    await runConversion({ aiEngine: "claude-oauth", sourceDir: tmp, themePath });

    expect(state.engineCtors).toEqual([{ type: "anthropic-api" }, { type: "anthropic-api" }]);
  });

  it("aborts when critical checklist items fail and the user declines to continue", async () => {
    const themePath = join(tmp, "empty-theme");
    mkdirSync(themePath, { recursive: true });
    state.convertImpl = async () => ({ sharedCss: "", sharedJs: "", template: "", modules: [] });
    state.confirmAnswers = [false]; // "Continue with upload anyway?"

    await expect(
      runConversion({ aiEngine: "claude-code", sourceDir: tmp, themePath })
    ).rejects.toThrow("Conversion aborted due to critical checklist failures.");
  });

  it("deletes the conversion log when the user declines to keep it", async () => {
    const themePath = makeConvertibleTheme();
    const logPath = join(themePath, "..", "vibespot-conversion.log");
    writeFileSync(logPath, "log contents");
    state.convertImpl = async () => goodAssets();
    state.confirmAnswers = [false]; // "Keep conversion log file for debugging?"

    await runConversion({ aiEngine: "claude-code", sourceDir: tmp, themePath });

    expect(existsSync(logPath)).toBe(false);
  });
});

describe("validateAndFix", () => {
  function makeModule(themePath: string, name: string, fields: string, html = "<div></div>") {
    const dir = join(themePath, "modules", `${name}.module`);
    write(join(dir, "fields.json"), fields);
    write(join(dir, "module.html"), html);
    write(join(dir, "meta.json"), JSON.stringify({ host_template_types: ["PAGE"], is_available_for_new_content: true }));
    return dir;
  }

  it("rewrites textarea types, reserved names, string choices, bad link defaults, and now()", () => {
    const themePath = join(tmp, "theme");
    const dir = makeModule(
      themePath,
      "hero",
      JSON.stringify([
        { name: "name", type: "textarea", label: "Name" },
        { name: "layout", type: "choice", choices: ["left", "right"] },
        { name: "cta", type: "link", default: "https://example.com" },
      ]),
      "<div>{{ now() }}</div>"
    );

    const fixes = validateAndFix(themePath);

    const fields = JSON.parse(readFileSync(join(dir, "fields.json"), "utf8"));
    expect(fields[0].name).toBe("item_name");
    expect(fields[0].type).toBe("text");
    expect(fields[1].choices).toEqual([["left", "Left"], ["right", "Right"]]);
    expect(fields[2].default).toEqual({
      url: { href: "https://example.com", type: "EXTERNAL" },
      open_in_new_tab: false,
      no_follow: false,
    });
    expect(readFileSync(join(dir, "module.html"), "utf8")).toBe("<div>{{ local_dt }}</div>");
    expect(fixes.join("\n")).toContain('"textarea" → "text"');
    expect(fixes.join("\n")).toContain("now() → local_dt");
  });

  it("removes HubDB templates and reports invalid fields.json without crashing", () => {
    const themePath = join(tmp, "theme");
    makeModule(themePath, "broken", "{ not json");
    write(join(themePath, "templates/listing.html"), "{% for row in hubdb_table_rows(1) %}{% endfor %}");
    write(join(themePath, "templates/keep.html"), "<!-- templateType: page\nisAvailableForNewContent: true -->\n{% dnd_area 'a' %}{% end_dnd_area %}");

    const fixes = validateAndFix(themePath);

    expect(existsSync(join(themePath, "templates/listing.html"))).toBe(false);
    expect(existsSync(join(themePath, "templates/keep.html"))).toBe(true);
    expect(fixes.join("\n")).toContain("broken: fields.json has invalid JSON");
    expect(fixes.join("\n")).toContain("Removed listing.html");
  });

  it("fixes nested choice fields inside group children", () => {
    const themePath = join(tmp, "theme");
    const dir = makeModule(
      themePath,
      "cards",
      JSON.stringify([
        { name: "items", type: "group", children: [{ name: "align", type: "choice", choices: ["top"] }] },
      ])
    );

    validateAndFix(themePath);

    const fields = JSON.parse(readFileSync(join(dir, "fields.json"), "utf8"));
    expect(fields[0].children[0].choices).toEqual([["top", "Top"]]);
  });
});

describe("validateTemplates / validateModuleMeta", () => {
  it("prepends annotations to a dnd_area template that lacks them", () => {
    const themePath = join(tmp, "theme");
    const templatePath = join(themePath, "templates/landing-page.html");
    write(templatePath, "{% dnd_area 'main' %}{% end_dnd_area %}\n");

    validateTemplates(themePath);

    const content = readFileSync(templatePath, "utf8");
    expect(content).toMatch(/templateType: page/);
    expect(content).toMatch(/isAvailableForNewContent: true/);
    expect(content).toMatch(/label: Landing Page/);
  });

  it("leaves base.html and fully-annotated templates alone", () => {
    const themePath = join(tmp, "theme");
    write(join(themePath, "templates/base.html"), "{% dnd_area 'x' %}");
    const annotated = "<!--\n  templateType: page\n  isAvailableForNewContent: true\n  label: Done\n-->\n{% dnd_area 'main' %}";
    write(join(themePath, "templates/done.html"), annotated);

    validateTemplates(themePath);

    expect(readFileSync(join(themePath, "templates/base.html"), "utf8")).toBe("{% dnd_area 'x' %}");
    expect(readFileSync(join(themePath, "templates/done.html"), "utf8")).toBe(annotated);
  });

  it("patches meta.json so modules are available for pages", () => {
    const themePath = join(tmp, "theme");
    const metaPath = join(themePath, "modules/hero.module/meta.json");
    write(metaPath, JSON.stringify({ label: "Hero" }));

    validateModuleMeta(themePath);

    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.host_template_types).toEqual(["PAGE"]);
    expect(meta.is_available_for_new_content).toBe(true);
    expect(meta.label).toBe("Hero");
  });
});

// ---------------------------------------------------------------------------
// Uploader
// ---------------------------------------------------------------------------

describe("runUpload", () => {
  const themePath = () => join(tmp, "workspace", "my-theme");

  beforeEach(() => {
    mkdirSync(themePath(), { recursive: true });
  });

  it("API mode: returns true on a clean upload", async () => {
    state.pak = "pat-na1-key";
    state.uploadThemeResults = [{ success: true, uploaded: 12, errors: [] }];

    await expect(runUpload(themePath())).resolves.toBe(true);
    expect(state.uploadThemeCalls).toBe(1);
    expect(state.runFileCalls).toHaveLength(0);
  });

  it("API mode: auto-fixes a fixable error and succeeds on retry", async () => {
    state.pak = "pat-na1-key";
    state.uploadThemeResults = [
      { success: false, uploaded: 0, errors: [{ file: "f", status: 400, message: "bad" }] },
      { success: true, uploaded: 12, errors: [] },
    ];
    state.parsedErrors = [{ file: "hero.module/fields.json", message: "textarea not allowed", fixable: true }];
    state.autoFixResult = true;

    await expect(runUpload(themePath())).resolves.toBe(true);
    expect(state.autoFixCalls).toEqual(["textarea not allowed"]);
    expect(state.uploadThemeCalls).toBe(2);
  });

  it("CLI mode: uploads via `hs cms upload` with argv arrays", async () => {
    state.config = { hubspotUploadMode: "cli" };
    state.runFileImpl = () => ({
      stdout: "Uploaded file a.html\nUploaded file b.css\n",
      stderr: "",
      success: true,
    });

    await expect(runUpload(themePath())).resolves.toBe(true);
    expect(state.runFileCalls).toEqual([
      { file: "hs", args: ["cms", "upload", themePath(), "my-theme"] },
    ]);
    expect(state.uploadThemeCalls).toBe(0);
  });

  it("offers to continue when the failure is unknown but most files uploaded", async () => {
    state.config = { hubspotUploadMode: "cli" };
    state.runFileImpl = () => ({
      stdout: "Uploaded file a.html\nUploaded file b.css\n",
      stderr: "something exploded",
      success: false,
    });
    state.parsedErrors = []; // unknown error
    state.confirmAnswers = [true]; // "Continue anyway (theme is likely uploaded)?"

    await expect(runUpload(themePath())).resolves.toBe(true);
  });

  it("cleans up stuck modules and fails after exhausting retries on unfixable errors", async () => {
    state.pak = "pat-na1-key";
    state.uploadThemeResults = [
      { success: false, uploaded: 0, errors: [{ file: "f", status: 500, message: "boom" }] },
      { success: false, uploaded: 0, errors: [{ file: "f", status: 500, message: "boom" }] },
      { success: false, uploaded: 0, errors: [{ file: "f", status: 500, message: "boom" }] },
    ];
    state.parsedErrors = [{ file: "hero.module", message: "server rejected module", fixable: false }];

    await expect(runUpload(themePath())).resolves.toBe(false);
    expect(state.uploadThemeCalls).toBe(3);
    expect(state.deleteFileCalls[0]).toBe("my-theme/modules");
    expect(errorLogs()).toContain("Upload failed after multiple attempts.");
  });

  it("stops retrying when the user declines another attempt", async () => {
    state.pak = "pat-na1-key";
    state.uploadThemeResults = [
      { success: false, uploaded: 0, errors: [{ file: "f", status: 500, message: "boom" }] },
    ];
    state.parsedErrors = []; // unknown error, nothing uploaded
    state.confirmAnswers = [false]; // decline "Try uploading again?"

    await expect(runUpload(themePath())).resolves.toBe(false);
    expect(state.uploadThemeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

describe("showNextSteps", () => {
  function opts(overrides: Partial<Parameters<typeof showNextSteps>[0]> = {}) {
    return {
      portalId: "123",
      sourceDir: join(tmp, "cloned-source"),
      themePath: join(tmp, "theme-out"),
      wasCloned: false,
      ...overrides,
    };
  }

  it("opens the regional EU landing-pages URL when confirmed", async () => {
    state.dataCenter = "eu1";
    state.confirmAnswers = [true]; // open browser (no dirs exist → no cleanup prompt)

    await showNextSteps(opts());

    const url = "https://app-eu1.hubspot.com/page-ui/123/management/pages/landing";
    expect(state.execCalls.flat(2)).toContain(url);
  });

  it("uses the default host for na1 portals and skips the browser when declined", async () => {
    state.confirmAnswers = [false];

    await showNextSteps(opts());

    expect(state.execCalls).toHaveLength(0);
  });

  it("falls back to printing the URL when the browser cannot be opened", async () => {
    state.execThrows = true;
    state.confirmAnswers = [true];

    await showNextSteps(opts());

    const printed = state.logs.find((l) => l.level === "log");
    expect(printed?.message).toContain("https://app.hubspot.com/page-ui/123/management/pages/landing");
  });

  it("removes the cloned source and theme dirs when cleanup is confirmed", async () => {
    const o = opts({ wasCloned: true });
    mkdirSync(o.sourceDir, { recursive: true });
    mkdirSync(o.themePath, { recursive: true });
    state.confirmAnswers = [false, true]; // skip browser, confirm cleanup

    await showNextSteps(o);

    expect(existsSync(o.sourceDir)).toBe(false);
    expect(existsSync(o.themePath)).toBe(false);
  });

  it("never offers to delete a local (non-cloned) source directory", async () => {
    const o = opts({ wasCloned: false });
    mkdirSync(o.sourceDir, { recursive: true });
    mkdirSync(o.themePath, { recursive: true });
    state.confirmAnswers = [false, true];

    await showNextSteps(o);

    expect(existsSync(o.sourceDir)).toBe(true); // user's own code is untouched
    expect(existsSync(o.themePath)).toBe(false);
  });

  it("keeps directories when cleanup is declined", async () => {
    const o = opts({ wasCloned: true });
    mkdirSync(o.sourceDir, { recursive: true });
    mkdirSync(o.themePath, { recursive: true });
    state.confirmAnswers = [false, false];

    await showNextSteps(o);

    expect(existsSync(o.sourceDir)).toBe(true);
    expect(existsSync(o.themePath)).toBe(true);
  });
});
