/**
 * Brand enrichment for imported themes.
 *
 * HubSpot imports arrive as finished code, not as vibeSpot-authored planning
 * context. This best-effort pass extracts brand assets immediately after the
 * theme is scanned so future AI edits inherit the imported design and copy.
 */

import { join } from "node:path";
import type { VibeSession } from "./session/types.js";
import { ensureDir, writeFile } from "../utils/fs.js";
import { loadConfig } from "../utils/config.js";
import { log } from "./log.js";

export type EnrichedBrandAsset = "styleguide" | "brandvoice" | "themeContext";

export interface BrandEnrichmentError {
  asset: EnrichedBrandAsset;
  message: string;
}

export interface BrandEnrichmentResult {
  attempted: EnrichedBrandAsset[];
  extracted: EnrichedBrandAsset[];
  skipped: EnrichedBrandAsset[];
  errors: BrandEnrichmentError[];
}

interface BrandEnrichmentDependencies {
  extractStyleguide: (session: VibeSession) => Promise<string | null>;
  extractBrandvoice: (session: VibeSession, previewHtml: string) => Promise<string | null>;
  extractThemeContext: (session: VibeSession, previewHtml: string) => Promise<string | null>;
  buildPreviewHtml: () => string;
}

export function missingBrandAssets(session: VibeSession): EnrichedBrandAsset[] {
  const missing: EnrichedBrandAsset[] = [];
  if (!session.brandAssets?.styleguide) missing.push("styleguide");
  if (!session.brandAssets?.brandvoice) missing.push("brandvoice");
  if (!session.brandAssets?.themeContext) missing.push("themeContext");
  return missing;
}

export function saveBrandAssetToTheme(
  session: VibeSession,
  type: EnrichedBrandAsset,
  content: string,
): void {
  if (!session.brandAssets) session.brandAssets = {};
  session.brandAssets[type] = content;
  session.updatedAt = Date.now();

  const filename = type === "themeContext" ? "theme-context.md" : `${type}.md`;
  const assetDir = join(session.themePath, ".vibespot");
  ensureDir(assetDir);
  writeFile(join(assetDir, filename), content);
}

/**
 * Extract missing brand assets for an imported theme.
 *
 * Each asset is independent and failure-tolerant: missing API credentials,
 * provider errors, or thin preview content should not make the import fail.
 */
export async function enrichImportedThemeBrandAssets(
  session: VibeSession,
  deps?: Partial<BrandEnrichmentDependencies>,
): Promise<BrandEnrichmentResult> {
  const missing = missingBrandAssets(session);
  const result: BrandEnrichmentResult = {
    attempted: [],
    extracted: [],
    skipped: [],
    errors: [],
  };

  if (missing.length === 0) return result;

  const resolved = hasCompleteDependencies(deps)
    ? deps
    : { ...(await defaultDependencies(session)), ...(deps ?? {}) };

  if (missing.includes("styleguide")) {
    await attemptAsset(session, "styleguide", result, () => resolved.extractStyleguide!(session));
  }

  const copyAssets = missing.filter((asset) => asset === "brandvoice" || asset === "themeContext");
  if (copyAssets.length === 0) return result;

  let previewHtml = "";
  try {
    previewHtml = resolved.buildPreviewHtml!();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const asset of copyAssets) {
      result.skipped.push(asset);
      result.errors.push({ asset, message: `Could not render preview HTML: ${message}` });
    }
    return result;
  }

  if (!previewHtml || previewHtml.length < 50) {
    for (const asset of copyAssets) result.skipped.push(asset);
    return result;
  }

  if (missing.includes("brandvoice")) {
    await attemptAsset(session, "brandvoice", result, () => resolved.extractBrandvoice!(session, previewHtml));
  }
  if (missing.includes("themeContext")) {
    await attemptAsset(session, "themeContext", result, () => resolved.extractThemeContext!(session, previewHtml));
  }

  return result;
}

async function attemptAsset(
  session: VibeSession,
  asset: EnrichedBrandAsset,
  result: BrandEnrichmentResult,
  extract: () => Promise<string | null>,
): Promise<void> {
  result.attempted.push(asset);
  try {
    const content = await extract();
    if (!content) {
      result.skipped.push(asset);
      return;
    }
    saveBrandAssetToTheme(session, asset, content);
    result.extracted.push(asset);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.skipped.push(asset);
    result.errors.push({ asset, message });
    log.warn("brand-enrichment", `${asset} enrichment skipped: ${message}`);
  }
}

function hasCompleteDependencies(deps: Partial<BrandEnrichmentDependencies> | undefined): deps is BrandEnrichmentDependencies {
  return !!deps?.extractStyleguide &&
    !!deps.extractBrandvoice &&
    !!deps.extractThemeContext &&
    !!deps.buildPreviewHtml;
}

async function defaultDependencies(session: VibeSession): Promise<BrandEnrichmentDependencies> {
  const { extractDesignContext } = await import("../ai/design-extractor.js");
  const { buildPreviewHtml } = await import("./preview.js");
  const { resolveAgenticEngine } = await import("./ai-handler.js");
  const { extractBrandvoice } = await import("./agent/stages/brandvoice-extractor.js");
  const { extractThemeContext } = await import("./agent/stages/context-extractor.js");

  const config = loadConfig();

  return {
    extractStyleguide: () => extractDesignContext(session.themePath),
    buildPreviewHtml,
    extractBrandvoice: async (_session, previewHtml) => {
      const { engine, apiKey, model } = resolveAgenticEngine(config);
      return extractBrandvoice(previewHtml, engine, apiKey, model);
    },
    extractThemeContext: async (activeSession, previewHtml) => {
      const { engine, apiKey, model } = resolveAgenticEngine(config);
      return extractThemeContext(previewHtml, activeSession.brandAssets?.themeContext, engine, apiKey, model);
    },
  };
}
