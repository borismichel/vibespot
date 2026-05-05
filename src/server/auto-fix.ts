/**
 * Auto-fix utilities for common HubSpot upload errors.
 * Shared between CLI wizard (uploader.ts) and web server (server.ts).
 */

import { join } from "node:path";
import { readdirSync, rmSync } from "node:fs";
import { readFile, writeFile, fileExists } from "../utils/fs.js";

export interface UploadError {
  file: string;
  message: string;
  fixable: boolean;
}

/** Parse API upload errors into the standard UploadError interface. */
export function parseApiErrors(apiErrors: { file: string; status: number; message: string; category?: string; detail?: string }[]): UploadError[] {
  const errors: UploadError[] = [];

  for (const err of apiErrors) {
    const msg = `${err.message}${err.detail ? ` — ${err.detail}` : ""}`;
    let fixable = false;

    // Detect fixable error patterns from API response messages
    if (/textarea|unknown.*field.*type/i.test(msg)) fixable = true;
    if (/reserved.*name|missing field name|field null/i.test(msg)) fixable = true;
    if (/could not resolve.*now/i.test(msg)) fixable = true;
    if (/hubdb|do not have access/i.test(msg)) fixable = true;
    if (/invalid default value|link.*invalid|deserializ/i.test(msg)) fixable = true;
    if (/color.*invalid/i.test(msg)) fixable = true;
    if (/dnd.area.*only.*have.*name.*main/i.test(msg)) fixable = true;

    errors.push({
      file: err.file || "unknown",
      message: msg,
      fixable,
    });
  }

  return errors;
}

export function parseUploadErrors(output: string): UploadError[] {
  const errors: UploadError[] = [];

  if (/textarea.*not.*valid|unknown.*field.*type/i.test(output)) {
    const fileMatch = output.match(/(?:in|file:?)\s+(\S+fields\.json)/i);
    errors.push({
      file: fileMatch?.[1] || "fields.json",
      message: '"textarea" is not a valid field type',
      fixable: true,
    });
  }

  if (/missing field name|field null/i.test(output)) {
    const fileMatch = output.match(/(?:in|file:?)\s+(\S+fields\.json)/i);
    errors.push({
      file: fileMatch?.[1] || "fields.json",
      message: '"name" is a reserved field name',
      fixable: true,
    });
  }

  if (/could not resolve.*now/i.test(output)) {
    errors.push({
      file: "module.html",
      message: "now() is not a valid HubL function",
      fixable: true,
    });
  }

  if (/hubdb|do not have access to hubdb/i.test(output)) {
    errors.push({
      file: "templates",
      message: "HubDB requires CMS Hub Pro/Enterprise",
      fixable: true,
    });
  }

  if (/invalid default value|link.*field.*invalid/i.test(output)) {
    const fieldMatch = output.match(/field.*?(\w+)\s+has an invalid/i);
    errors.push({
      file: fieldMatch?.[1] || "fields.json",
      message: `Link field has invalid default value`,
      fixable: true,
    });
  }

  if (/failed to deserialize/i.test(output)) {
    const fileMatch = output.match(/file '([^']+)'/i);
    errors.push({
      file: fileMatch?.[1] || "fields.json",
      message: "fields.json deserialization error",
      fixable: true,
    });
  }

  if (/format for the color value is invalid/i.test(output)) {
    errors.push({
      file: "fields.json",
      message: "Color field has invalid format (rgba/rgb/named — must be hex)",
      fixable: true,
    });
  }

  if (/dnd.area.*only.*have.*name.*main/i.test(output)) {
    errors.push({
      file: "templates/email.html",
      message: 'Dnd area can only have name "main"',
      fixable: true,
    });
  }

  return errors;
}

export function applyAutoFixes(themePath: string): string[] {
  const fixes: string[] = [];
  if (fixTextareaFields(themePath)) fixes.push('textarea → text');
  if (fixReservedNames(themePath)) fixes.push('name → item_name');
  if (fixNowFunction(themePath)) fixes.push('now() → local_dt');
  if (fixHubDbTemplates(themePath)) fixes.push('Removed HubDB templates');
  if (fixLinkFieldDefaults(themePath)) fixes.push('Fixed link field defaults');
  if (fixColorFieldDefaults(themePath)) fixes.push('Fixed rgba/invalid color values → hex');
  if (fixCdnImports(themePath)) fixes.push('Stripped CDN @import statements');
  if (fixEmailDndAreaName(themePath)) fixes.push('dnd_area → "main" in email templates');
  return fixes;
}

export function autoFixError(themePath: string, error: UploadError): boolean {
  if (error.message.includes("textarea")) return fixTextareaFields(themePath);
  if (error.message.includes("reserved field name")) return fixReservedNames(themePath);
  if (error.message.includes("now()")) return fixNowFunction(themePath);
  if (error.message.includes("HubDB")) return fixHubDbTemplates(themePath);
  if (error.message.includes("invalid default value") || error.message.includes("deserialization"))
    return fixLinkFieldDefaults(themePath);
  if (error.message.includes("invalid format") && error.message.includes("color"))
    return fixColorFieldDefaults(themePath);
  if (error.message.includes("dnd") || error.message.includes("Dnd area"))
    return fixEmailDndAreaName(themePath);
  return false;
}

