import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startPreviewOrigin,
  injectPreviewAgent,
  rewriteThemeAssetUrls,
  type StartedPreviewOrigin,
} from "../src/server/preview-origin.js";

const TOKEN = "test-preview-token-0123456789abcdef";

let uiDir: string;
let origin: StartedPreviewOrigin;
let base: string;

beforeAll(async () => {
  uiDir = mkdtempSync(join(tmpdir(), "vs-preview-origin-"));
  writeFileSync(join(uiDir, "preview-agent.js"), "/* trusted agent stub */\n");
  origin = await startPreviewOrigin({
    port: 43310,
    host: "127.0.0.1",
    frameAncestors: ["http://127.0.0.1:3201"],
    uiDir,
    token: TOKEN,
  });
  base = `http://127.0.0.1:${origin.port}`;
});

afterAll(() => {
  origin?.close();
  rmSync(uiDir, { recursive: true, force: true });
});

describe("preview-origin server", () => {
  it("serves the composed preview doc with a valid token", async () => {
    const res = await fetch(`${base}/?t=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    // Trusted agent bootstrap is prepended into <head>.
    expect(html).toContain('id="vs-preview-config"');
    expect(html).toContain('src="/preview-agent.js"');
    // Config carries the handshake token for the in-frame agent.
    expect(html).toContain(TOKEN);
  });

  it("pins the trust story in the CSP header", async () => {
    const res = await fetch(`${base}/?t=${TOKEN}`);
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).toContain("connect-src 'none'"); // AI script cannot call home
    expect(csp).toContain("frame-ancestors http://127.0.0.1:3201"); // only the app embeds
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it("rejects a missing or wrong token on the preview doc", async () => {
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/?t=wrong`)).status).toBe(401);
    // Same-length wrong token still rejects (timing-safe compare path).
    expect((await fetch(`${base}/?t=${"x".repeat(TOKEN.length)}`)).status).toBe(401);
  });

  it("serves the trusted agent script without a token", async () => {
    const res = await fetch(`${base}/preview-agent.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("trusted agent stub");
  });

  it("serves NO privileged route — /api/* does not exist on this origin", async () => {
    // Security acceptance item: the preview origin must not expose any app API.
    for (const path of [
      "/api/settings/apikey",
      "/api/upload",
      "/api/modules",
      "/api/field",
      "/api/starters",
      `/api/settings/apikey?t=${TOKEN}`,
    ]) {
      const getRes = await fetch(`${base}${path}`);
      expect(getRes.status, `GET ${path}`).toBe(404);
      const postRes = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(postRes.status, `POST ${path}`).toBe(404);
    }
  });

  it("does not serve app static files or docs", async () => {
    for (const path of ["/index.html", "/settings.js", "/docs/", "/chat.js"]) {
      const res = await fetch(`${base}${path}?t=${TOKEN}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("gates theme assets on the token and contains traversal", async () => {
    // No token → 401 before any session/path logic runs.
    expect((await fetch(`${base}/theme-assets/logo.png`)).status).toBe(401);
    // Valid token, no session → 404 (nothing to leak).
    expect((await fetch(`${base}/theme-assets/logo.png?t=${TOKEN}`)).status).toBe(404);
    // Traversal attempts die in containment (404), never 200.
    const evil = await fetch(`${base}/theme-assets/..%2f..%2f..%2fetc%2fpasswd?t=${TOKEN}`);
    expect(evil.status).toBe(404);
  });
});

describe("preview doc composition helpers", () => {
  it("injects the agent bootstrap at the top of <head>", () => {
    const out = injectPreviewAgent("<!DOCTYPE html><html><head><title>x</title></head><body></body></html>", "tok");
    const headIdx = out.indexOf("<head>");
    const configIdx = out.indexOf("vs-preview-config");
    const titleIdx = out.indexOf("<title>");
    expect(configIdx).toBeGreaterThan(headIdx);
    expect(configIdx).toBeLessThan(titleIdx); // boots before anything else in head
    expect(out).toContain('"token":"tok"');
  });

  it("escapes </script>-breaking tokens in the config block", () => {
    const out = injectPreviewAgent("<head></head>", 'x</script><script>alert(1)');
    expect(out).not.toContain("</script><script>alert(1)");
    expect(out).toContain("\\u003c/script>"); // escaped, inert inside the JSON block
  });

  it("rewrites theme-asset URLs to carry the access token", () => {
    const html = '<img src="/theme-assets/hero.png"> <div style="background:url(/theme-assets/bg.jpg)">';
    const out = rewriteThemeAssetUrls(html, "tok");
    expect(out).toContain('src="/theme-assets/hero.png?t=tok"');
    expect(out).toContain("url(/theme-assets/bg.jpg?t=tok");
    // Non-theme-asset URLs untouched.
    expect(rewriteThemeAssetUrls('<img src="https://cdn.example.com/x.png">', "tok")).toContain(
      "https://cdn.example.com/x.png"
    );
  });
});
