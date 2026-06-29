/**
 * "What's new" release dialog routes (VIB-1885).
 *
 *   GET  /api/whats-new          → { show, content, currentVersion }
 *   POST /api/whats-new/dismiss  → { ok } and persists lastSeenVersion
 *
 * Content is read from assets/whats-new.json (generated from CHANGELOG.md at
 * build/release time by scripts/gen-whats-new.ts). `show` is true only when the
 * asset has highlights AND the installed version differs from the version this
 * user last dismissed (config.lastSeenVersion). The dialog therefore appears
 * once per release and stays dismissed until the next upgrade.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolveAsset, getVersion } from "../../utils/fs.js";
import { loadConfig, saveConfig } from "../../utils/config.js";
import { jsonResponse, readBody } from "../route-helpers.js";

interface WhatsNewHighlight {
  title: string;
  body: string;
}
interface WhatsNewContent {
  version: string;
  date: string;
  changelogUrl: string;
  highlights: WhatsNewHighlight[];
}

/** Load assets/whats-new.json; returns null if missing or malformed (never throws). */
function loadWhatsNewContent(): WhatsNewContent | null {
  try {
    const raw = readFileSync(resolveAsset("whats-new.json"), "utf8");
    const parsed = JSON.parse(raw) as WhatsNewContent;
    if (!parsed || typeof parsed.version !== "string" || !Array.isArray(parsed.highlights)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function handleWhatsNewRoute(res: ServerResponse): void {
  const content = loadWhatsNewContent();
  const current = getVersion();
  const lastSeen = loadConfig().lastSeenVersion;

  // Show only when we have real highlights for the installed version and the
  // user hasn't already dismissed this version. We gate on the asset's own
  // version (what the notes describe) so a stale asset never shows.
  const show =
    !!content &&
    content.highlights.length > 0 &&
    content.version === current &&
    content.version !== lastSeen;

  jsonResponse(res, 200, { show, content: content || null, currentVersion: current });
}

export function handleWhatsNewDismissRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    let version = getVersion();
    try {
      if (body) {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed.version === "string" && parsed.version) version = parsed.version;
      }
    } catch {
      /* no/invalid body — fall back to the installed version */
    }
    saveConfig({ lastSeenVersion: version });
    jsonResponse(res, 200, { ok: true, lastSeenVersion: version });
  });
}
