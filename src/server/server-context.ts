/**
 * Run-state of the currently running server (VIB-1932).
 *
 * `startServer` (server.ts) writes these once at boot; route/WS handlers read
 * them. Keeping the state in its own leaf module lets the extracted route and
 * WebSocket modules read it without importing server.ts (which imports them).
 */

import type { StartedPreviewOrigin } from "./preview-origin.js";

let serverContentMode: "page" | "email" = "page";

export function getServerContentMode(): "page" | "email" {
  return serverContentMode;
}

export function setServerContentMode(mode: "page" | "email"): void {
  serverContentMode = mode;
}

// The running preview origin (VIB-1892) — set by startServer, read by the
// /api/preview-origin route so the UI can point the preview iframe at it.
let activePreviewOrigin: StartedPreviewOrigin | null = null;

export function getActivePreviewOrigin(): StartedPreviewOrigin | null {
  return activePreviewOrigin;
}

export function setActivePreviewOrigin(origin: StartedPreviewOrigin | null): void {
  activePreviewOrigin = origin;
}

/** Clear the active preview origin only if it is still `origin` (a later
 * startServer call may have replaced it). */
export function clearActivePreviewOrigin(origin: StartedPreviewOrigin | null): void {
  if (activePreviewOrigin === origin) activePreviewOrigin = null;
}
