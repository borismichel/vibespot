/**
 * Claude OAuth routes — save/manage OAuth tokens for Claude Pro/Max access.
 * Users obtain tokens via `claude setup-token` (Claude Code CLI).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse, readBody } from "../route-helpers.js";
import { saveConfig, loadConfig } from "../../utils/config.js";
import {
  saveInitialToken,
  hasValidOAuthToken,
  getOAuthTokenInfo,
  clearOAuthTokens,
} from "../../utils/claude-oauth.js";

/**
 * POST /api/settings/claude-oauth/save
 * Save an OAuth token (from `claude setup-token` or manual paste).
 */
export function handleClaudeOAuthSaveRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { access_token, refresh_token } = JSON.parse(body);
      if (!access_token || typeof access_token !== "string") {
        jsonResponse(res, 400, { error: "access_token is required" });
        return;
      }

      saveInitialToken(access_token.trim(), (refresh_token || "").trim());

      // Auto-select claude-oauth as the active engine
      const config = loadConfig();
      if (!config.aiEngine || config.aiEngine !== "claude-oauth") {
        saveConfig({ aiEngine: "claude-oauth" } as any);
      }

      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * GET /api/settings/claude-oauth/status
 * Return current OAuth authentication status.
 */
export function handleClaudeOAuthStatusRoute(_req: IncomingMessage, res: ServerResponse): void {
  const authenticated = hasValidOAuthToken();
  const info = getOAuthTokenInfo();
  jsonResponse(res, 200, {
    authenticated,
    expiresAt: info?.expiresAt || null,
  });
}

/**
 * POST /api/settings/claude-oauth/logout
 * Clear stored OAuth tokens and reset engine if needed.
 */
export function handleClaudeOAuthLogoutRoute(_req: IncomingMessage, res: ServerResponse): void {
  try {
    clearOAuthTokens();

    const config = loadConfig();
    if (config.aiEngine === "claude-oauth") {
      saveConfig({ aiEngine: undefined } as any);
    }

    jsonResponse(res, 200, { ok: true });
  } catch (err) {
    jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
