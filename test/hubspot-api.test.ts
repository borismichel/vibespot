/**
 * Behavioral coverage for the HubSpot CMS Source Code API client (VIB-1900).
 *
 * This path touches customer credentials (the Personal Access Key), the OAuth
 * token exchange, and pushes theme files into customer portals — it had zero
 * tests. Everything here mocks `fetch` by URL, so no real HubSpot call is made.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectDataCenterFromPak,
  validatePak,
  uploadFile,
} from "../src/hubspot/api.js";

// A minimal Response-like stub good enough for the client (reads .ok/.status
// and either .json() or .text()).
function res(
  status: number,
  jsonBody: unknown,
  textBody = typeof jsonBody === "string" ? jsonBody : JSON.stringify(jsonBody),
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
    text: async () => textBody,
  };
}

const TOKEN_OK = {
  oauthAccessToken: "access-tok-abc",
  expiresAtMillis: Date.now() + 60 * 60 * 1000, // 1h out → cached, not refreshed
  hubId: 4242,
  hubName: "Acme Portal",
};

// Dispatch a mocked fetch by URL so tests are robust to call order / retries.
function installFetch(handlers: {
  refresh?: () => unknown;
  account?: () => unknown;
  upload?: () => unknown;
}) {
  const calls = { refresh: 0, account: 0, upload: 0 };
  const impl = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/localdevauth/v1/auth/refresh")) {
      calls.refresh++;
      return (handlers.refresh ?? (() => res(200, TOKEN_OK)))();
    }
    if (u.includes("/account-info/v3/details")) {
      calls.account++;
      return (handlers.account ?? (() => res(200, { portalId: 4242, uiDomain: "acme.hubspot.com" })))();
    }
    if (u.includes("/cms/v3/source-code/")) {
      calls.upload++;
      return (handlers.upload ?? (() => res(200, {})))();
    }
    throw new Error(`unexpected fetch to ${u}`);
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

// Unique PAK per test so the module-level token cache never bleeds between tests.
let pakSeq = 0;
function freshPak(prefix = "pat-na1-") {
  return `${prefix}test-${++pakSeq}-${"x".repeat(20)}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("detectDataCenterFromPak", () => {
  it("reads eu1 from a modern pat-eu1- key", () => {
    expect(detectDataCenterFromPak("pat-eu1-abc")).toBe("eu1");
  });
  it("reads na1 from a modern pat-na1- key", () => {
    expect(detectDataCenterFromPak("pat-na1-abc")).toBe("na1");
  });
  it("reads eu1 from the legacy base64 prefix", () => {
    expect(detectDataCenterFromPak("CiRldTExsomething")).toBe("eu1");
  });
  it("defaults to na1 for unrecognized keys", () => {
    expect(detectDataCenterFromPak("whatever-else")).toBe("na1");
  });
});

describe("validatePak", () => {
  it("returns portal identity + data center on a valid key", async () => {
    installFetch({});
    const pak = freshPak("pat-eu1-");
    const info = await validatePak(pak);
    expect(info.portalId).toBe("4242");
    expect(info.portalName).toBe("Acme Portal"); // prefers token hubName
    expect(info.dataCenter).toBe("eu1");
  });

  it("throws a friendly message when the PAK is rejected (401)", async () => {
    installFetch({ refresh: () => res(401, "", "unauthorized") });
    await expect(validatePak(freshPak())).rejects.toThrow(
      "Invalid or expired Personal Access Key",
    );
  });

  it("surfaces the status on a non-auth token-exchange failure (500)", async () => {
    installFetch({ refresh: () => res(500, "", "upstream boom") });
    await expect(validatePak(freshPak())).rejects.toThrow(/Token exchange failed \(500\)/);
  });

  it("throws when the token is valid but account-info fails", async () => {
    installFetch({ account: () => res(403, { message: "forbidden" }) });
    await expect(validatePak(freshPak())).rejects.toThrow(/Failed to get account info/);
  });

  it("caches the token — a second validate with the same PAK does not re-exchange", async () => {
    const calls = installFetch({});
    const pak = freshPak();
    await validatePak(pak);
    await validatePak(pak);
    expect(calls.refresh).toBe(1); // token reused from cache on the 2nd call
    expect(calls.account).toBe(2); // account-info is still fetched each time
  });
});

describe("uploadFile", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vibespot-hs-"));
    file = join(dir, "style.css");
    writeFileSync(file, ".x { color: red; }");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns success for an accepted upload", async () => {
    installFetch({});
    const result = await uploadFile(freshPak(), "modules/hero/module.css", file);
    expect(result.success).toBe(true);
    expect(result.path).toBe("modules/hero/module.css");
    expect(result.error).toBeUndefined();
  });

  it("returns a structured error (not a throw) when HubSpot rejects the upload", async () => {
    installFetch({ upload: () => res(400, { message: "bad path", category: "VALIDATION_ERROR" }) });
    const result = await uploadFile(freshPak(), "bad/../path.css", file);
    expect(result.success).toBe(false);
    expect(result.error?.status).toBe(400);
  });
});
