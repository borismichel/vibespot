/**
 * Provider resolution for the eval harness (VIB-1768).
 *
 * A "provider" under test is an (engine, model, apiKey) triple. The harness
 * compares whichever providers the operator selects with `--providers=…` (or
 * `EVAL_PROVIDERS`), resolving keys from `~/.vibespot/config.json` / env via the
 * same `getApiKeyForEngine` the app uses. Providers with no key are skipped
 * with a warning (so a 3-way request degrades gracefully to whatever is keyed).
 */

import {
  loadConfig,
  getApiKeyForEngine,
  type VibeSpotConfig,
} from "../../src/utils/config.js";
import type { AgentEngine } from "../../src/server/agent/engine-adapter.js";

export interface Provider {
  /** Short label used in reports / CLI / Langfuse run names. */
  id: string;
  engine: AgentEngine;
  model: string;
  apiKey: string;
}

interface ProviderDef {
  id: string;
  engine: AgentEngine;
  defaultModel: (cfg: VibeSpotConfig) => string;
  /** Engine used purely for key lookup (langdock keys off its own field). */
  keyEngine: Parameters<typeof getApiKeyForEngine>[0];
}

const PROVIDER_DEFS: Record<string, ProviderDef> = {
  anthropic: {
    id: "anthropic",
    engine: "anthropic-api",
    defaultModel: (c) => c.anthropicApiModel || "claude-sonnet-4-20250514",
    keyEngine: "anthropic-api",
  },
  openai: {
    id: "openai",
    engine: "openai-api",
    defaultModel: (c) => c.openaiApiModel || "gpt-4o",
    keyEngine: "openai-api",
  },
  gemini: {
    id: "gemini",
    engine: "gemini-api",
    defaultModel: (c) => c.geminiApiModel || "gemini-2.5-flash",
    keyEngine: "gemini-api",
  },
  langdock: {
    id: "langdock",
    engine: "langdock-api",
    defaultModel: (c) => c.langdockApiModel || "claude-sonnet-4-20250514",
    keyEngine: "langdock-api",
  },
};

export const KNOWN_PROVIDER_IDS = Object.keys(PROVIDER_DEFS);

export interface ResolveResult {
  resolved: Provider[];
  skipped: { id: string; reason: string }[];
}

/**
 * Resolve the requested provider ids to runnable providers. Unknown ids and
 * those missing an API key are reported in `skipped` rather than throwing.
 */
export function resolveProviders(ids: string[]): ResolveResult {
  const cfg = loadConfig();
  const resolved: Provider[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const rawId of ids) {
    const id = rawId.trim().toLowerCase();
    if (!id) continue;
    const def = PROVIDER_DEFS[id];
    if (!def) {
      skipped.push({ id, reason: `unknown provider (known: ${KNOWN_PROVIDER_IDS.join(", ")})` });
      continue;
    }
    const apiKey = getApiKeyForEngine(def.keyEngine, cfg);
    if (!apiKey) {
      skipped.push({ id, reason: "no API key in config or env" });
      continue;
    }
    resolved.push({ id: def.id, engine: def.engine, model: def.defaultModel(cfg), apiKey });
  }

  return { resolved, skipped };
}

/**
 * Pick a judge provider: explicit id if keyed, else the first resolved provider
 * that is keyed (any strong model judges adequately). Returns null if none.
 */
export function resolveJudge(
  preferredId: string | undefined,
  fallbacks: Provider[],
): Provider | null {
  if (preferredId) {
    const { resolved } = resolveProviders([preferredId]);
    if (resolved[0]) return resolved[0];
  }
  return fallbacks[0] ?? null;
}
