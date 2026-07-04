/**
 * Claude OAuth token manager — stores and auto-refreshes OAuth tokens.
 *
 * Users obtain a token via `claude setup-token` (Claude Code CLI) and paste it
 * into the vibespot settings UI. Tokens are stored in ~/.vibespot/claude-oauth.json.
 *
 * The access token (sk-ant-oat01-...) has an 8-hour lifetime and is auto-refreshed
 * when within 5 minutes of expiry.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, fileExists } from "./fs.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
const TOKEN_DIR = join(homedir(), ".vibespot");
const TOKEN_FILE = join(TOKEN_DIR, "claude-oauth.json");
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_FILE_MODE = 0o600;
const TOKEN_DIR_MODE = 0o700;

// ---------------------------------------------------------------------------
// OAuth headers required for OAT tokens on every API call
// ---------------------------------------------------------------------------

export const OAUTH_EXTRA_HEADERS: Record<string, string> = {
  "user-agent": "claude-cli/2.1.75",
  "x-app": "cli",
  "anthropic-beta": "oauth-2025-04-20",
};

/** System prompt prefix required for OAT tokens — must be a separate block. */
export const OAUTH_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix ms
}

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

function hardenTokenFilePermissions(): void {
  if (process.platform === "win32") return;
  try { chmodSync(TOKEN_DIR, TOKEN_DIR_MODE); } catch { /* ignore */ }
  try { chmodSync(TOKEN_FILE, TOKEN_FILE_MODE); } catch { /* ignore */ }
}

function parseTokens(value: unknown): OAuthTokens | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<OAuthTokens>;
  if (typeof v.access_token !== "string" || !v.access_token) return null;
  if (typeof v.refresh_token !== "string") return null;
  if (typeof v.expires_at !== "number" || !Number.isFinite(v.expires_at)) return null;
  return { access_token: v.access_token, refresh_token: v.refresh_token, expires_at: v.expires_at };
}

function loadTokens(): OAuthTokens | null {
  if (!fileExists(TOKEN_FILE)) return null;
  try {
    hardenTokenFilePermissions();
    return parseTokens(JSON.parse(readFile(TOKEN_FILE)));
  } catch {
    return null;
  }
}

function saveTokens(tokens: OAuthTokens): void {
  mkdirSync(TOKEN_DIR, { recursive: true, mode: TOKEN_DIR_MODE });
  hardenTokenFilePermissions();

  const tmpPath = join(TOKEN_DIR, `.claude-oauth.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(tokens, null, 2), { encoding: "utf-8", mode: TOKEN_FILE_MODE, flag: "w" });
  if (process.platform !== "win32") {
    try { chmodSync(tmpPath, TOKEN_FILE_MODE); } catch { /* ignore */ }
  }
  renameSync(tmpPath, TOKEN_FILE);
  hardenTokenFilePermissions();
}

// ---------------------------------------------------------------------------
// Token refresh (with concurrency guard)
// ---------------------------------------------------------------------------

let refreshPromise: Promise<void> | null = null;

async function refreshAccessToken(refresh_token: string): Promise<void> {
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token,
      client_id: CLIENT_ID,
    }),
  });

  if (!resp.ok) {
    clearOAuthTokens();
    throw new Error("Claude OAuth session expired. Please re-authenticate in Settings.");
  }

  const data = await resp.json() as Record<string, unknown>;
  if (typeof data.access_token !== "string" || !data.access_token) {
    clearOAuthTokens();
    throw new Error("Claude OAuth refresh returned an invalid token payload. Please re-authenticate in Settings.");
  }
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : 28800;
  saveTokens({
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : refresh_token,
    expires_at: Date.now() + expiresIn * 1000,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Save an initial OAuth token (from `claude setup-token` or manual paste).
 */
export function saveInitialToken(accessToken: string, refreshToken: string = ""): void {
  saveTokens({
    access_token: accessToken,
    refresh_token: refreshToken,
    // Default 8h expiry — will be corrected on first refresh
    expires_at: Date.now() + 28800 * 1000,
  });
}

/**
 * Check if a valid (non-expired) OAuth token exists.
 */
export function hasValidOAuthToken(): boolean {
  const tokens = loadTokens();
  if (!tokens) return false;
  return tokens.expires_at > Date.now();
}

/**
 * Get a valid access token, auto-refreshing if needed.
 * Returns null if no token is stored or refresh fails.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = loadTokens();
  if (!tokens) return null;

  // Still valid and not near expiry
  if (tokens.expires_at - Date.now() > REFRESH_BUFFER_MS) {
    return tokens.access_token;
  }

  // Need to refresh — use concurrency guard
  if (tokens.refresh_token) {
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken(tokens.refresh_token).finally(() => {
        refreshPromise = null;
      });
    }

    try {
      await refreshPromise;
    } catch {
      return null;
    }

    const refreshed = loadTokens();
    return refreshed?.access_token ?? null;
  }

  // No refresh token — return current token even if expiring
  return tokens.access_token;
}

/**
 * Get token info for status display.
 */
export function getOAuthTokenInfo(): { expiresAt: string } | null {
  const tokens = loadTokens();
  if (!tokens) return null;
  return { expiresAt: new Date(tokens.expires_at).toISOString() };
}

/**
 * Clear stored OAuth tokens (logout).
 */
export function clearOAuthTokens(): void {
  if (fileExists(TOKEN_FILE)) {
    try { unlinkSync(TOKEN_FILE); } catch { /* ignore */ }
  }
}
