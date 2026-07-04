import { describe, it, expect, afterEach } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  resolveSecurityConfig,
  checkDisabledAuthBind,
  checkRequestAuth,
  isAllowedOrigin,
  isLocalHostHeader,
  isLoopbackAddress,
  isLoopbackHost,
  AUTH_COOKIE,
  type SecurityConfig,
} from "../src/server/security.js";
import { publicErrorMessage } from "../src/server/errors.js";
import { homedir } from "node:os";

function fakeReq(opts: {
  remoteAddress?: string;
  host?: string;
  url?: string;
  authorization?: string;
  xToken?: string;
  cookie?: string;
}): IncomingMessage {
  return {
    url: opts.url || "/",
    headers: {
      host: opts.host ?? "localhost:4200",
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
      ...(opts.xToken ? { "x-vibespot-token": opts.xToken } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" },
  } as unknown as IncomingMessage;
}

const ENV_KEYS = ["VIBESPOT_HOST", "VIBESPOT_AUTH_TOKEN", "VIBESPOT_DISABLE_AUTH", "VIBESPOT_TRUST_PROXY"];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveSecurityConfig", () => {
  it("defaults to loopback bind with no token", () => {
    delete process.env.VIBESPOT_HOST;
    delete process.env.VIBESPOT_AUTH_TOKEN;
    delete process.env.VIBESPOT_DISABLE_AUTH;
    const cfg = resolveSecurityConfig();
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.authToken).toBeNull();
  });

  it("generates a token for a networked bind", () => {
    delete process.env.VIBESPOT_AUTH_TOKEN;
    delete process.env.VIBESPOT_DISABLE_AUTH;
    const cfg = resolveSecurityConfig("0.0.0.0");
    expect(cfg.authToken).toMatch(/^[0-9a-f]{48}$/);
    expect(cfg.generatedToken).toBe(true);
  });

  it("uses the operator-provided token", () => {
    process.env.VIBESPOT_AUTH_TOKEN = "secret-token";
    const cfg = resolveSecurityConfig("0.0.0.0");
    expect(cfg.authToken).toBe("secret-token");
    expect(cfg.generatedToken).toBe(false);
  });

  it("VIBESPOT_DISABLE_AUTH turns the gate off even when networked", () => {
    process.env.VIBESPOT_DISABLE_AUTH = "1";
    const cfg = resolveSecurityConfig("0.0.0.0");
    expect(cfg.authToken).toBeNull();
    expect(cfg.authDisabled).toBe(true);
  });
});

describe("checkDisabledAuthBind (VIB-1906)", () => {
  it("refuses a non-loopback bind with auth disabled and no acknowledgement", () => {
    delete process.env.VIBESPOT_TRUST_PROXY;
    process.env.VIBESPOT_DISABLE_AUTH = "1";
    const gate = checkDisabledAuthBind(resolveSecurityConfig("0.0.0.0"));
    expect(gate.severity).toBe("refuse");
    expect(gate.message).toContain("VIBESPOT_TRUST_PROXY=1");
    expect(gate.message).toContain("0.0.0.0");
  });

  it("downgrades to a loud warning when VIBESPOT_TRUST_PROXY=1 acknowledges the proxy", () => {
    process.env.VIBESPOT_DISABLE_AUTH = "1";
    process.env.VIBESPOT_TRUST_PROXY = "1";
    const gate = checkDisabledAuthBind(resolveSecurityConfig("0.0.0.0"));
    expect(gate.severity).toBe("warn");
    expect(gate.message).toContain("AUTH IS DISABLED");
  });

  it("is silent for a loopback bind with auth disabled", () => {
    delete process.env.VIBESPOT_TRUST_PROXY;
    process.env.VIBESPOT_DISABLE_AUTH = "1";
    const gate = checkDisabledAuthBind(resolveSecurityConfig("127.0.0.1"));
    expect(gate.severity).toBe("none");
    expect(gate.message).toBeNull();
  });

  it("is silent when auth is enabled, even on a networked bind", () => {
    delete process.env.VIBESPOT_DISABLE_AUTH;
    delete process.env.VIBESPOT_TRUST_PROXY;
    const gate = checkDisabledAuthBind(resolveSecurityConfig("0.0.0.0"));
    expect(gate.severity).toBe("none");
  });
});