export function fixTextareaFields(themePath: string): boolean {
  let fixed = false;
  const modulesDir = join(themePath, "modules");
  if (!fileExists(modulesDir)) return false;

  for (const entry of readdirSync(modulesDir)) {
    if (!entry.endsWith(".module")) continue;
    const fieldsPath = join(modulesDir, entry, "fields.json");
    if (!fileExists(fieldsPath)) continue;
    let content = readFile(fieldsPath);
    if (content.includes('"textarea"')) {
      content = content.replace(/"textarea"/g, '"text"');
      writeFile(fieldsPath, content);
      fixed = true;
    }
  }
  return fixed;
}

export function fixReservedNames(themePath: string): boolean {
  let fixed = false;
  const modulesDir = join(themePath, "modules");
  if (!fileExists(modulesDir)) return false;

  for (const entry of readdirSync(modulesDir)) {
    if (!entry.endsWith(".module")) continue;
    const fieldsPath = join(modulesDir, entry, "fields.json");
    if (!fileExists(fieldsPath)) continue;
    let content = readFile(fieldsPath);
    if (/"name":\s*"name"/g.test(content)) {
      content = content.replace(/"name":\s*"name"/g, '"name": "item_name"');
      writeFile(fieldsPath, content);
      fixed = true;
    }
  }
  return fixed;
}

export function fixNowFunction(themePath: string): boolean {
  let fixed = false;
  const modulesDir = join(themePath, "modules");
  if (!fileExists(modulesDir)) return false;

  for (const entry of readdirSync(modulesDir)) {
    if (!entry.endsWith(".module")) continue;
    const htmlPath = join(modulesDir, entry, "module.html");
    if (!fileExists(htmlPath)) continue;
    let content = readFile(htmlPath);
    if (content.includes("now()")) {
      content = content.replace(/now\(\)/g, "local_dt");
      writeFile(htmlPath, content);
      fixed = true;
    }
  }
  return fixed;
}

export function fixHubDbTemplates(themePath: string): boolean {
  let fixed = false;
  const templatesDir = join(themePath, "templates");
  if (!fileExists(templatesDir)) return false;

  for (const file of readdirSync(templatesDir)) {
    if (!file.endsWith(".html")) continue;
    const filePath = join(templatesDir, file);
    const content = readFile(filePath);
    if (content.includes("hubdb_table") || content.includes("hubdb_table_rows")) {
      rmSync(filePath);
      fixed = true;
    }
  }
  return fixed;
}

export function fixLinkFieldDefaults(themePath: string): boolean {
  let fixed = false;
  const modulesDir = join(themePath, "modules");
  if (!fileExists(modulesDir)) return false;

  for (const entry of readdirSync(modulesDir)) {
    if (!entry.endsWith(".module")) continue;
    const fieldsPath = join(modulesDir, entry, "fields.json");
    if (!fileExists(fieldsPath)) continue;
    try {
      const fields = JSON.parse(readFile(fieldsPath));
      if (fixLinkFieldsRecursive(fields)) {
        writeFile(fieldsPath, JSON.stringify(fields, null, 2) + "\n");
        fixed = true;
      }
    } catch {
      // Skip malformed JSON
    }
  }
  return fixed;
}

/**
 * Strip external CDN @import statements from all CSS files.
 * Google Fonts and other CDN imports can fail in HubSpot's editor
 * and cause content to appear invisible.
 */
