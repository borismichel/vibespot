/**
 * Structured logging helper.
 * Writes to both console and a rotating log file at ~/.vibespot/logs/.
 * Log files are named vibespot-YYYY-MM-DD.log and auto-pruned after 7 days.
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".vibespot", "logs");
const MAX_AGE_DAYS = 7;

let logDirReady = false;
let pruned = false;

function ensureLogDir(): void {
  if (logDirReady) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    logDirReady = true;
  } catch {
    // If we can't create the dir, file logging silently disabled
  }
}

function pruneOldLogs(): void {
  if (pruned) return;
  pruned = true;
  try {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
    for (const f of readdirSync(LOG_DIR)) {
      if (!f.startsWith("vibespot-") || !f.endsWith(".log")) continue;
      // Extract date from filename: vibespot-YYYY-MM-DD.log
      const dateStr = f.slice(9, 19);
      const ts = new Date(dateStr).getTime();
      if (ts && ts < cutoff) {
        try { unlinkSync(join(LOG_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function todayFile(): string {
  const d = new Date();
  const date = d.toISOString().slice(0, 10);
  return join(LOG_DIR, `vibespot-${date}.log`);
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
}

function writeToFile(level: string, line: string): void {
  ensureLogDir();
  if (!logDirReady) return;
  if (!pruned) pruneOldLogs();
  try {
    appendFileSync(todayFile(), `${timestamp()} ${level} ${line}\n`);
  } catch { /* ignore — don't break the app over logging */ }
}

export const log = {
  info(context: string, message: string, data?: Record<string, unknown>): void {
    const line = data
      ? `[${context}] ${message} ${JSON.stringify(data)}`
      : `[${context}] ${message}`;
    console.log(line);
    writeToFile("INFO", line);
  },

  warn(context: string, message: string, data?: Record<string, unknown>): void {
    const line = data
      ? `[${context}] ${message} ${JSON.stringify(data)}`
      : `[${context}] ${message}`;
    console.warn(line);
    writeToFile("WARN", line);
  },

  error(context: string, message: string, err?: unknown): void {
    const errMsg = err instanceof Error ? err.message : err ? String(err) : "";
    const line = errMsg
      ? `[${context}] ${message}: ${errMsg}`
      : `[${context}] ${message}`;
    console.error(line);
    writeToFile("ERROR", line);
  },
};
