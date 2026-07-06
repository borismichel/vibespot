/**
 * VIB-1937 — regressions for the "silently blank preview after in-place
 * upgrade" bug.
 *
 * Two guarantees are locked here:
 *
 *  1. **Stale-cache defeat.** The UI shell (`index.html`) and the `ui/*.js`
 *     bundle must be served with a non-caching `Cache-Control` so a browser
 *     that upgrades in place can never keep running an old `ui/preview.js`
 *     against a new server (the original root cause — VIB-108 first shipped
 *     the `no-store`, this test stops it silently regressing).
 *
 *  2. **Fallback precondition.** With the preview origin disabled,
 *     `GET /api/preview-origin` returns `{ origin: null }`. That is exactly
 *     the payload the client turns into the visible in-frame fallback
 *     (`showPreviewUnavailable()` in `ui/preview.js`) instead of a blank
 *     frame. The in-browser rendering itself is covered by manual QA.
 */
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { startServer, type StartedServer } from "../src/server/server.js";

const uiDir = join(import.meta.dirname, "../ui");

let started: StartedServer | null = null;

afterEach(() => {
  started?.close();
  started = null;
});

async function boot(): Promise<StartedServer> {
  // A fixed high port; startServer walks forward on EADDRINUSE and the
  // resolved `.port` reflects the real bound port either way. The preview
  // origin is disabled — we exercise the "origin unavailable" path on purpose.
  started = await startServer({
    port: 47593,
    uiDir,
    host: "127.0.0.1",
    enablePreviewOrigin: false,
  });
  return started;
}

function base(s: StartedServer): string {
  return `http://127.0.0.1:${s.port}`;
}

describe("VIB-1937 preview fallback + stale-cache defeat", () => {
  it("serves the UI shell (index.html) without allowing a stale cache", async () => {
    const s = await boot();
    const res = await fetch(`${base(s)}/`);
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") || "";
    // no-store or no-cache both force revalidation after an upgrade.
    expect(cc).toMatch(/no-store|no-cache/);
  });

  it("serves ui/preview.js with a non-caching Cache-Control", async () => {
    const s = await boot();
    const res = await fetch(`${base(s)}/preview.js`);
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") || "";
    expect(cc).toMatch(/no-store|no-cache/);
  });

  it("returns { origin: null } when the preview origin is unavailable", async () => {
    const s = await boot();
    const res = await fetch(`${base(s)}/api/preview-origin`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ origin: null });
  });

  it("wires the visible fallback into the client refresh path", () => {
    // Guard the client contract: the origin-resolution failure must call the
    // fallback renderer rather than silently returning (the original bug).
    const src = readFileSync(join(uiDir, "preview.js"), "utf8");
    expect(src).toContain("function showPreviewUnavailable(");
    // refreshPreview must invoke it on the null-origin branch.
    const refreshBody = src.slice(
      src.indexOf("function refreshPreview("),
      src.indexOf("function scrollPreviewToModule(")
    );
    expect(refreshBody).toContain("showPreviewUnavailable()");
  });
});
