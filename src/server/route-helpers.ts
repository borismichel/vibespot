/**
 * Shared helpers for route handlers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function readBody(req: IncomingMessage, callback: (body: string) => void): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => callback(Buffer.concat(chunks).toString("utf-8")));
}
