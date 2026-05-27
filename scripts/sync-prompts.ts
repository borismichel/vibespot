/**
 * sync-prompts — compile the editable stage-instruction prompts into the
 * shipped bundle (VIB-1769, Langfuse Phase 3 "bundle-at-build").
 *
 * Two modes:
 *   --from-local    Seed the bundle from the in-code LOCAL_STAGE_PROMPTS. No
 *                   network, no keys. Use to bootstrap or after editing the
 *                   local fallback. (Default when no Langfuse keys are present.)
 *   (default)       Pull each stage prompt from Langfuse at its PINNED version
 *                   and compile it into the bundle. Requires langfusePublicKey /
 *                   langfuseSecretKey (config or LANGFUSE_* env).
 *
 * The output (assets/prompts.bundle.json) is committed and shipped in the npm
 * package, then inlined by the registry at runtime — so users' machines never
 * call Langfuse. A failed pull never writes a partial bundle; the last committed
 * bundle (and the in-code fallback) keep generation behavior stable.
 *
 * Usage:
 *   npm run prompts:pull                 # Langfuse pull (or local seed w/o keys)
 *   tsx scripts/sync-prompts.ts --from-local
 *   tsx scripts/sync-prompts.ts --dry-run
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_STAGE_PROMPTS,
  type StagePromptId,
} from "../src/server/agent/prompts/managed/local-prompts.js";
import { loadConfig } from "../src/utils/config.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(REPO_ROOT, "assets", "prompts.bundle.json");
const DEFAULT_BASE_URL = "https://cloud.langfuse.com";

/** Langfuse prompt name for a stage id. Keep stable — it's the Langfuse key. */
function langfuseName(id: StagePromptId): string {
  return `vibespot-stage-${id}`;
}

const TOKEN_RE = /\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g;
function tokensIn(template: string): string[] {
  return [...new Set([...template.matchAll(TOKEN_RE)].map((m) => m[1]))];
}

interface BundleEntry {
  version: number;
  label?: string;
  placeholders: string[];
  template: string;
}
interface Bundle {
  generatedAt: string;
  source: "local-seed" | "langfuse";
  prompts: Record<string, BundleEntry>;
}

/** Validate a template against a stage's allow-list (no untrusted interpolation). */
function assertPlaceholders(id: StagePromptId, template: string): void {
  const allow = new Set(LOCAL_STAGE_PROMPTS[id].placeholders);
  const unknown = tokensIn(template).filter((t) => !allow.has(t));
  if (unknown.length > 0) {
    throw new Error(`Prompt "${id}" references disallowed placeholders: ${unknown.join(", ")}`);
  }
}

function buildFromLocal(): Bundle {
  const prompts: Record<string, BundleEntry> = {};
  for (const id of Object.keys(LOCAL_STAGE_PROMPTS) as StagePromptId[]) {
    const p = LOCAL_STAGE_PROMPTS[id];
    assertPlaceholders(id, p.template);
    prompts[id] = { version: p.version, label: "local", placeholders: p.placeholders, template: p.template };
  }
  return { generatedAt: new Date().toISOString(), source: "local-seed", prompts };
}

async function fetchLangfusePrompt(
  baseUrl: string,
  auth: string,
  name: string,
  version: number,
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/public/v2/prompts/${encodeURIComponent(name)}?version=${version}`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    throw new Error(`Langfuse ${res.status} for ${name} v${version}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { type?: string; version?: number; prompt?: unknown };
  if (body.type && body.type !== "text") {
    throw new Error(`Prompt "${name}" is type "${body.type}"; expected a text prompt`);
  }
  if (typeof body.prompt !== "string") {
    throw new Error(`Prompt "${name}" has no string body`);
  }
  if (typeof body.version === "number" && body.version !== version) {
    throw new Error(`Langfuse returned version ${body.version} for ${name}, expected pinned ${version}`);
  }
  return body.prompt;
}

async function buildFromLangfuse(): Promise<Bundle> {
  const cfg = loadConfig();
  const publicKey = cfg.langfusePublicKey || process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = cfg.langfuseSecretKey || process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = cfg.langfuseBaseUrl || process.env.LANGFUSE_BASE_URL || DEFAULT_BASE_URL;
  if (!publicKey || !secretKey) {
    throw new Error("Langfuse keys missing (langfusePublicKey/langfuseSecretKey or LANGFUSE_* env)");
  }
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");

  const prompts: Record<string, BundleEntry> = {};
  for (const id of Object.keys(LOCAL_STAGE_PROMPTS) as StagePromptId[]) {
    const pinned = LOCAL_STAGE_PROMPTS[id];
    const name = langfuseName(id);
    const template = await fetchLangfusePrompt(baseUrl, auth, name, pinned.version);
    assertPlaceholders(id, template); // reject prompts that add untrusted tokens
    prompts[id] = { version: pinned.version, label: name, placeholders: pinned.placeholders, template };
    console.log(`  ✓ ${id} ← ${name} v${pinned.version} (${template.length} chars)`);
  }
  return { generatedAt: new Date().toISOString(), source: "langfuse", prompts };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const cfg = loadConfig();
  const hasKeys = Boolean(
    (cfg.langfusePublicKey || process.env.LANGFUSE_PUBLIC_KEY) &&
      (cfg.langfuseSecretKey || process.env.LANGFUSE_SECRET_KEY),
  );
  const fromLocal = args.includes("--from-local") || !hasKeys;

  if (fromLocal && !args.includes("--from-local")) {
    console.log("No Langfuse keys found — seeding bundle from in-code local fallback.");
  }

  const bundle = fromLocal ? buildFromLocal() : await buildFromLangfuse();
  const json = JSON.stringify(bundle, null, 2) + "\n";

  if (dryRun) {
    console.log(json);
    console.log(`[dry-run] would write ${OUT_PATH}`);
    return;
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, json);
  console.log(`Wrote ${OUT_PATH} (source: ${bundle.source}, ${Object.keys(bundle.prompts).length} prompts)`);
}

main().catch((err) => {
  console.error("sync-prompts failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
