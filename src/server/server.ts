/**
 * Local development server for vibeSpot vibe coding mode.
 *
 * Owns the HTTP/WebSocket server lifecycle, the single auth-gate middleware
 * seam (VIB-1889), and static/preview serving. The `/api/*` dispatch lives in
 * routes/api-router.ts and the WebSocket protocol in ws-handler.ts (VIB-1932).
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { WebSocketServer } from "ws";
import { getSession } from "./session.js";
import { buildPreviewHtml, buildModulePreviewHtml } from "./preview.js";
import { jsonResponse } from "./route-helpers.js";
import {
  resolveSecurityConfig,
  checkDisabledAuthBind,
  checkRequestAuth,
  isAllowedOrigin,
  AUTH_COOKIE,
  type SecurityConfig,
} from "./security.js";
import { startPreviewOrigin, normalizePublicOrigin, type StartedPreviewOrigin } from "./preview-origin.js";
import {
  setServerContentMode,
  setActivePreviewOrigin,
  clearActivePreviewOrigin,
} from "./server-context.js";
import { handleApiRoute } from "./routes/api-router.js";
import { handleWsConnection } from "./ws-handler.js";

// Existing importers reach the running server's content mode through this
// module; the state itself lives in server-context.ts (VIB-1932).
export { getServerContentMode } from "./server-context.js";

// ---------------------------------------------------------------------------
// MIME types for static serving
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ServerOptions {
  port: number;
  uiDir: string;
  contentMode?: "page" | "email";
  /** Bind address; defaults to VIBESPOT_HOST or 127.0.0.1 (VIB-1889). */
  host?: string;
  /**
   * Start the separate preview origin (VIB-1892). Default ON — the live
   * preview iframe loads from this origin so AI-generated page code runs
   * cross-origin to the app. Pass `false` only in tests that don't need it.
   */
  enablePreviewOrigin?: boolean;
}

export interface StartedServer {
  port: number;
  host: string;
  /** Shared-secret auth token, when token auth is active (VIB-1889). */
  authToken: string | null;
  /** The separate preview origin when enabled, else null (VIB-1892). */
  previewOrigin: StartedPreviewOrigin | null;
  close: () => void;
}

// Security policy for the running server — set once in startServer, read by
// the request/upgrade handlers (same module-state pattern as contentMode).
let security: SecurityConfig = resolveSecurityConfig();

