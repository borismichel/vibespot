/**
 * Preview-origin discovery route (VIB-1892).
 *
 *   GET /api/preview-origin → { origin, token } | { origin: null }
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse } from "../route-helpers.js";
import { getActivePreviewOrigin } from "../server-context.js";

/**
 * Tell the UI where the separate preview origin lives (VIB-1892). The origin
 * hostname is derived from the request's Host header so the answer is
 * reachable from wherever the browser actually is (localhost vs 127.0.0.1 vs
 * a Docker/tailnet hostname); only the port differs between app and preview.
 * The token doubles as the postMessage handshake secret — this route sits
 * behind the app auth gate, so only an authenticated UI can read it.
 */
export function handlePreviewOriginRoute(req: IncomingMessage, res: ServerResponse): void {
  const activePreviewOrigin = getActivePreviewOrigin();
  if (!activePreviewOrigin) {
    jsonResponse(res, 200, { origin: null });
    return;
  }
  const hostHeader = req.headers.host || `${activePreviewOrigin.host}:0`;
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : hostHeader.split(":")[0];
  jsonResponse(res, 200, {
    origin: `http://${hostname}:${activePreviewOrigin.port}`,
    token: activePreviewOrigin.token,
  });
}
