/**
 * AI response parser — extracts vibespot-modules JSON from AI responses.
 */

import { updateModules } from "./session.js";
import type { ModuleFiles } from "../ai/engine.js";
import { log } from "./log.js";

/**
 * Try JSON.parse, and if it fails, attempt to repair common AI JSON issues
 * (unescaped quotes inside string values) and retry.
 */
export function tryParseJSON(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    // Fall through to repair
  }

  let repaired = raw;
  let lastPos = -1;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return JSON.parse(repaired);
    } catch (err) {
      if (!(err instanceof SyntaxError)) return null;
      const posMatch = /position (\d+)/.exec(err.message);
      if (!posMatch) return null;
      const pos = parseInt(posMatch[1], 10);
      if (pos <= lastPos) return null;
      lastPos = pos;
      const searchStart = Math.max(0, pos - 5);
      const nearSlice = repaired.slice(searchStart, pos + 1);
      const lastQuote = nearSlice.lastIndexOf('"');
      if (lastQuote === -1) return null;
      const absPos = searchStart + lastQuote;
      if (absPos > 0 && repaired[absPos - 1] === "\\") return null;
      repaired = repaired.slice(0, absPos) + '\\"' + repaired.slice(absPos + 1);
    }
  }
  return null;
}

/**
 * Attempt to salvage a truncated JSON response by finding complete module objects.
 */
export function tryRepairTruncatedJSON(raw: string): Record<string, unknown> | null {
  const modulesIdx = raw.indexOf('"modules"');
  if (modulesIdx === -1) return null;

  const arrayStart = raw.indexOf("[", modulesIdx);
  if (arrayStart === -1) return null;

  let lastCompleteModule = -1;
  let braceDepth = 0;
  let inString = false;
  let escaped = false;

  for (let i = arrayStart + 1; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === "{") braceDepth++;
    if (ch === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        lastCompleteModule = i;
      }
    }
  }

  if (lastCompleteModule === -1) return null;

  const upToLastModule = raw.slice(0, lastCompleteModule + 1);
  const repaired = upToLastModule + "]}";

  const jsonStr = repaired.trimStart().startsWith("{") ? repaired : "{" + repaired;
  return tryParseJSON(jsonStr) as Record<string, unknown> | null;
}

/**
 * Convert a raw module object from AI JSON into a ModuleFiles entry.
 */
function toModuleFiles(m: Record<string, unknown>): ModuleFiles {
  return {
    moduleName: String(m.moduleName || ""),
    fieldsJson: typeof m.fieldsJson === "string"
      ? m.fieldsJson
      : JSON.stringify(m.fieldsJson, null, 2),
    metaJson: typeof m.metaJson === "string"
      ? m.metaJson
      : JSON.stringify(m.metaJson, null, 2),
    moduleHtml: String(m.moduleHtml || ""),
    moduleCss: String(m.moduleCss || ""),
    moduleJs: m.moduleJs ? String(m.moduleJs) : undefined,
  };
}

/**
 * Parse vibespot-modules JSON blocks from an AI response and update the session.
 */
export function parseAndApplyModules(
  response: string,
  onWarning?: (warning: string) => void
): void {
  let modulesApplied = false;
  let match;

  // Look for ```vibespot-modules ... ``` blocks
  const blockPattern = /```vibespot-modules\s*\n?([\s\S]*?)```/g;

  while ((match = blockPattern.exec(response)) !== null) {
    try {
      log.info("parse", "Found vibespot-modules block", { length: match[1].length });
      const data = tryParseJSON(match[1]);
      if (!data || typeof data !== "object") {
        log.warn("parse", "tryParseJSON returned non-object", { result: typeof data });
        throw new Error("Invalid JSON after repair");
      }

      const obj = data as Record<string, unknown>;
      if (obj.modules && Array.isArray(obj.modules)) {
        updateModules({
          modules: obj.modules.map((m: Record<string, unknown>) => toModuleFiles(m)),
          sharedCss: obj.sharedCss !== undefined ? String(obj.sharedCss) : undefined,
          sharedJs: obj.sharedJs !== undefined ? String(obj.sharedJs) : undefined,
        });
        modulesApplied = true;
      }
    } catch (err) {
      log.warn("parse", "Failed to parse vibespot-modules block", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Also try to find standalone JSON that looks like module data
  if (!modulesApplied) {
    const jsonPattern = /```(?:json)?\s*\n([\s\S]*?)```/g;
    while ((match = jsonPattern.exec(response)) !== null) {
      if (!match[1].includes('"modules"')) continue;
      try {
        const data = tryParseJSON(match[1]);
        if (!data || typeof data !== "object") throw new Error("Invalid JSON after repair");
        const obj = data as Record<string, unknown>;
        if (obj.modules && Array.isArray(obj.modules)) {
          updateModules({
            modules: obj.modules.map((m: Record<string, unknown>) => toModuleFiles(m)),
            sharedCss: obj.sharedCss !== undefined ? String(obj.sharedCss) : undefined,
            sharedJs: obj.sharedJs !== undefined ? String(obj.sharedJs) : undefined,
          });
          modulesApplied = true;
        }
      } catch (err) {
        log.warn("parse", "Failed to parse JSON module block", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // Handle truncated responses (hit max_tokens — unclosed code fence)
  if (!modulesApplied) {
    const fenceCount = (response.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0 && response.includes('"modules"')) {
      log.info("parse", "Detected truncated response (odd fence count), attempting salvage");
      const lastFenceIdx = response.lastIndexOf("```");
      let truncated = response.slice(lastFenceIdx + 3);
      truncated = truncated.replace(/^[\w-]*\s*\n?/, "");
      const salvaged = tryRepairTruncatedJSON(truncated);
      if (salvaged) {
        const obj = salvaged as Record<string, unknown>;
        if (obj.modules && Array.isArray(obj.modules) && obj.modules.length > 0) {
          log.info("parse", "Salvaged modules from truncated response", { count: obj.modules.length });
          updateModules({
            modules: (obj.modules as Record<string, unknown>[]).map((m) => toModuleFiles(m)),
            sharedCss: obj.sharedCss !== undefined ? String(obj.sharedCss) : undefined,
            sharedJs: obj.sharedJs !== undefined ? String(obj.sharedJs) : undefined,
          });
          modulesApplied = true;
          if (onWarning) {
            onWarning("Response was truncated — some modules may be incomplete. Try sending your request again for the full set.");
          }
        }
      }
    }
  }

  // Warn user if the response looked like it should contain modules but parsing failed
  if (!modulesApplied) {
    log.info("parse", "No modules applied", {
      responseLength: response.length,
      hasVibespot: response.includes("vibespot-modules"),
      hasModules: response.includes('"modules"'),
      fenceCount: (response.match(/```/g) || []).length,
    });
    const hasModuleRef = response.includes("vibespot-modules") || response.includes('"modules"');
    const describesProse = /\bmodule|modul/i.test(response) &&
      (/\bcreated?\b|\berstellt\b|\bgenerat/i.test(response) || /\|.*\|.*\|/m.test(response));

    if (hasModuleRef || describesProse) {
      const msg = hasModuleRef
        ? "Module changes could not be applied — the AI response contained invalid JSON. Try sending your request again."
        : "The AI described modules but did not include the required structured data. Try sending your request again.";
      log.warn("parse", msg);
      if (onWarning) {
        onWarning(msg);
      }
    }
  }
}