export function startServer(opts: ServerOptions): Promise<StartedServer> {
  const { port, uiDir } = opts;
  setServerContentMode(opts.contentMode || "page");
  security = resolveSecurityConfig(opts.host);

  // VIB-1906: disabling auth on a non-loopback bind is refused outright unless
  // VIBESPOT_TRUST_PROXY=1 acknowledges that an authenticating proxy is the
  // sole ingress to the app port (and even then it warns loudly). The only way
  // to reach a token-less non-loopback config is VIBESPOT_DISABLE_AUTH=1, so
  // this gate subsumes the old soft warning.
  const disabledAuthGate = checkDisabledAuthBind(security);
  if (disabledAuthGate.severity === "refuse") {
    throw new Error(disabledAuthGate.message!);
  }
  if (disabledAuthGate.severity === "warn") {
    console.warn(disabledAuthGate.message);
  }

  const server = createServer((req, res) => handleRequest(req, res, uiDir));

  // WebSocket server — upgrade on the same HTTP server. Browsers do not apply
  // CORS to WebSockets, so the upgrade enforces the Origin allow-list
  // (anti-CSWSH) plus the same auth gate as HTTP routes (VIB-1889).
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { origin?: string; req: IncomingMessage }) => {
      if (!isAllowedOrigin(info.origin, info.req.headers.host)) return false;
      return checkRequestAuth(info.req, security).ok;
    },
  });
  wss.on("connection", (ws) => handleWsConnection(ws));

  // The separate preview origin (VIB-1892): started alongside the app server
  // so AI-generated preview code runs cross-origin to the app. `port + 1` is
  // the app's own EADDRINUSE fallback, so the preview origin starts at
  // `port + 2` (and walks forward itself if that is taken).
  const started = async (boundPort: number): Promise<StartedServer> => {
    let previewOrigin: StartedPreviewOrigin | null = null;
    if (opts.enablePreviewOrigin !== false) {
      // Reverse-proxy deployments (VIB-1933): VIBESPOT_PREVIEW_PUBLIC_ORIGIN
      // is the browser-facing URL of the preview origin (the bind port is not
      // reachable from outside the container), VIBESPOT_PUBLIC_ORIGIN the
      // browser-facing URL of the app itself.
      const previewPublicOrigin = normalizePublicOrigin(
        process.env.VIBESPOT_PREVIEW_PUBLIC_ORIGIN,
        "VIBESPOT_PREVIEW_PUBLIC_ORIGIN"
      );
      const appPublicOrigin = normalizePublicOrigin(
        process.env.VIBESPOT_PUBLIC_ORIGIN,
        "VIBESPOT_PUBLIC_ORIGIN"
      );
      // frame-ancestors: on a loopback bind, allow both loopback spellings so
      // a user browsing via `localhost` still embeds a `127.0.0.1`-announced
      // preview. On a non-loopback bind (Docker/tailnet) the browser-facing
      // hostname is unknowable at boot, so pin to the configured public app
      // origin when there is one and only otherwise fall back to any
      // ancestor — the access token still gates who can load the doc at all.
      const isLoopback = security.host === "127.0.0.1" || security.host === "localhost" || security.host === "::1";
      const frameAncestors = isLoopback
        ? [
            `http://127.0.0.1:${boundPort}`,
            `http://localhost:${boundPort}`,
            ...(appPublicOrigin ? [appPublicOrigin] : []),
          ]
        : appPublicOrigin
          ? [appPublicOrigin]
          : ["*"];
      if (previewPublicOrigin && !appPublicOrigin && !isLoopback) {
        console.warn(
          "VIBESPOT_PREVIEW_PUBLIC_ORIGIN is set without VIBESPOT_PUBLIC_ORIGIN — " +
            "the preview's frame-ancestors falls back to *; set VIBESPOT_PUBLIC_ORIGIN " +
            "to pin embedding to your app origin."
        );
      }
      previewOrigin = await startPreviewOrigin({
        port: boundPort + 2,
        host: security.host,
        frameAncestors,
        uiDir,
        publicOrigin: previewPublicOrigin,
      });
    }
    setActivePreviewOrigin(previewOrigin);
    return {
      port: boundPort,
      host: security.host,
      authToken: security.authToken,
      previewOrigin,
      close: () => {
        server.close();
        wss.close();
        previewOrigin?.close();
        clearActivePreviewOrigin(previewOrigin);
      },
    };
  };

  return new Promise((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Try next port
        server.listen(port + 1, security.host, () => {
          started(port + 1).then(resolve, reject);
        });
      } else {
        reject(err);
      }
    });

    server.listen(port, security.host, () => {
      started(port).then(resolve, reject);
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

function handleRequest(req: IncomingMessage, res: ServerResponse, uiDir: string): void {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const method = req.method || "GET";

  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Health check — used by Docker HEALTHCHECK, CI smoke tests, and load
  // balancers. Returns 200 with a tiny JSON body and is unauthenticated.
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Auth gate (VIB-1889) — every route except /healthz and CORS preflights.
  // OPTIONS is exempt because preflights never carry credentials and
  // trigger no state change.
  if (method !== "OPTIONS") {
    const auth = checkRequestAuth(req, security);
    if (!auth.ok) {
      if (url.pathname.startsWith("/api/")) {
        jsonResponse(res, 401, { error: "Authentication required" });
      } else {
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>vibeSpot</title><body style=\"font-family:system-ui;padding:2rem\"><h1>Authentication required</h1><p>Open vibeSpot using the exact URL printed in the terminal where it was started (it includes a <code>?token=</code> secret).</p></body>");
      }
      return;
    }
    // First page load via the tokenized URL: persist the token as a session
    // cookie (rides on every later request incl. the WebSocket upgrade) and
    // strip the secret out of the address bar.
    if (auth.viaQueryToken && method === "GET" && !url.pathname.startsWith("/api/") && security.authToken) {
      url.searchParams.delete("token");
      res.writeHead(302, {
        "Set-Cookie": `${AUTH_COOKIE}=${security.authToken}; HttpOnly; SameSite=Strict; Path=/`,
        Location: url.pathname + url.search,
      });
      res.end();
      return;
    }
  }

  // API routes — dispatched through the route table (routes/api-router.ts).
  if (url.pathname.startsWith("/api/")) {
    handleApiRoute(method, url.pathname, req, res);
    return;
  }

  // Preview route — returns rendered preview HTML
  if (url.pathname === "/preview") {
    const html = buildPreviewHtml();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // Single-module preview (for dashboard module library)
  if (url.pathname === "/module-preview") {
    const moduleName = url.searchParams.get("module") || "";
    const html = buildModulePreviewHtml(moduleName);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html || "<!-- module not found -->");
    return;
  }

  // Theme assets — serve uploaded images for preview
  if (url.pathname.startsWith("/theme-assets/")) {
    serveThemeAsset(url.pathname.slice("/theme-assets/".length), res);
    return;
  }

  // Documentation — served from ui/docs/ directory
  if (url.pathname === "/docs") {
    res.writeHead(301, { Location: "/docs/" });
    res.end();
    return;
  }
  if (url.pathname.startsWith("/docs/")) {
    const docPath = url.pathname.slice(5) || "/index.html"; // strip "/docs"
    serveStatic(docPath, join(uiDir, "docs"), req, res);
    return;
  }

  // Static files from ui/ directory
  serveStatic(url.pathname, uiDir, req, res);
}

// ---------------------------------------------------------------------------
// Theme asset serving (uploaded images for preview)
// ---------------------------------------------------------------------------

function serveThemeAsset(filename: string, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("No session");
    return;
  }
  const filePath = join(session.themePath, "assets", filename);
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Asset not found");
    return;
  }
  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const buffer = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
  });
  res.end(buffer);
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------


function serveStatic(pathname: string, uiDir: string, req: IncomingMessage, res: ServerResponse): void {
  // Default to index.html
  let filePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = join(uiDir, filePath);

  if (!existsSync(fullPath)) {
    // SPA fallback — serve index.html for unknown routes
    const indexPath = join(uiDir, "index.html");
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
      res.end(content);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
    return;
  }

  const ext = extname(fullPath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const isHtml = ext === ".html";

  try {
    // Always re-read from disk to pick up changes during development
    const buffer = readFileSync(fullPath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(buffer);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
}
