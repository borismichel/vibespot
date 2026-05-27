/**
 * Stage-prompt registry (VIB-1769, Langfuse Phase 3 — prompt management).
 *
 * Single accessor for the editable stage *instruction* prompts. Each stage
 * prompt has a pinned version and a guaranteed in-code local fallback
 * (`LOCAL_STAGE_PROMPTS`). At build time, `scripts/sync-prompts.ts` compiles the
 * Langfuse-managed versions into `assets/prompts.bundle.json` (bundle-at-build);
 * at runtime the registry prefers that compiled bundle and otherwise renders the
 * local fallback. Nothing here touches the network, so a Langfuse outage can
 * never change generation behavior — it only affects the *next build's* bundle.
 *
 * Templates use `{{placeholder}}` tokens, substituted from a fixed, allow-listed
 * set of CONTROLLED values (theme name, computed module/CSS summaries) — never
 * raw user input, and via a single-pass replace that never re-scans inserted
 * values. That is the "no untrusted interpolation" guarantee in the ticket.
 *
 * The large static `.md` guides are deliberately NOT managed here: they stay as
 * cached file blocks appended by the stage builders (Anthropic prompt caching).
 */

import { readFile, resolveAsset } from "../../../utils/fs.js";
import { LOCAL_STAGE_PROMPTS, type StagePromptId } from "./managed/local-prompts.js";

export type { StagePromptId };
export type StagePromptSource = "langfuse-bundled" | "local-fallback";

export interface StagePromptSelection {
  id: StagePromptId;
  version: number;
  source: StagePromptSource;
  template: string;
}

interface BundleEntry {
  version: number;
  label?: string;
  placeholders?: string[];
  template: string;
}

export interface PromptBundle {
  generatedAt?: string;
  /** Where the bundle came from: "langfuse" (real pull) or "local-seed". */
  source?: string;
  prompts: Record<string, BundleEntry>;
}

const BUNDLE_ASSET = "prompts.bundle.json";
/** Allow-listed token form: `{{name}}` with optional inner whitespace. */
const TOKEN_RE = /\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g;

// `undefined` = not yet loaded; `null` = absent/invalid (use local fallback).
let bundleCache: PromptBundle | null | undefined;
// Test-only override; when set (incl. to null) it bypasses disk loading.
let bundleOverride: PromptBundle | null | undefined;

function loadBundle(): PromptBundle | null {
  if (bundleOverride !== undefined) return bundleOverride;
  if (bundleCache !== undefined) return bundleCache;
  try {
    const parsed = JSON.parse(readFile(resolveAsset(BUNDLE_ASSET))) as PromptBundle;
    bundleCache = parsed && typeof parsed === "object" && parsed.prompts ? parsed : null;
  } catch {
    bundleCache = null;
  }
  return bundleCache;
}

/** Distinct `{{token}}` names referenced by a template. */
function tokensIn(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(TOKEN_RE)) found.add(m[1]);
  return [...found];
}

/**
 * Pick the active template for a stage: the version-pinned Langfuse-compiled
 * bundle entry when present AND valid, else the in-code local fallback.
 *
 * A bundle entry is accepted only when (a) its version equals the pinned local
 * version and (b) it references no token outside the stage's allow-list. Either
 * failure silently falls back to local — so a stale/missing/tampered bundle can
 * never alter or break generation.
 */
function selectTemplate(id: StagePromptId): StagePromptSelection {
  const local = LOCAL_STAGE_PROMPTS[id];
  const entry = loadBundle()?.prompts?.[id];
  if (entry && entry.version === local.version && typeof entry.template === "string") {
    const allow = new Set(local.placeholders);
    if (tokensIn(entry.template).every((t) => allow.has(t))) {
      return { id, version: entry.version, source: "langfuse-bundled", template: entry.template };
    }
  }
  return { id, version: local.version, source: "local-fallback", template: local.template };
}

/**
 * Single-pass, allow-listed token substitution. Unknown tokens are left literal
 * (never an error that could break a build). Inserted values are NOT re-scanned,
 * so a value that happens to contain `{{...}}` can never trigger interpolation.
 */
function substitute(id: StagePromptId, template: string, vars: Record<string, string>): string {
  const allow = new Set(LOCAL_STAGE_PROMPTS[id].placeholders);
  return template.replace(TOKEN_RE, (whole, key: string) =>
    allow.has(key) ? (vars[key] ?? "") : whole,
  );
}

/** Inspect which template/version/source a stage would use (diagnostics/telemetry). */
export function getStagePrompt(id: StagePromptId): StagePromptSelection {
  return selectTemplate(id);
}

/**
 * Render a stage's instruction prompt: pick the pinned template (bundle or local
 * fallback) and substitute the controlled `vars`. This is what the stage prompt
 * builders call in place of an inline template literal.
 */
export function renderStagePrompt(id: StagePromptId, vars: Record<string, string>): string {
  return substitute(id, selectTemplate(id).template, vars);
}

/** Test/sync helper — reset the memoized on-disk bundle. */
export function _resetPromptBundleCache(): void {
  bundleCache = undefined;
}

/** Test-only — force the active bundle (`null` to simulate "no bundle"). */
export function _setPromptBundleForTest(bundle: PromptBundle | null | undefined): void {
  bundleOverride = bundle;
}
