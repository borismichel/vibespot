/**
 * Langfuse instrumentation — opt-in LLM observability.
 *
 * vibeSpot ships as a local CLI/server, not a backend we operate. Rather than
 * pull in the OpenTelemetry-based Langfuse v5 SDK (heavy for our single-file
 * tsup bundle), this is a tiny dependency-free client that batches events to
 * Langfuse's stable ingestion API (`POST /api/public/ingestion`).
 *
 * Design rules:
 *  - Opt-in: no keys configured → every export is a no-op. "Without sacrificing
 *    functionality" means a generation never waits on or fails because of us.
 *  - Fail-safe: all network/serialization errors are swallowed and logged.
 *  - Grouped: one trace per pipeline run (via AsyncLocalStorage), with a child
 *    generation per model call — so a full page shows up as one trace with its
 *    total token cost.
 *
 * Configure via `~/.vibespot/config.json` (langfusePublicKey / langfuseSecretKey
 * / langfuseBaseUrl) or env (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY /
 * LANGFUSE_BASE_URL / LANGFUSE_ENABLED).
 */

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { loadConfig } from "../utils/config.js";
import { log } from "./log.js";
import {
  computeCost,
  toUsageDetails,
  type TokenUsage,
} from "./pricing.js";

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
// Cap serialized input/output so we never ship multi-hundred-KB prompts.
const MAX_FIELD_CHARS = 24_000;

interface LangfuseSettings {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

interface IngestionEvent {
  id: string;
  type: "trace-create" | "generation-create";
  timestamp: string;
  body: Record<string, unknown>;
}

interface TraceContext {
  traceId: string;
  sessionId?: string;
}

const traceStore = new AsyncLocalStorage<TraceContext>();
let buffer: IngestionEvent[] = [];

function resolveSettings(): LangfuseSettings | null {
  const cfg = loadConfig();
  const publicKey = cfg.langfusePublicKey || process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = cfg.langfuseSecretKey || process.env.LANGFUSE_SECRET_KEY;
  // Explicit disable wins; otherwise presence of both keys enables it.
  const disabled =
    cfg.langfuseEnabled === false || process.env.LANGFUSE_ENABLED === "false";
  if (disabled || !publicKey || !secretKey) return null;
  const baseUrl = (
    cfg.langfuseBaseUrl ||
    process.env.LANGFUSE_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  return { publicKey, secretKey, baseUrl };
}

/** True when Langfuse keys are configured and not explicitly disabled. */
export function isLangfuseEnabled(): boolean {
  return resolveSettings() !== null;
}

function truncate(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_FIELD_CHARS
      ? value.slice(0, MAX_FIELD_CHARS) + `…[+${value.length - MAX_FIELD_CHARS} chars]`
      : value;
  }
  try {
    const json = JSON.stringify(value);
    if (json && json.length > MAX_FIELD_CHARS) {
      return json.slice(0, MAX_FIELD_CHARS) + `…[+${json.length - MAX_FIELD_CHARS} chars]`;
    }
  } catch {
    return "[unserializable]";
  }
  return value;
}

/**
 * Run `fn` inside a Langfuse trace. All `recordGeneration` calls made while
 * `fn` is executing (including parallel awaited work) attach to this trace.
 * When Langfuse is disabled this is a transparent pass-through.
 */
export async function runWithTrace<T>(
  meta: {
    name: string;
    sessionId?: string;
    userId?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
    tags?: string[];
  },
  fn: () => Promise<T>,
): Promise<T> {
  if (!isLangfuseEnabled()) return fn();

  const traceId = randomUUID();
  buffer.push({
    id: randomUUID(),
    type: "trace-create",
    timestamp: new Date().toISOString(),
    body: {
      id: traceId,
      name: meta.name,
      timestamp: new Date().toISOString(),
      ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
      ...(meta.userId ? { userId: meta.userId } : {}),
      ...(meta.input !== undefined ? { input: truncate(meta.input) } : {}),
      ...(meta.metadata ? { metadata: meta.metadata } : {}),
      ...(meta.tags ? { tags: meta.tags } : {}),
    },
  });

  try {
    return await traceStore.run({ traceId, sessionId: meta.sessionId }, fn);
  } finally {
    await flush();
  }
}

/** The active trace id, if a `runWithTrace` scope is on the stack. */
export function currentTraceId(): string | undefined {
  return traceStore.getStore()?.traceId;
}

/**
 * Record a single model call as a Langfuse generation. Attaches to the active
 * trace; if there is none, a standalone trace is created so the generation is
 * still visible. No-op (and never throws) when Langfuse is disabled.
 */
export async function recordGeneration(params: {
  name: string;
  model: string;
  engine?: string;
  input?: unknown;
  output?: unknown;
  usage?: TokenUsage;
  startTime?: Date;
  endTime?: Date;
  level?: "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!isLangfuseEnabled()) return;
  try {
    const ctx = traceStore.getStore();
    let traceId = ctx?.traceId;
    let standalone = false;

    if (!traceId) {
      // No pipeline scope (e.g. a one-off call) — emit an enclosing trace.
      traceId = randomUUID();
      standalone = true;
      buffer.push({
        id: randomUUID(),
        type: "trace-create",
        timestamp: new Date().toISOString(),
        body: { id: traceId, name: params.name, timestamp: new Date().toISOString() },
      });
    }

    const usageDetails = params.usage ? toUsageDetails(params.usage) : undefined;
    const costDetails = params.usage ? computeCost(params.model, params.usage) : undefined;

    buffer.push({
      id: randomUUID(),
      type: "generation-create",
      timestamp: new Date().toISOString(),
      body: {
        id: randomUUID(),
        traceId,
        name: params.name,
        model: params.model,
        startTime: (params.startTime ?? new Date()).toISOString(),
        endTime: (params.endTime ?? new Date()).toISOString(),
        ...(params.input !== undefined ? { input: truncate(params.input) } : {}),
        ...(params.output !== undefined ? { output: truncate(params.output) } : {}),
        ...(usageDetails ? { usageDetails } : {}),
        ...(costDetails ? { costDetails } : {}),
        ...(params.level ? { level: params.level } : {}),
        ...(params.statusMessage ? { statusMessage: params.statusMessage } : {}),
        metadata: {
          ...(params.engine ? { engine: params.engine } : {}),
          ...(params.metadata ?? {}),
        },
      },
    });

    // Standalone generations have no trace scope to flush them, so flush now.
    if (standalone) await flush();
  } catch (err) {
    log.warn("langfuse", `recordGeneration failed: ${(err as Error).message}`);
  }
}

/** POST any buffered events to Langfuse. Errors are logged, never thrown. */
export async function flush(): Promise<void> {
  const settings = resolveSettings();
  if (!settings || buffer.length === 0) return;

  const batch = buffer;
  buffer = [];

  try {
    const auth = Buffer.from(
      `${settings.publicKey}:${settings.secretKey}`,
    ).toString("base64");
    const res = await fetch(`${settings.baseUrl}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ batch }),
    });
    if (!res.ok && res.status !== 207) {
      const text = await res.text().catch(() => "");
      log.warn("langfuse", `ingestion HTTP ${res.status}: ${text.slice(0, 300)}`);
    } else {
      log.info("langfuse", `flushed ${batch.length} event(s)`);
    }
  } catch (err) {
    // Network failure must never break generation — drop the batch.
    log.warn("langfuse", `ingestion failed: ${(err as Error).message}`);
  }
}
