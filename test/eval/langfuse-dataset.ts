/**
 * Langfuse dataset + experiment sync for the eval harness (VIB-1768).
 *
 * Optional (`--langfuse`). Mirrors the dependency-free, fail-safe style of
 * `src/server/langfuse.ts`: direct calls to the stable public API, every error
 * swallowed so a Langfuse outage never breaks an eval run.
 *
 *   dataset            → one per harness  (the ≥5 reference pages)
 *   dataset item       → one per EvalItem (input = brief, expected = rubric)
 *   dataset run        → one per provider per invocation (runName)
 *   dataset run item   → links a provider's trace to the item it answered
 *   scores             → accuracy / cost / latency attached to each trace
 *
 * This is what turns the local run into a Langfuse "experiment": each provider
 * is a run over the shared dataset, and scores roll up per run for comparison
 * in the Langfuse UI.
 */

import { loadConfig } from "../../src/utils/config.js";
import { EVAL_DATASET, type EvalItem } from "./dataset.js";

const DATASET_NAME = "vibespot-module-eval";

interface LangfuseAuth {
  baseUrl: string;
  authHeader: string;
}

function resolveAuth(): LangfuseAuth | null {
  const cfg = loadConfig();
  const publicKey = cfg.langfusePublicKey || process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = cfg.langfuseSecretKey || process.env.LANGFUSE_SECRET_KEY;
  const disabled =
    cfg.langfuseEnabled === false || process.env.LANGFUSE_ENABLED === "false";
  if (disabled || !publicKey || !secretKey) return null;
  const baseUrl = (
    cfg.langfuseBaseUrl || process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com"
  ).replace(/\/+$/, "");
  const authHeader =
    "Basic " + Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  return { baseUrl, authHeader };
}

export function isLangfuseDatasetEnabled(): boolean {
  return resolveAuth() !== null;
}

async function post(auth: LangfuseAuth, path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${auth.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth.authHeader },
      body: JSON.stringify(body),
    });
    // 200/201 created, 409 already-exists are both fine for our idempotent upserts.
    return res.ok || res.status === 409;
  } catch {
    return false;
  }
}

/** Create the dataset and upsert one item per reference page. Idempotent. */
export async function syncDataset(items: EvalItem[] = EVAL_DATASET): Promise<boolean> {
  const auth = resolveAuth();
  if (!auth) return false;

  await post(auth, "/api/public/v2/datasets", {
    name: DATASET_NAME,
    description: "vibeSpot provider-comparison eval — reference landing-page briefs (VIB-1768).",
    metadata: { source: "test/eval/dataset.ts", itemCount: items.length },
  });

  let ok = true;
  for (const item of items) {
    const created = await post(auth, "/api/public/dataset-items", {
      id: item.id,
      datasetName: DATASET_NAME,
      input: { brief: item.brief, contentType: item.contentType },
      expectedOutput: { expectedModules: item.expectedModules, rubric: item.rubric },
      metadata: { title: item.title },
    });
    ok = ok && created;
  }
  return ok;
}

/** Link a provider's trace for an item into the named dataset run. */
export async function linkRunItem(params: {
  runName: string;
  itemId: string;
  traceId: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const auth = resolveAuth();
  if (!auth) return false;
  return post(auth, "/api/public/dataset-run-items", {
    runName: params.runName,
    datasetItemId: params.itemId,
    traceId: params.traceId,
    metadata: params.metadata,
  });
}

/** Attach a numeric score to a trace (accuracy / cost / latency / coverage). */
export async function pushScore(params: {
  traceId: string;
  name: string;
  value: number;
  comment?: string;
}): Promise<boolean> {
  const auth = resolveAuth();
  if (!auth) return false;
  return post(auth, "/api/public/scores", {
    traceId: params.traceId,
    name: params.name,
    value: params.value,
    dataType: "NUMERIC",
    ...(params.comment ? { comment: params.comment } : {}),
  });
}

export { DATASET_NAME };
