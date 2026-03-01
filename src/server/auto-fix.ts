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

  return errors;
}

export function applyAutoFixes(themePath: string): string[] {
  const fixes: string[] = [];
  if (fixTextareaFields(themePath)) fixes.push('textarea → text');
  if (fixReservedNames(themePath)) fixes.push('name → item_name');
  if (fixNowFunction(themePath)) fixes.push('now() → local_dt');
  if (fixHubDbTemplates(themePath)) fixes.push('Removed HubDB templates');
  if (fixLinkFieldDefaults(themePath)) fixes.push('Fixed link field defaults');
  return fixes;
}

export function autoFixError(themePath: string, error: UploadError): boolean {
  if (error.message.includes("textarea")) return fixTextareaFields(themePath);
  if (error.message.includes("reserved field name")) return fixReservedNames(themePath);
  if (error.message.includes("now()")) return fixNowFunction(themePath);
  if (error.message.includes("HubDB")) return fixHubDbTemplates(themePath);
  if (error.message.includes("invalid default value") || error.message.includes("deserialization"))
    return fixLinkFieldDefaults(themePath);
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