export function fixCdnImports(themePath: string): boolean {
  let fixed = false;

  // Check shared CSS files
  const cssDir = join(themePath, "css");
  if (fileExists(cssDir)) {
    for (const file of readdirSync(cssDir)) {
      if (!file.endsWith(".css")) continue;
      const filePath = join(cssDir, file);
      let content = readFile(filePath);
      const cleaned = content.replace(/@import\s+url\(['"]?https?:\/\/[^)]+['"]?\)\s*;?/gi, "");
      if (cleaned !== content) {
        writeFile(filePath, cleaned);
        fixed = true;
      }
    }
  }

  // Check module CSS files
  const modulesDir = join(themePath, "modules");
  if (fileExists(modulesDir)) {
    for (const entry of readdirSync(modulesDir)) {
      if (!entry.endsWith(".module")) continue;
      const cssPath = join(modulesDir, entry, "module.css");
      if (!fileExists(cssPath)) continue;
      let content = readFile(cssPath);
      const cleaned = content.replace(/@import\s+url\(['"]?https?:\/\/[^)]+['"]?\)\s*;?/gi, "");
      if (cleaned !== content) {
        writeFile(cssPath, cleaned);
        fixed = true;
      }
    }
  }

  // Check module HTML for <link> tags to external CDNs
  if (fileExists(modulesDir)) {
    for (const entry of readdirSync(modulesDir)) {
      if (!entry.endsWith(".module")) continue;
      const htmlPath = join(modulesDir, entry, "module.html");
      if (!fileExists(htmlPath)) continue;
      let content = readFile(htmlPath);
      const cleaned = content.replace(/<link[^>]+href=['"]https?:\/\/[^'"]+['"][^>]*>/gi, "");
      if (cleaned !== content) {
        writeFile(htmlPath, cleaned);
        fixed = true;
      }
    }
  }

  return fixed;
}

/**
 * Fix color fields that use rgba(), rgb(), named colors, or 3-digit hex.
 * HubSpot requires: { "color": "#rrggbb", "opacity": 100 }
 */
export function fixColorFieldDefaults(themePath: string): boolean {
  let fixed = false;
  const modulesDir = join(themePath, "modules");
  if (!fileExists(modulesDir)) return false;

  for (const entry of readdirSync(modulesDir)) {
    if (!entry.endsWith(".module")) continue;
    const fieldsPath = join(modulesDir, entry, "fields.json");
    if (!fileExists(fieldsPath)) continue;
    try {
      const fields = JSON.parse(readFile(fieldsPath));
      if (fixColorFieldsRecursive(fields)) {
        writeFile(fieldsPath, JSON.stringify(fields, null, 2) + "\n");
        fixed = true;
      }
    } catch {
      // Skip malformed JSON
    }
  }
  return fixed;
}

function fixColorFieldsRecursive(fields: unknown[]): boolean {
  let fixed = false;
  for (const field of fields) {
    if (typeof field !== "object" || field === null) continue;
    const f = field as Record<string, unknown>;

    if (f.type === "color" && f.default && typeof f.default === "object") {
      const def = f.default as Record<string, unknown>;
      const colorVal = def.color;
      if (typeof colorVal === "string" && !isValidHexColor(colorVal)) {
        const converted = convertToHex(colorVal);
        if (converted) {
          def.color = converted.hex;
          // If the rgba had opacity, use that instead of the existing opacity
          if (converted.opacity !== undefined) {
            def.opacity = converted.opacity;
          }
          fixed = true;
        }
      }
    }

    if (Array.isArray(f.children)) {
      if (fixColorFieldsRecursive(f.children as unknown[])) fixed = true;
    }
  }
  return fixed;
}

function isValidHexColor(color: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(color);
}

function convertToHex(color: string): { hex: string; opacity?: number } | null {
  // 3-digit hex → 6-digit
  const hex3 = color.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
  if (hex3) {
    return { hex: `#${hex3[1]}${hex3[1]}${hex3[2]}${hex3[2]}${hex3[3]}${hex3[3]}` };
  }

  // rgba(r, g, b, a)
  const rgba = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i);
  if (rgba) {
    const r = Math.min(255, parseInt(rgba[1]));
    const g = Math.min(255, parseInt(rgba[2]));
    const b = Math.min(255, parseInt(rgba[3]));
    const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    const opacity = rgba[4] !== undefined ? Math.round(parseFloat(rgba[4]) * 100) : undefined;
    return { hex, opacity };
  }

  // Named colors (common ones)
  const named: Record<string, string> = {
    white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000",
    blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080",
    gray: "#808080", grey: "#808080", transparent: "#000000",
  };
  const lower = color.toLowerCase().trim();
  if (named[lower]) {
    return { hex: named[lower], opacity: lower === "transparent" ? 0 : undefined };
  }

  return null;
}

/**
 * HubSpot email templates require the dnd_area to be named "main".
 * Any other name (e.g. "email_body", "main_content") is rejected.
 */
export function fixEmailDndAreaName(themePath: string): boolean {
  let fixed = false;
  const templatesDir = join(themePath, "templates");
  if (!fileExists(templatesDir)) return false;

  for (const file of readdirSync(templatesDir)) {
    if (!file.endsWith(".html")) continue;
    const filePath = join(templatesDir, file);
    const content = readFile(filePath);
    if (!/templateType:\s*email/i.test(content)) continue;
    const replaced = content.replace(
      /\{%\s*dnd_area\s+"(?!main")([^"]+)"/g,
      '{% dnd_area "main"',
    );
    if (replaced !== content) {
      writeFile(filePath, replaced);
      fixed = true;
    }
  }
  return fixed;
}

function fixLinkFieldsRecursive(fields: unknown[]): boolean {
  let fixed = false;
  for (const field of fields) {
    if (typeof field !== "object" || field === null) continue;
    const f = field as Record<string, unknown>;

    if (f.type === "link") {
      const def = f.default;
      const needsFix =
        typeof def === "string" ||
        def === undefined ||
        def === null ||
        (typeof def === "object" && !(def as Record<string, unknown>).url);

      if (needsFix) {
        const href = typeof def === "string" ? def : "";
        f.default = {
          url: { href, type: "EXTERNAL" },
          open_in_new_tab: false,
          no_follow: false,
        };
        fixed = true;
      }
    }

    if (Array.isArray(f.children)) {
      if (fixLinkFieldsRecursive(f.children as unknown[])) fixed = true;
    }
  }
  return fixed;
}
