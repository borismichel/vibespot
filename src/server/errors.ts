/**
 * Structured error types for consistent HTTP error responses.
 *
 * Route handlers can throw these instead of manually calling jsonResponse()
 * with ad-hoc error objects. The route dispatcher catches them and maps
 * to the correct HTTP status code.
 */

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

/**
 * Convert any error to a safe JSON-serializable response.
 * Strips stack traces to avoid leaking internals.
 */
export function toErrorResponse(err: unknown): { error: string; statusCode: number; details?: Record<string, unknown> } {
  if (err instanceof AppError) {
    return {
      error: err.message,
      statusCode: err.statusCode,
      ...(err.details ? { details: err.details } : {}),
    };
  }

  if (err instanceof Error) {
    return { error: err.message, statusCode: 500 };
  }

  return { error: String(err), statusCode: 500 };
}
