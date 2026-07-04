/**
 * Shared helpers for route handlers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Cap on buffered request bodies (VIB-1889) — an unbounded readBody lets any
 * client OOM the process. JSON payloads (module code, brand CSS, plans) stay
 * far below this; large file uploads stream through Busboy with its own cap.
 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export function readBody(
  req: IncomingMessage,
  callback: (body: string) => void,
  opts: { res?: ServerResponse; maxBytes?: number } = {}
): void {
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  const chunks: Buffer[] = [];
  let received = 0;
  let overLimit = false;

  req.on("data", (chunk: Buffer) => {
    if (overLimit) return;
    received += chunk.length;
    if (received > maxBytes) {
      overLimit = true;
      chunks.length = 0;
      if (opts.res && !opts.res.headersSent) {
        // Stop reading, answer 413, and let `Connection: close` end the
        // socket after the response flushes — destroying the request here
        // would RST the shared socket and eat the response.
        req.pause();
        opts.res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
        opts.res.end(JSON.stringify({ error: "Request body too large" }));
      } else {
        req.destroy();
      }
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (!overLimit) callback(Buffer.concat(chunks).toString("utf-8"));
  });
}

/**
 * Read request body and parse as JSON with error handling.
 * Returns 400 with an error message if parsing fails.
 */
export function readJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
  res: ServerResponse,
  callback: (data: T) => void
): void {
  readBody(req, (body) => {
    try {
      callback(JSON.parse(body || "{}") as T);
    } catch {
      jsonResponse(res, 400, { error: "Invalid JSON in request body" });
    }
  }, { res });
}
