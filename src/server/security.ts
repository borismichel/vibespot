/**
 * Server security policy (VIB-1889): bind address, shared-secret auth, and
 * origin validation for the local HTTP + WebSocket surface.
 *
 * Model:
 * - The server binds to 127.0.0.1 unless VIBESPOT_HOST says otherwise.
 * - Requests from the loopback interface with a local Host header are trusted
 *   (the local user already owns the process). The Host check blocks DNS
 *   rebinding — a browser lured to attacker.com resolving to 127.0.0.1 sends
 *   `Host: attacker.com` and is rejected.
 * - Any networked bind (VIBESPOT_HOST=0.0.0.0, LAN, Tailscale, Docker) turns
 *   on shared-secret auth: VIBESPOT_AUTH_TOKEN, or a token generated at boot
 *   and printed with the URL. The token is accepted as a Bearer header,
 *   X-Vibespot-Token header, `?token=` query param, or the session cookie the
 *   server sets after the first tokenized page load — so the UI and the
 *   WebSocket upgrade work unchanged once the printed URL is opened.
 * - VIBESPOT_DISABLE_AUTH=1 turns the gate off for deploys that put their own
 *   auth in front (e.g. the docker-compose.auth.yml Entra/oauth2-proxy gate).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const AUTH_COOKIE = "vibespot_token";

export interface SecurityConfig {
  /** Address the HTTP server binds to. */
  host: string;
  /** Shared secret; null when no token auth is configured. */
  authToken: string | null;
  /** True when the token was generated at boot (not operator-provided). */
  generatedToken: boolean;
  /** True when VIBESPOT_DISABLE_AUTH explicitly turned the gate off. */
  authDisabled: boolean;
}

function envFlag(name: string): boolean {
  const v = (process.env[name] || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.");
}

export function resolveSecurityConfig(hostOverride?: string): SecurityConfig {
  const host = hostOverride || process.env.VIBESPOT_HOST || "127.0.0.1";
  const authDisabled = envFlag("VIBESPOT_DISABLE_AUTH");
  let authToken = process.env.VIBESPOT_AUTH_TOKEN || null;
  let generatedToken = false;

  if (authDisabled) {
    return { host, authToken: null, generatedToken: false, authDisabled };
  }

  // A networked bind without an operator-provided secret gets one generated
  // at boot; the CLI prints it as part of the URL.
  if (!authToken && !isLoopbackHost(host)) {
    authToken = randomBytes(24).toString("hex");
    generatedToken = true;
  }

  return { host, authToken, generatedToken, authDisabled };
}

// ---------------------------------------------------------------------------
// Disabled-auth bind guard (VIB-1906)
// ---------------------------------------------------------------------------

export interface DisabledAuthGate {
  severity: "none" | "warn" | "refuse";
  message: string | null;
}

/**
 * Guard the Entra/oauth2-proxy invariant: VIBESPOT_DISABLE_AUTH=1 on a
 * non-loopback bind is only safe when an authenticating proxy is the sole
 * ingress to the app port. Without VIBESPOT_TRUST_PROXY=1 acknowledging that
 * topology, the server refuses to start rather than silently serving a fully
 * unauthenticated surface (AI keys + HubSpot account behind it).
 */
export function checkDisabledAuthBind(cfg: SecurityConfig): DisabledAuthGate {
  if (!cfg.authDisabled || isLoopbackHost(cfg.host)) {
    return { severity: "none", message: null };
  }
  if (envFlag("VIBESPOT_TRUST_PROXY")) {
    return {
      severity: "warn",
      message:
        "  ! AUTH IS DISABLED on a non-loopback bind (VIBESPOT_DISABLE_AUTH=1 + VIBESPOT_TRUST_PROXY=1).\n" +
        "  ! An authenticating proxy MUST be the only way to reach this server.\n" +
        "  ! Never publish the app port directly (keep it expose-only, e.g. behind\n" +
        "  ! the docker-compose.auth.yml Entra gate) — anyone who reaches it can\n" +
        "  ! use your AI keys and HubSpot account.",
    };
  }
  return {
    severity: "refuse",
    message:
      `VIBESPOT_DISABLE_AUTH=1 with a non-loopback bind (${cfg.host}) would serve a fully ` +
      "unauthenticated server — anyone who can reach the port could use your AI keys and " +
      "HubSpot account. Refusing to start. If an authenticating proxy (e.g. the " +
      "docker-compose.auth.yml Entra/oauth2-proxy gate) is the ONLY ingress to this port, " +
      "set VIBESPOT_TRUST_PROXY=1 to acknowledge that and continue.",
  };
}

// ---------------------------------------------------------------------------
// Host / origin validation
// ---------------------------------------------------------------------------

// Hosts we consider "local or private" — used for the loopback trust check
// and the browser-origin allow-list (localhost, RFC1918, Tailscale CGNAT).
const PRIVATE_HOST_RE = /^(localhost|127(?:\.\d+){3}|\[::1\]|::1|100\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

/** Is the Host header a plausible local/private address for this server? */
export function isLocalHostHeader(hostHeader: string | undefined, cfg: SecurityConfig): boolean {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (PRIVATE_HOST_RE.test(name)) return true;
  return name === cfg.host;
}

/**
 * Validate a browser Origin header for CORS and the WebSocket upgrade.
 * Same-origin (origin host === Host header) or a local/private origin passes.
 * Requests without an Origin header (curl, native clients) are not judged
 * here — token auth still applies to them.
 */
export function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (hostHeader && parsed.host === hostHeader) return true;
  return PRIVATE_HOST_RE.test(parsed.hostname);
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export interface AuthResult {
  ok: boolean;
  /** The valid token arrived via the ?token= query param (cookie should be set). */
  viaQueryToken: boolean;
}

/**
 * Authenticate an HTTP request or WebSocket upgrade.
 * Order: explicit disable → presented token → loopback trust.
 */
export function checkRequestAuth(req: IncomingMessage, cfg: SecurityConfig): AuthResult {
  if (cfg.authDisabled) return { ok: true, viaQueryToken: false };

  if (cfg.authToken) {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ") && tokenMatches(header.slice(7).trim(), cfg.authToken)) {
      return { ok: true, viaQueryToken: false };
    }
    const xToken = req.headers["x-vibespot-token"];
    if (typeof xToken === "string" && tokenMatches(xToken, cfg.authToken)) {
      return { ok: true, viaQueryToken: false };
    }
    const cookie = readCookie(req, AUTH_COOKIE);
    if (cookie && tokenMatches(cookie, cfg.authToken)) {
      return { ok: true, viaQueryToken: false };
    }
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const qToken = url.searchParams.get("token");
      if (qToken && tokenMatches(qToken, cfg.authToken)) {
        return { ok: true, viaQueryToken: true };
      }
    } catch {
      // fall through to loopback check
    }
  }

  // Loopback trust: local processes are the owner. Host-header check blocks
  // DNS rebinding (browser → attacker domain → 127.0.0.1 keeps the attacker
  // Host header).
  if (isLoopbackAddress(req.socket.remoteAddress) && isLocalHostHeader(req.headers.host, cfg)) {
    return { ok: true, viaQueryToken: false };
  }

  return { ok: false, viaQueryToken: false };
}
