/**
 * Inverse pipeline routes — analyze the active theme so the AI can
 * iterate on it coherently.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse } from "../route-helpers.js";
import { getSession, saveSession, writeModulesToDisk } from "../session.js";
import {
  analyzeTheme,
  applyTokensToSharedCss,
  buildRootCssFromTokens,
  extractDesignTokens,
} from "../inverse-analyzer.js";

function activeThemePath(res: ServerResponse): string | null {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 400, { error: "No active theme. Open or fetch a theme first." });
    return null;
  }
  try {
    writeModulesToDisk();
  } catch { /* best-effort */ }
  return session.themePath;
}

export function handleInverseAnalyzeRoute(_req: IncomingMessage, res: ServerResponse): void {
  const themePath = activeThemePath(res);
  if (!themePath) return;
  const report = analyzeTheme(themePath);
  jsonResponse(res, 200, { report });
}

export function handleInverseApplyTokensRoute(_req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 400, { error: "No active theme. Open or fetch a theme first." });
    return;
  }
  const tokens = extractDesignTokens(session.themePath);
  const rootBlock = buildRootCssFromTokens(tokens);
  if (!rootBlock) {
    jsonResponse(res, 200, { applied: false, reason: "No tokens to apply." });
    return;
  }
  // Seed shared CSS in the session (writeModulesToDisk persists it on next save).
  if (!session.sharedCss || session.sharedCss.trim().length === 0) {
    session.sharedCss = rootBlock;
    session.updatedAt = Date.now();
    saveSession();
    jsonResponse(res, 200, { applied: true, written: "session.sharedCss", rootBlock });
    return;
  }
  // If session already has sharedCss, write to disk only when no `*-theme.css` file exists.
  const target = applyTokensToSharedCss(session.themePath, session.themeName);
  if (target) {
    jsonResponse(res, 200, { applied: true, written: target, rootBlock });
  } else {
    jsonResponse(res, 200, { applied: false, reason: "Theme already has shared CSS." });
  }
}
