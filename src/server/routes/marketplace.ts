/**
 * Marketplace routes — validate the active theme against HubSpot
 * Marketplace requirements and read/write the marketplace.json sidecar.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse, readJsonBody } from "../route-helpers.js";
import { getSession, writeModulesToDisk } from "../session.js";
import {
  validateMarketplace,
  applyMarketplaceAutoFixes,
  readMarketplaceMeta,
  writeMarketplaceMeta,
  MARKETPLACE_CATEGORIES,
  type MarketplaceMetadata,
} from "../marketplace.js";

function activeThemePath(res: ServerResponse): string | null {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 400, { error: "No active theme. Open or create a theme first." });
    return null;
  }
  // Make sure the on-disk modules reflect the in-memory session before scanning.
  try {
    writeModulesToDisk();
  } catch { /* best-effort */ }
  return session.themePath;
}

export function handleMarketplaceCheckRoute(_req: IncomingMessage, res: ServerResponse): void {
  const themePath = activeThemePath(res);
  if (!themePath) return;
  const report = validateMarketplace(themePath);
  jsonResponse(res, 200, { report, categories: MARKETPLACE_CATEGORIES });
}

export function handleMarketplaceFixRoute(_req: IncomingMessage, res: ServerResponse): void {
  const themePath = activeThemePath(res);
  if (!themePath) return;
  const fix = applyMarketplaceAutoFixes(themePath);
  const report = validateMarketplace(themePath);
  jsonResponse(res, 200, { fix, report });
}

export function handleMarketplaceListingRoute(
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const themePath = activeThemePath(res);
  if (!themePath) return;

  if (method === "GET") {
    jsonResponse(res, 200, {
      metadata: readMarketplaceMeta(themePath),
      categories: MARKETPLACE_CATEGORIES,
    });
    return;
  }

  if (method === "POST") {
    readJsonBody<MarketplaceMetadata>(req, res, (data) => {
      const meta: MarketplaceMetadata = {
        category: typeof data.category === "string" ? data.category : undefined,
        description: typeof data.description === "string" ? data.description : undefined,
        features: Array.isArray(data.features)
          ? data.features.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          : undefined,
        supportUrl: typeof data.supportUrl === "string" ? data.supportUrl : undefined,
        documentationUrl:
          typeof data.documentationUrl === "string" ? data.documentationUrl : undefined,
        pricingTier: data.pricingTier === "free" || data.pricingTier === "paid" ? data.pricingTier : undefined,
        tags: Array.isArray(data.tags)
          ? data.tags.filter((s): s is string => typeof s === "string")
          : undefined,
      };
      writeMarketplaceMeta(themePath, meta);
      jsonResponse(res, 200, { ok: true, metadata: meta });
    });
    return;
  }

  jsonResponse(res, 405, { error: "Method not allowed" });
}
