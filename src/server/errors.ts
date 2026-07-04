/**
 * Structured error types for consistent HTTP error responses.
 *
 * Route handlers can throw these instead of manually calling jsonResponse()
 * with ad-hoc error objects. The route dispatcher catches them and maps
 * to the correct HTTP status code.
 */

import { homedir } from "node:os";

export class AppError extends Error {
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode: number = 500, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, details);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = "Not found") {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 409, details);
    this.name = "ConflictError";
  }
}

export class EngineError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 502, details);
    this.name = "EngineError";
  }
}

// Home-directory paths in raw error messages leak the OS username to any
// client that can read an error response (VIB-1889).
const HOME_PATH_RE = /(?:\/(?:home|Users)\/|[A-Za-z]:\\Users\\)[^\s/\\'")\]]+/g;

/**
 * Error message safe to echo to a client: underlying fs/OS messages with the
 * home directory (and any /home/<user> or /Users/<user> prefix) redacted.
 * Log the raw error server-side when the detail matters.
 */
export function publicErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split(homedir()).join("~").replace(HOME_PATH_RE, "~");
}

/**
 * Convert any error to a safe JSON-serializable response.
 * Strips stack traces to avoid leaking internals.
 */
export function toErrorResponse(err: unknown): { error: string; statusCode: number; details?: Record<string, unknown> } {
  if (err instanceof AppError) {
    return {
      error: publicErrorMessage(err),
      statusCode: err.statusCode,
      ...(err.details ? { details: err.details } : {}),
    };
  }

  return { error: publicErrorMessage(err), statusCode: 500 };
}
