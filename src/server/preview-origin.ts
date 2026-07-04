/**
 * Preview-origin server (VIB-1892).
 *
 * Serves the live preview document from a *separate origin* so AI-generated
 * page code is cross-origin to the app: it can never touch the app's DOM,
 * cookies, or `/api/*` routes. This is the server half of the preview
 * trust-boundary fix — the old `srcdoc` + `sandbox="allow-scripts
 * allow-same-origin"` iframe inherited the app origin, making the sandbox a
 * no-op.
 *
 * Surface (deliberately tiny — this origin must never grow privileged routes):
 *  - `GET /?t=<token>`          → the composed preview doc (trusted
 *                                 `preview-agent.js` + config prepended to the
 *                                 rendered page), under a strict CSP.
 *  - `GET /preview-agent.js`    → the trusted in-frame agent (static).
 *  - `GET /theme-assets/*?t=`   → theme images referenced by the preview.
 *  - anything else              → 404. `/api/*` does not exist here.
 *
 * Access: every route except the static agent script requires the per-boot
 * preview token via `?t=` (timing-safe compare). The parent knows the token
 * (it gets it from the app origin) and stamps it on the iframe `src`; the
 * composed doc's asset URLs are rewritten to carry it too. No cookies —
 * SameSite semantics inside a cross-site iframe make them unreliable, and a
 * query token keeps this origin stateless.
 *
 * CSP on the composed doc pins the trust story:
 *  - `connect-src 'none'`  — AI script cannot exfiltrate via fetch/XHR/WS.
 *  - `frame-ancestors <app>` — only the app origin may embed the preview.
 *  - `script-src 'self' 'unsafe-inline'` — module scripts stay inline-capable;
 *    'self' admits only this origin's own `preview-agent.js`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { tokenMatches } from "./security.js";
import { buildPreviewHtml } from "./preview.js";
import { getSession } from "./session.js";
import { resolveContainedPath } from "../utils/path-safety.js";

export interface PreviewOriginOptions {
  /** First port to try; falls forward on EADDRINUSE (bounded). */
  port: number;
  /** Bind address — same policy as the app server. */
  host: string;
  /**
   * The app origin(s) allowed to embed the preview (CSP `frame-ancestors`),
   * e.g. `http://127.0.0.1:3201`. `'self'` is never included — the preview
   * origin must not embed itself.
   */
  frameAncestors: string[];
  /** Directory holding the trusted `preview-agent.js` (the app's uiDir). */
  uiDir: string;
  /** Override the generated handshake/access token (tests only). */
  token?: string;
}

export interface StartedPreviewOrigin {
  port: number;
  host: string;
  /** Per-boot secret gating this origin AND the postMessage handshake. */
  token: string;
  close: () => void;
}

const PREVIEW_AGENT_FILENAME = "preview-agent.js";
/** How many consecutive ports to try before giving up. */
const MAX_PORT_ATTEMPTS = 10;

const ASSET_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/**
 * Prepend the trusted agent bootstrap to the composed preview doc: a JSON
 * config block (token + protocol version) and the agent script tag, injected
 * at the top of <head> so the agent boots before any AI module script runs.
 */
export function injectPreviewAgent(html: string, token: string): string {
  const config = JSON.stringify({ v: 1, token });
  // The token is hex (randomBytes) or test-supplied; JSON.stringify plus the
  // <-escape below keeps the inline block safe even for exotic test tokens.
  const safeConfig = config.replace(/</g, "\\u003c");
  const bootstrap =
    `<script id="vs-preview-config" type="application/json">${safeConfig}</script>` +
    `<script src="/${PREVIEW_AGENT_FILENAME}"></script>`;
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>${bootstrap}`);
  }
  // Composed docs always have a <head>; degrade by prefixing just in case.
  return bootstrap + html;
}

/**
 * Rewrite root-relative theme-asset references so subresource loads carry the
 * access token (the preview origin has no cookie session to ride on).
 */
export function rewriteThemeAssetUrls(html: string, token: string): string {
  return html.replace(
    /(["'(])\/theme-assets\/([^"')?\s]+)/g,
    (_m, quote: string, assetPath: string) => `${quote}/theme-assets/${assetPath}?t=${token}`
  );
}

function requireToken(url: URL, token: string, res: ServerResponse): boolean {
  const provided = url.searchParams.get("t");
  if (provided && tokenMatches(provided, token)) return true;
  res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Preview access token required");
  return false;
}

function serveAgentScript(uiDir: string, res: ServerResponse): void {
  const path = join(uiDir, PREVIEW_AGENT_FILENAME);
  if (!existsSync(path)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("preview-agent.js not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(readFileSync(path));
}

function serveThemeAsset(assetPath: string, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No session");
    return;
  }
  let filePath: string;
  try {
    // Containment guard: a crafted path must not escape the theme assets dir.
    filePath = resolveContainedPath(join(session.themePath, "assets"), decodeURIComponent(assetPath));
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Asset not found");
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Asset not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": ASSET_MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  res.end(readFileSync(filePath));
}

function buildCsp(frameAncestors: string[]): string {
  const ancestors = frameAncestors.length ? frameAncestors.join(" ") : "'none'";
  return [
    "default-src 'none'",
    // Module scripts are inline; 'self' admits only our own agent script.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    // Module images/fonts/media may reference external URLs from field defaults.
    "img-src * data: blob:",
    "font-src * data:",
    "media-src * data: blob:",
    // The AI page cannot call home — no fetch/XHR/WebSocket from this doc.
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}

function handlePreviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { token: string; uiDir: string; csp: string }
): void {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const method = req.method || "GET";

  res.setHeader("X-Content-Type-Options", "nosniff");

  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  if (url.pathname === `/${PREVIEW_AGENT_FILENAME}`) {
    serveAgentScript(opts.uiDir, res);
    return;
  }

  if (url.pathname === "/") {
    if (!requireToken(url, opts.token, res)) return;
    const composed = rewriteThemeAssetUrls(
      injectPreviewAgent(buildPreviewHtml(), opts.token),
      opts.token
    );
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": opts.csp,
      "Cache-Control": "no-store",
    });
    res.end(composed);
    return;
  }

  if (url.pathname.startsWith("/theme-assets/")) {
    if (!requireToken(url, opts.token, res)) return;
    serveThemeAsset(url.pathname.slice("/theme-assets/".length), res);
    return;
  }

  // Everything else — including anything under /api/ — does not exist here.
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

/**
 * Start the preview-origin HTTP server. Tries `opts.port` first and walks
 * forward on EADDRINUSE (bounded), mirroring the app server's fallback.
 */
export function startPreviewOrigin(opts: PreviewOriginOptions): Promise<StartedPreviewOrigin> {
  const token = opts.token || randomBytes(24).toString("hex");
  const csp = buildCsp(opts.frameAncestors);
  const server: Server = createServer((req, res) =>
    handlePreviewRequest(req, res, { token, uiDir: opts.uiDir, csp })
  );

  return new Promise((resolvePromise, rejectPromise) => {
    let attempt = 0;
    const tryListen = (port: number): void => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
          attempt += 1;
          tryListen(port + 1);
        } else {
          rejectPromise(err);
        }
      });
      server.listen(port, opts.host, () => {
        server.removeAllListeners("error");
        resolvePromise({
          port,
          host: opts.host,
          token,
          close: () => server.close(),
        });
      });
    };
    tryListen(opts.port);
  });
}