describe("checkRequestAuth", () => {
  const tokenCfg: SecurityConfig = {
    host: "0.0.0.0",
    authToken: "tok-123",
    generatedToken: false,
    authDisabled: false,
  };
  const loopbackCfg: SecurityConfig = {
    host: "127.0.0.1",
    authToken: null,
    generatedToken: false,
    authDisabled: false,
  };

  it("trusts loopback requests with a local Host header", () => {
    expect(checkRequestAuth(fakeReq({}), loopbackCfg).ok).toBe(true);
  });

  it("rejects DNS-rebound loopback requests (foreign Host header)", () => {
    expect(checkRequestAuth(fakeReq({ host: "evil.example.com" }), loopbackCfg).ok).toBe(false);
  });

  it("rejects non-loopback requests without a token", () => {
    expect(checkRequestAuth(fakeReq({ remoteAddress: "192.168.1.50" }), tokenCfg).ok).toBe(false);
  });

  it("accepts Bearer token", () => {
    const r = checkRequestAuth(
      fakeReq({ remoteAddress: "192.168.1.50", authorization: "Bearer tok-123" }),
      tokenCfg,
    );
    expect(r.ok).toBe(true);
  });

  it("accepts X-Vibespot-Token header", () => {
    expect(checkRequestAuth(fakeReq({ remoteAddress: "10.0.0.9", xToken: "tok-123" }), tokenCfg).ok).toBe(true);
  });

  it("accepts the session cookie", () => {
    expect(
      checkRequestAuth(
        fakeReq({ remoteAddress: "10.0.0.9", cookie: `other=1; ${AUTH_COOKIE}=tok-123` }),
        tokenCfg,
      ).ok,
    ).toBe(true);
  });

  it("accepts ?token= and reports viaQueryToken", () => {
    const r = checkRequestAuth(
      fakeReq({ remoteAddress: "10.0.0.9", url: "/?token=tok-123" }),
      tokenCfg,
    );
    expect(r.ok).toBe(true);
    expect(r.viaQueryToken).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(
      checkRequestAuth(fakeReq({ remoteAddress: "10.0.0.9", authorization: "Bearer nope" }), tokenCfg).ok,
    ).toBe(false);
  });

  it("allows everything when auth is explicitly disabled", () => {
    const cfg: SecurityConfig = { host: "0.0.0.0", authToken: null, generatedToken: false, authDisabled: true };
    expect(checkRequestAuth(fakeReq({ remoteAddress: "203.0.113.7", host: "app.example.com" }), cfg).ok).toBe(true);
  });
});

describe("isAllowedOrigin", () => {
  it("allows missing Origin (non-browser clients)", () => {
    expect(isAllowedOrigin(undefined, "localhost:4200")).toBe(true);
  });

  it("allows same-origin", () => {
    expect(isAllowedOrigin("https://app.example.com", "app.example.com")).toBe(true);
  });

  it("allows localhost and private-range origins", () => {
    expect(isAllowedOrigin("http://localhost:4200", "localhost:4200")).toBe(true);
    expect(isAllowedOrigin("http://192.168.1.20:4200", "localhost:4200")).toBe(true);
    expect(isAllowedOrigin("http://100.64.1.2:4200", "localhost:4200")).toBe(true);
    expect(isAllowedOrigin("http://172.20.0.5:4200", "localhost:4200")).toBe(true);
  });

  it("rejects foreign origins (CSWSH)", () => {
    expect(isAllowedOrigin("https://evil.example.com", "localhost:4200")).toBe(false);
    expect(isAllowedOrigin("null", "localhost:4200")).toBe(false);
    expect(isAllowedOrigin("file://x", "localhost:4200")).toBe(false);
  });
});

describe("host helpers", () => {
  it("classifies loopback addresses and hosts", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.4")).toBe(false);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("accepts the configured bind host as a local Host header", () => {
    const cfg: SecurityConfig = { host: "myserver.internal", authToken: "t", generatedToken: false, authDisabled: false };
    expect(isLocalHostHeader("myserver.internal:4200", cfg)).toBe(true);
    expect(isLocalHostHeader("evil.example.com", cfg)).toBe(false);
  });
});

describe("publicErrorMessage", () => {
  it("redacts the home directory", () => {
    const msg = publicErrorMessage(new Error(`ENOENT: no such file, open '${homedir()}/themes/x.css'`));
    expect(msg).not.toContain(homedir());
    expect(msg).toContain("~");
  });

  it("redacts foreign /home and /Users paths", () => {
    expect(publicErrorMessage(new Error("EACCES: /home/boris/secret"))).not.toContain("boris");
    expect(publicErrorMessage(new Error("EACCES: /Users/boris/secret"))).not.toContain("boris");
  });

  it("stringifies non-Error values", () => {
    expect(publicErrorMessage("plain failure")).toBe("plain failure");
  });
});
