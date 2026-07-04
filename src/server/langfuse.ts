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
 *  - Grouped & nested (via AsyncLocalStorage): one trace per user action
 *    (`runWithTrace`), a span per pipeline stage (`runWithSpan`), and a
 *    generation per model call. Generations attach to the innermost active
 *    span via `parentObservationId`, so a full page reads as
 *    trace → stage spans → generations, with token cost rolling up.
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
  type CostDetails,
} from "./pricing.js";
import { recordCostSample } from "./cost-tracker.js";

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
// Default cap for serialized fields (trace/span I/O — these are deliberately
// compact summaries, so a tight cap keeps the Traces list and span views lean).
const MAX_FIELD_CHARS = 24_000;
// Generations carry the real model I/O. For API engines we have the full SDK
// request (system prompt + guide blocks + messages) and response, and that's
// the whole point of a generation — so use a much larger cap to keep them
// effectively full while still guarding against a pathological multi-MB blob.
const MAX_GENERATION_FIELD_CHARS = 200_000;

interface LangfuseSettings {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

interface IngestionEvent {
  id: string;
  type: "trace-create" | "span-create" | "generation-create";
  timestamp: string;
  body: Record<string, unknown>;
}

interface TraceContext {
  traceId: string;
  sessionId?: string;
  /** Innermost active span observation id — set by `runWithSpan`. */
  spanId?: string;
}

const traceStore = new AsyncLocalStorage<TraceContext>();
let buffer: IngestionEvent[] = [];

// ---------------------------------------------------------------------------
// Usage observers — an in-process hook on every completed model call.
//
// `reportModelUsage` notifies registered observers with the normalized usage,
// the estimated cost (via the shipped `computeCost`), and wall-clock latency.
// This is independent of Langfuse: it fires whether or not Langfuse is
// configured. With no observer registered it is a no-op, so production code
// paths are entirely unaffected — it exists so dev/CI tooling (the eval
// harness) can aggregate token cost + latency without re-plumbing every
// engine. Observers must never throw; errors are swallowed.
// ---------------------------------------------------------------------------

/** A single completed model call, as seen by a usage observer. */
export interface ModelUsageReport {
  engine: string;
  model: string;
  name: string;
  usage?: TokenUsage;
  cost?: CostDetails;
  startTime: Date;
  endTime: Date;
  durationMs: number;
}

type ModelUsageObserver = (report: ModelUsageReport) => void;
const usageObservers = new Set<ModelUsageObserver>();

/**
 * Register an observer notified for every completed model call. Returns an
 * unsubscribe function. Intended for dev/CI instrumentation (e.g. the eval
 * harness), not production hot paths.
 */
export function onModelUsage(observer: ModelUsageObserver): () => void {
  usageObservers.add(observer);
  return () => {
    usageObservers.delete(observer);
  };
}

function resolveSettings(): LangfuseSettings | null {
  const cfg = loadConfig();
  const publicKey = cfg.langfusePublicKey || process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = cfg.langfuseSecretKey || process.env.LANGFUSE_SECRET_KEY;
  // Off by default: requires an explicit opt-in, not just the presence of keys.
  // A user who happens to have LANGFUSE_* in their environment never has traces
  // sent unless they turn it on (`langfuseEnabled: true` in config, the AI
  // Settings toggle, or `LANGFUSE_ENABLED=true`). Keys are still required to send.
  const enabled =
    cfg.langfuseEnabled === true || process.env.LANGFUSE_ENABLED === "true";
  if (!enabled || !publicKey || !secretKey) return null;
  const baseUrl = (
    cfg.langfuseBaseUrl ||
    process.env.LANGFUSE_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  return { publicKey, secretKey, baseUrl };
}

/** True only when Langfuse is explicitly enabled AND both keys are configured. */
export function isLangfuseEnabled(): boolean {
  return resolveSettings() !== null;
}

function truncate(value: unknown, max: number = MAX_FIELD_CHARS): unknown {
  if (typeof value === "string") {
    return value.length > max
      ? value.slice(0, max) + `…[+${value.length - max} chars]`
      : value;
  }
  try {
    const json = JSON.stringify(value);
    if (json && json.length > max) {
      return json.slice(0, max) + `…[+${json.length - max} chars]`;
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
    // Fire-and-forget: this finally sits on the generation critical path, and
    // awaiting a stalled ingestion endpoint held "generation complete" hostage
    // for minutes (VIB-1894). flush() swallows its own errors.
    void flush();
  }
}

/** The active trace id, if a `runWithTrace` scope is on the stack. */
export function currentTraceId(): string | undefined {
  return traceStore.getStore()?.traceId;
}

/** The innermost active span id, if a `runWithSpan` scope is on the stack. */
export function currentSpanId(): string | undefined {
  return traceStore.getStore()?.spanId;
}

/**
 * Set the output on the active trace — an end-of-run result summary that gives
 * the Langfuse Traces list a meaningful preview (VIB-1862). Traces are id-keyed
 * and upserted by the ingestion API, so this emits a second `trace-create` for
 * the same trace id carrying only the output; Langfuse merges it onto the
 * existing trace. Truncated like every other field. No-op (and never throws)
 * when Langfuse is disabled or there is no active `runWithTrace` scope.
 */
export function setTraceOutput(output: unknown): void {
  if (!isLangfuseEnabled()) return;
  const ctx = traceStore.getStore();
  if (!ctx?.traceId) return;
  buffer.push({
    id: randomUUID(),
    type: "trace-create",
    timestamp: new Date().toISOString(),
    body: {
      id: ctx.traceId,
      timestamp: new Date().toISOString(),
      output: truncate(output),
    },
  });
}

/**
 * Run `fn` inside a Langfuse span nested under the active trace. Every
 * `recordGeneration` made while `fn` runs (including parallel awaited work)
 * attaches to this span via `parentObservationId`, and spans nest under each
 * other the same way — giving a `trace → stage span → N generations` shape.
 *
 * No-op pass-through when Langfuse is disabled or there is no active trace
 * (a span with no enclosing trace has nothing to attach to).
 */
export async function runWithSpan<T>(
  name: string,
  fn: () => Promise<T>,
  opts?: { input?: unknown; metadata?: Record<string, unknown> },
): Promise<T> {
  const ctx = traceStore.getStore();
  if (!isLangfuseEnabled() || !ctx?.traceId) return fn();

  const spanId = randomUUID();
  const parentObservationId = ctx.spanId;
  const startTime = new Date();
  let level: "ERROR" | undefined;
  let statusMessage: string | undefined;

  try {
    return await traceStore.run({ ...ctx, spanId }, fn);
  } catch (err) {
    level = "ERROR";
    statusMessage = (err as Error)?.message;
    throw err;
  } finally {
    // Emit one span-create with both start and end. Langfuse is id-keyed and
    // eventually consistent, so the span can land after the generations that
    // reference it as their parent.
    buffer.push({
      id: randomUUID(),
      type: "span-create",
      timestamp: new Date().toISOString(),
      body: {
        id: spanId,
        traceId: ctx.traceId,
        name,
        startTime: startTime.toISOString(),
        endTime: new Date().toISOString(),
        ...(parentObservationId ? { parentObservationId } : {}),
        ...(opts?.input !== undefined ? { input: truncate(opts.input) } : {}),
        ...(opts?.metadata ? { metadata: opts.metadata } : {}),
        ...(level ? { level } : {}),
        ...(statusMessage ? { statusMessage } : {}),
      },
    });
  }
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
  /** Langfuse prompt linkage — the managed stage prompt that drove this call. */
  promptName?: string;
  promptVersion?: number;
}): Promise<void> {
  if (!isLangfuseEnabled()) return;
  try {
    const ctx = traceStore.getStore();
    let traceId = ctx?.traceId;
    // Nest under the active stage span (if any) so generations group under
    // their stage. Only valid when we have a real (non-standalone) trace.
    const parentObservationId = traceId ? ctx?.spanId : undefined;
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
        ...(parentObservationId ? { parentObservationId } : {}),
        name: params.name,
        model: params.model,
        startTime: (params.startTime ?? new Date()).toISOString(),
        endTime: (params.endTime ?? new Date()).toISOString(),
        ...(params.input !== undefined ? { input: truncate(params.input, MAX_GENERATION_FIELD_CHARS) } : {}),
        ...(params.output !== undefined ? { output: truncate(params.output, MAX_GENERATION_FIELD_CHARS) } : {}),
        ...(usageDetails ? { usageDetails } : {}),
        ...(costDetails ? { costDetails } : {}),
        ...(params.level ? { level: params.level } : {}),
        ...(params.statusMessage ? { statusMessage: params.statusMessage } : {}),
        // Link to the managed prompt (VIB-1861) so the Langfuse UI surfaces
        // per-prompt-version cost/latency/quality. `promptVersion` is sent only
        // alongside a name (a version with no name has nothing to link to).
        ...(params.promptName
          ? {
              promptName: params.promptName,
              ...(params.promptVersion != null ? { promptVersion: params.promptVersion } : {}),
            }
          : {}),
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

/**
 * Instrument a completed model call: emit a structured `agent-usage` cost log
 * (always, when usage is known) and a Langfuse generation (only when Langfuse
 * is configured). The single chokepoint shared by the agentic engine adapter
 * and the direct-SDK paths (streaming chat, design/brand extraction) so every
 * AI call is captured the same way. Best-effort — never throws.
 */
export function reportModelUsage(params: {
  engine: string;
  model: string;
  name: string;
  input?: unknown;
  output?: unknown;
  usage?: TokenUsage;
  startTime: Date;
  endTime: Date;
  level?: "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  metadata?: Record<string, unknown>;
  /** Langfuse prompt linkage — the managed stage prompt that drove this call. */
  promptName?: string;
  promptVersion?: number;
}): void {
  const { engine, model, name, usage, startTime, endTime } = params;
  const durationMs = endTime.getTime() - startTime.getTime();
  const cost = usage ? computeCost(model, usage) : undefined;
  if (usage) {
    log.info("agent-usage", `${engine} ${name}`, {
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: cost?.total,
      durationMs,
    });
  }
  if (usageObservers.size > 0) {
    const report: ModelUsageReport = {
      engine,
      model,
      name,
      usage,
      cost,
      startTime,
      endTime,
      durationMs,
    };
    for (const observer of usageObservers) {
      try {
        observer(report);
      } catch {
        /* observers must never break a generation */
      }
    }
  }
  // Accumulate into the active per-generation cost scope (VIB-1770), if any.
  // No-op outside a `runWithCostTracking` scope or when usage is unknown, so
  // the legacy single-call paths that share this chokepoint don't contribute.
  recordCostSample(model, usage);
  void recordGeneration({
    name,
    model,
    engine,
    input: params.input,
    output: params.output,
    usage,
    startTime,
    endTime,
    level: params.level,
    statusMessage: params.statusMessage,
    metadata: params.metadata,
    promptName: params.promptName,
    promptVersion: params.promptVersion,
  });
}

/**
 * Hard deadline on the telemetry POST so a black-holed endpoint can never
 * stall a caller — telemetry must never block generation (VIB-1894).
 */
const FLUSH_TIMEOUT_MS = 10_000;

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
      signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
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
