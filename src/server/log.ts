/**
 * Structured logging helper.
 * Prefixes all output with a context tag for easy filtering.
 * In SaaS, this can be swapped for a proper logging library (pino, winston).
 */

export const log = {
  info(context: string, message: string, data?: Record<string, unknown>): void {
    const line = data
      ? `[${context}] ${message} ${JSON.stringify(data)}`
      : `[${context}] ${message}`;
    console.log(line);
  },

  warn(context: string, message: string, data?: Record<string, unknown>): void {
    const line = data
      ? `[${context}] ${message} ${JSON.stringify(data)}`
      : `[${context}] ${message}`;
    console.warn(line);
  },

  error(context: string, message: string, err?: unknown): void {
    const errMsg = err instanceof Error ? err.message : err ? String(err) : "";
    const line = errMsg
      ? `[${context}] ${message}: ${errMsg}`
      : `[${context}] ${message}`;
    console.error(line);
  },
};
