/**
 * Behavioral coverage for src/server/routes/settings.ts (VIB-1900).
 *
 * Focus: the API-key store/retrieve/delete path (handleSettingsApiKeyRoute)
 * and the fast status route (handleSettingsStatusRoute). These routes touch
 * credential storage so they get first-class test coverage.
 *
 * Strategy: mock `../../utils/config.js` so no real ~/.vibespot/config.json is
 * touched. Build minimal IncomingMessage / ServerResponse stubs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Lightweight HTTP stubs
// ---------------------------------------------------------------------------

function makeReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const ee = new EventEmitter() as unknown as IncomingMessage;
  (ee as any).headers = { "content-type": "application/json", ...headers };
  (ee as any).url = "/api/settings/apikey";
  (ee as any).method = "POST";
  process.nextTick(() => {
    ee.emit("data", Buffer.from(body));
    ee.emit("end");
  });
  return ee;
}

function makeRes(): { res: ServerResponse; result: () => { status: number; body: unknown } } {
  let captured = { status: 0, body: {} as unknown };
  const res = {
    writeHead: (status: number, _headers?: unknown) => { captured.status = status; },
    end: (body?: string) => { try { captured.body = JSON.parse(body ?? "{}"); } catch { captured.body = body; } },
  } as unknown as ServerResponse;
  return { res, result: () => captured };
}

// ---------------------------------------------------------------------------
// Config mock
// ---------------------------------------------------------------------------

const mockConfig: Record<string, unknown> = {};

vi.mock("../src/utils/config.js", () => ({
  loadConfig: () => ({ ...mockConfig }),
  saveConfig: (update: Record<string, unknown>) => Object.assign(mockConfig, update),
  getApiKeyForEngine: (_e: string, _c: unknown) => null,
  addHubSpotAccount: vi.fn(),
  removeHubSpotAccount: vi.fn(),
  setActiveHubSpotAccount: vi.fn(),
  setCliToolEnabled: vi.fn(),
}));

vi.mock("../src/utils/detect.js", () => ({
  detectEnvironmentLite: () => ({
    apiKeys: { anthropic: false, openai: false, gemini: false, langfusePublic: false, langfuseSecret: false },
    claudeCode: { available: false },
    geminiCli: { available: false },
    codexCli: { available: false },
    hubspot: { accounts: [], activeAccount: null },
    github: { available: false },
  }),
  detectEnvironment: vi.fn(),
  detectAITools: vi.fn(),
  detectPlatformTools: vi.fn(),
  detectHubSpotCLI: vi.fn(),
  detectHubSpotAuth: vi.fn(),
  detectGitHubCLI: vi.fn(),
  detectGitHubAuth: vi.fn(),
}));

vi.mock("../src/server/session.js", () => ({
  listSessions: () => [],
  getSession: () => null,
  addSessionAsset: vi.fn(),
}));

vi.mock("../src/server/routes/setup.js", () => ({
  getLocalThemes: () => [],
}));

vi.mock("../src/utils/fs.js", () => ({
  getVersion: () => "1.0.0-test",
  fileExists: () => false,
  readFile: () => "",
  writeFile: vi.fn(),
  resolveAsset: vi.fn(),
}));

vi.mock("../src/hubspot/api.js", () => ({
  validatePak: vi.fn(),
}));

vi.mock("../src/server/process-manager.js", () => ({
  startJob: vi.fn(),
  startJobSafe: vi.fn(),
  getJob: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleSettingsApiKeyRoute — credential storage", () => {
  beforeEach(() => {
    Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
  });

  it("stores an anthropic API key", async () => {
    const { handleSettingsApiKeyRoute } = await import("../src/server/routes/settings.js");
    const { res, result } = makeRes();
    const req = makeReq(JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-test-key" }));
    await new Promise<void>((resolve) => {
      const origEnd = (res as any).end.bind(res);
      (res as any).end = (body?: string) => { origEnd(body); resolve(); };
      handleSettingsApiKeyRoute(req, res);
    });
    expect(result().status).toBe(200);
    expect((result().body as any).ok).toBe(true);
    expect(mockConfig.anthropicApiKey).toBe("sk-ant-test-key");
  });

  it("clears a key when apiKey is empty/falsy", async () => {
    mockConfig.openaiApiKey = "old-key";
    const { handleSettingsApiKeyRoute } = await import("../src/server/routes/settings.js");
    const { res, result } = makeRes();
    const req = makeReq(JSON.stringify({ provider: "openai", apiKey: "" }));
    await new Promise<void>((resolve) => {
      const origEnd = (res as any).end.bind(res);
      (res as any).end = (body?: string) => { origEnd(body); resolve(); };
      handleSettingsApiKeyRoute(req, res);
    });
    expect(result().status).toBe(200);
    expect((result().body as any).deleted).toBe(true);
    expect(mockConfig.openaiApiKey).toBe("");
  });

  it("rejects an unknown provider", async () => {
    const { handleSettingsApiKeyRoute } = await import("../src/server/routes/settings.js");
    const { res, result } = makeRes();
    const req = makeReq(JSON.stringify({ provider: "hackertools", apiKey: "x" }));
    await new Promise<void>((resolve) => {
      const origEnd = (res as any).end.bind(res);
      (res as any).end = (body?: string) => { origEnd(body); resolve(); };
      handleSettingsApiKeyRoute(req, res);
    });
    expect(result().status).toBe(400);
    expect((result().body as any).error).toMatch(/Unknown provider/);
  });

  it("rejects missing provider field", async () => {
    const { handleSettingsApiKeyRoute } = await import("../src/server/routes/settings.js");
    const { res, result } = makeRes();
    const req = makeReq(JSON.stringify({ apiKey: "foo" }));
    await new Promise<void>((resolve) => {
      const origEnd = (res as any).end.bind(res);
      (res as any).end = (body?: string) => { origEnd(body); resolve(); };
      handleSettingsApiKeyRoute(req, res);
    });
    expect(result().status).toBe(400);
    expect((result().body as any).error).toMatch(/provider is required/);
  });

  it("auto-selects the engine when none is set", async () => {
    // no aiEngine in config — adding a gemini key should auto-select gemini-api
    const { handleSettingsApiKeyRoute } = await import("../src/server/routes/settings.js");
    const { res, result } = makeRes();
    const req = makeReq(JSON.stringify({ provider: "gemini", apiKey: "gemini-key-123" }));
    await new Promise<void>((resolve) => {
      const origEnd = (res as any).end.bind(res);
      (res as any).end = (body?: string) => { origEnd(body); resolve(); };
      handleSettingsApiKeyRoute(req, res);
    });
    expect(result().status).toBe(200);
    expect((result().body as any).autoSelectedEngine).toBe("gemini-api");
    expect(mockConfig.aiEngine).toBe("gemini-api");
  });

  it("does NOT override an existing engine choice", async () => {
    mockConfig.aiEngine = "claude-code";
    const { handleSettingsApiKeyRoute } = await import("../src/server/routes/settings.js");
    const { res, result } = makeRes();
    const req = makeReq(JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-another" }));
    await new Promise<void>((resolve) => {
      const origEnd = (res as any).end.bind(res);
      (res as any).end = (body?: string) => { origEnd(body); resolve(); };
      handleSettingsApiKeyRoute(req, res);
    });
    expect((result().body as any).autoSelectedEngine).toBeNull();
    expect(mockConfig.aiEngine).toBe("claude-code");
  });

  it("stores langfuse public + secret keys", async () => {
    const { handleSettingsApiKeyRoute } = await import("../src/server/routes/settings.js");
    for (const [provider, field] of [
      ["langfuse-public", "langfusePublicKey"],
      ["langfuse-secret", "langfuseSecretKey"],
    ] as const) {
      const { res, result } = makeRes();
      const req = makeReq(JSON.stringify({ provider, apiKey: `test-${provider}` }));
      await new Promise<void>((resolve) => {
        const origEnd = (res as any).end.bind(res);
        (res as any).end = (body?: string) => { origEnd(body); resolve(); };
        handleSettingsApiKeyRoute(req, res);
      });
      expect(result().status).toBe(200);
      expect(mockConfig[field]).toBe(`test-${provider}`);
    }
  });
});

describe("handleSettingsStatusRoute — fast config read", () => {
  beforeEach(() => {
    Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
  });

  it("returns 200 with version, models, sessionCount", async () => {
    const { handleSettingsStatusRoute } = await import("../src/server/routes/settings.js");
    const { res, result } = makeRes();
    handleSettingsStatusRoute(res);
    // synchronous — no body drain needed
    expect(result().status).toBe(200);
    const body = result().body as any;
    expect(body.version).toBe("1.0.0-test");
    expect(body.sessionCount).toBe(0);
    expect(body.models).toBeDefined();
    expect(body.config).toBeDefined();
  });

  it("masks figmaToken to last-4 only", async () => {
    mockConfig.figmaToken = "figa-supersecrettoken";
    const { handleSettingsStatusRoute } = await import("../src/server/routes/settings.js");
    const { res, result } = makeRes();
    handleSettingsStatusRoute(res);
    const cfg = (result().body as any).config;
    expect(cfg.figmaToken).not.toBe("figa-supersecrettoken");
    expect(cfg.figmaToken).toMatch(/••••/);
    expect(cfg.figmaToken).toMatch(/oken$/); // last 4 of "supersecrettoken"
  });

  it("returns null figmaToken when not set", async () => {
    const { handleSettingsStatusRoute } = await import("../src/server/routes/settings.js");
    const { res, result } = makeRes();
    handleSettingsStatusRoute(res);
    expect((result().body as any).config.figmaToken).toBeNull();
  });
});
