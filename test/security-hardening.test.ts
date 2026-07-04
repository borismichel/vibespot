import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  downloadFigmaImage,
  encodeFigmaNodeIds,
  parseFigmaUrl,
  isAllowedFigmaImageDownloadUrl,
} from "../src/server/figma/extractor.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("credential file hardening", () => {
  it("writes the config directory and credentials file with private POSIX permissions", async () => {
    if (process.platform === "win32") return;

    const home = mkdtempSync(join(tmpdir(), "vibespot-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();

    const { saveConfig, getConfigDir } = await import("../src/utils/config.js");
    saveConfig({ anthropicApiKey: "test-secret" });

    const configDir = getConfigDir();
    const configPath = join(configDir, "config.json");
    expect(readFileSync(configPath, "utf-8")).toContain("test-secret");
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    rmSync(home, { recursive: true, force: true });
  });

  it("writes the Claude OAuth token file with private POSIX permissions", async () => {
    if (process.platform === "win32") return;

    const home = mkdtempSync(join(tmpdir(), "vibespot-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();

    const { saveInitialToken } = await import("../src/utils/claude-oauth.js");
    saveInitialToken("sk-ant-oat01-test", "refresh-test");

    const tokenDir = join(home, ".vibespot");
    const tokenPath = join(tokenDir, "claude-oauth.json");
    expect(readFileSync(tokenPath, "utf-8")).toContain("sk-ant-oat01-test");
    expect(statSync(tokenDir).mode & 0o777).toBe(0o700);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

    rmSync(home, { recursive: true, force: true });
  });
});

describe("HubSpot PAK token cache hardening", () => {
  it("caches exchanged tokens without retaining the raw PAK as the cache key", async () => {
    vi.resetModules();
    const pak = "pat-eu1-secret-value";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/localdevauth/v1/auth/refresh")) {
        return new Response(JSON.stringify({
          oauthAccessToken: "access-token",
          expiresAtMillis: Date.now() + 60 * 60 * 1000,
          hubId: 123,
          hubName: "Portal",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/account-info/v3/details")) {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
        return new Response(JSON.stringify({ portalId: 123, uiDomain: "portal.example" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const {
      validatePak,
      clearHubSpotTokenCacheForTest,
      getHubSpotTokenCacheKeysForTest,
    } = await import("../src/hubspot/api.js");

    clearHubSpotTokenCacheForTest();
    await validatePak(pak);
    await validatePak(pak);

    const keys = getHubSpotTokenCacheKeysForTest();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(keys[0]).not.toContain(pak);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not cache malformed successful token exchange responses", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/localdevauth/v1/auth/refresh")) {
        return new Response(JSON.stringify({ expiresAtMillis: Date.now() + 60 * 60 * 1000 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const {
      validatePak,
      clearHubSpotTokenCacheForTest,
      getHubSpotTokenCacheKeysForTest,
    } = await import("../src/hubspot/api.js");

    clearHubSpotTokenCacheForTest();
    await expect(validatePak("pat-eu1-malformed")).rejects.toThrow("invalid token payload");
    expect(getHubSpotTokenCacheKeysForTest()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Figma import SSRF hardening", () => {
  it("only parses real HTTPS Figma design URLs", () => {
    expect(parseFigmaUrl("https://www.figma.com/design/AbC123/My-File?node-id=12-34")).toEqual({
      fileKey: "AbC123",
      fileName: "My File",
      nodeId: "12:34",
    });
    expect(parseFigmaUrl("http://www.figma.com/design/AbC123/My-File")).toBeNull();
    expect(parseFigmaUrl("https://evil.example/?next=https://www.figma.com/design/AbC123/My-File")).toBeNull();
    expect(parseFigmaUrl("https://www.figma.com/design/AbC123/My-File?node-id=12-34%26depth=99")).toBeNull();
    expect(encodeFigmaNodeIds(["12:34", "I56:78"])).toBe("12%3A34,I56%3A78");
  });

  it("only allows image downloads from known Figma CDN hosts over HTTPS", () => {
    expect(isAllowedFigmaImageDownloadUrl("https://s3-alpha-sig.figma.com/img/abc.png?Expires=1")).toBe(true);
    expect(isAllowedFigmaImageDownloadUrl("https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc.png")).toBe(true);
    expect(isAllowedFigmaImageDownloadUrl("http://s3-alpha-sig.figma.com/img/abc.png")).toBe(false);
    expect(isAllowedFigmaImageDownloadUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedFigmaImageDownloadUrl("https://s3-alpha-sig.figma.com.evil.example/img/abc.png")).toBe(false);
  });

  it("rejects oversized Figma image downloads before writing them", async () => {
    const destDir = mkdtempSync(join(tmpdir(), "vibespot-figma-"));
    const destPath = join(destDir, "asset.png");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(26 * 1024 * 1024),
      },
    })));

    await expect(downloadFigmaImage("https://s3-alpha-sig.figma.com/img/asset.png", destPath))
      .rejects.toThrow("exceeds");
    expect(existsSync(destPath)).toBe(false);

    rmSync(destDir, { recursive: true, force: true });
  });
});
