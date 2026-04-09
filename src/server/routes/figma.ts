/**
 * HTTP routes for Figma design import.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { jsonResponse, readJsonBody } from "../route-helpers.js";
import { loadConfig } from "../../utils/config.js";
import { log } from "../log.js";
import { parseFigmaUrl, extractFigmaDesign, buildExtractionSummary, testFigmaToken } from "../figma/extractor.js";
import type { FigmaExtraction } from "../figma/types.js";
import { getSession } from "../session.js";

// ---------------------------------------------------------------------------
// In-memory extraction cache (avoids sending large data through WebSocket)
// ---------------------------------------------------------------------------

const extractionCache = new Map<string, { extraction: FigmaExtraction; expires: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function cleanCache(): void {
  const now = Date.now();
  for (const [id, entry] of extractionCache) {
    if (entry.expires < now) extractionCache.delete(id);
  }
}

export function getCachedExtraction(id: string): FigmaExtraction | null {
  cleanCache();
  const entry = extractionCache.get(id);
  if (!entry) return null;
  extractionCache.delete(id); // one-time use
  return entry.extraction;
}

// ---------------------------------------------------------------------------
// POST /api/figma/test-token
// ---------------------------------------------------------------------------

export function handleFigmaTestTokenRoute(req: IncomingMessage, res: ServerResponse): void {
  readJsonBody<{ token?: string }>(req, res, async (body) => {
    const token = body.token || loadConfig().figmaToken;
    if (!token) {
      jsonResponse(res, 400, { ok: false, error: "No Figma token provided" });
      return;
    }

    try {
      const user = await testFigmaToken(token);
      jsonResponse(res, 200, { ok: true, user });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("figma", `Token test failed: ${msg}`);
      jsonResponse(res, 200, { ok: false, error: "Invalid or expired Figma token" });
    }
  });
}

// ---------------------------------------------------------------------------
// POST /api/figma/extract
// ---------------------------------------------------------------------------

export function handleFigmaExtractRoute(req: IncomingMessage, res: ServerResponse): void {
  readJsonBody<{ url?: string; token?: string }>(req, res, async (body) => {
    const url = body.url;
    if (!url) {
      jsonResponse(res, 400, { error: "Missing 'url' field" });
      return;
    }

    const token = body.token || loadConfig().figmaToken;
    if (!token) {
      jsonResponse(res, 400, { error: "No Figma token configured. Add one in Settings." });
      return;
    }

    // Parse the URL
    const parsed = parseFigmaUrl(url);
    if (!parsed) {
      jsonResponse(res, 400, { error: "Not a valid Figma URL. Expected: figma.com/design/<key>/..." });
      return;
    }

    // Determine a temp theme path for frame screenshots
    const session = getSession();
    const themePath = session?.themePath || `/tmp/vibespot-figma-${randomUUID().slice(0, 8)}`;

    try {
      const extraction = await extractFigmaDesign(
        parsed.fileKey,
        parsed.nodeId,
        token,
        themePath,
      );

      // Cache the full extraction for later retrieval via WebSocket
      const extractionId = randomUUID();
      cleanCache();
      extractionCache.set(extractionId, {
        extraction,
        expires: Date.now() + CACHE_TTL,
      });

      const summary = buildExtractionSummary(extraction);

      jsonResponse(res, 200, {
        ok: true,
        extractionId,
        summary,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("figma", `Extraction failed: ${msg}`);

      // Friendly error messages
      if (msg.includes("403")) {
        jsonResponse(res, 200, { ok: false, error: "Cannot access this file. Check sharing permissions and your token." });
      } else if (msg.includes("404")) {
        jsonResponse(res, 200, { ok: false, error: "Figma file not found. Check the URL." });
      } else if (msg.includes("429")) {
        jsonResponse(res, 200, { ok: false, error: "Figma rate limited. Try again in a minute." });
      } else {
        jsonResponse(res, 200, { ok: false, error: msg });
      }
    }
  });
}
