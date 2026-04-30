/**
 * Email template validator for VIB-154 spike.
 * Checks generated email modules against email client compatibility rules.
 * Run: npx tsx test/email-spike/validate-email.ts
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

interface ValidationResult {
  module: string;
  pass: boolean;
  errors: string[];
  warnings: string[];
}

const BANNED_CSS = [
  { pattern: /display\s*:\s*flex/gi, msg: "display: flex (not supported in email)" },
  { pattern: /display\s*:\s*grid/gi, msg: "display: grid (not supported in email)" },
  { pattern: /position\s*:\s*(absolute|relative|fixed|sticky)/gi, msg: "position (not supported in email)" },
  { pattern: /overflow\s*:\s*(?!hidden\b)\w/gi, msg: "overflow (problematic in email — overflow:hidden for preheader is OK)" },
  { pattern: /float\s*:/gi, msg: "float (unreliable in email)" },
  { pattern: /box-shadow\s*:/gi, msg: "box-shadow (stripped in Gmail)" },
  { pattern: /text-shadow\s*:/gi, msg: "text-shadow (stripped in Gmail)" },
  { pattern: /(?<!text-)transform\s*:/gi, msg: "transform (not supported)" },
  { pattern: /animation\s*:/gi, msg: "animation (not supported)" },
  { pattern: /transition\s*:/gi, msg: "transition (not supported)" },
  { pattern: /var\s*\(/gi, msg: "CSS custom properties var() (not supported)" },
  { pattern: /calc\s*\(/gi, msg: "calc() (not supported in Outlook)" },
];

const BANNED_HUBL = [
  { pattern: /require_css/g, msg: "require_css() (not available in email)" },
  { pattern: /require_js/g, msg: "require_js() (not available in email)" },
  { pattern: /scope_css/g, msg: "scope_css (not available in email)" },
  { pattern: /get_asset_url/g, msg: "get_asset_url() (not available in email)" },
  { pattern: /dnd_area|dnd_section|dnd_module/g, msg: "dnd_* tags (use email DnD system)" },
  { pattern: /\bnow\(\)/g, msg: "now() (not available in email)" },
];

function validateModule(modulePath: string): ValidationResult {
  const moduleName = modulePath.split("/").pop()!.replace(".module", "");
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check required files
  const htmlPath = join(modulePath, "module.html");
  const fieldsPath = join(modulePath, "fields.json");
  const metaPath = join(modulePath, "meta.json");

  if (!existsSync(htmlPath)) {
    errors.push("Missing module.html");
    return { module: moduleName, pass: false, errors, warnings };
  }
  if (!existsSync(fieldsPath)) errors.push("Missing fields.json");
  if (!existsSync(metaPath)) errors.push("Missing meta.json");

  const html = readFileSync(htmlPath, "utf-8");

  // Check module.js should NOT exist
  const jsPath = join(modulePath, "module.js");
  if (existsSync(jsPath)) {
    const jsContent = readFileSync(jsPath, "utf-8").trim();
    if (jsContent.length > 0) errors.push("module.js exists with content (no JS in email)");
  }

  // Check module.css should be empty or not exist
  const cssPath = join(modulePath, "module.css");
  if (existsSync(cssPath)) {
    const cssContent = readFileSync(cssPath, "utf-8").trim();
    if (cssContent.length > 0) errors.push("module.css has content (all CSS must be inline in email)");
  }

  // Check meta.json for EMAIL template type
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      if (!meta.host_template_types?.includes("EMAIL")) {
        errors.push(`meta.json host_template_types should include "EMAIL", got: ${JSON.stringify(meta.host_template_types)}`);
      }
    } catch {
      errors.push("meta.json is not valid JSON");
    }
  }

  // Check fields.json validity
  if (existsSync(fieldsPath)) {
    try {
      const fields = JSON.parse(readFileSync(fieldsPath, "utf-8"));
      if (!Array.isArray(fields)) errors.push("fields.json must be an array");

      // Check for reserved field names
      const checkFields = (items: any[], path = "") => {
        for (const field of items) {
          const fieldPath = path ? `${path}.${field.name}` : field.name;
          if (field.name === "name") errors.push(`Reserved field name "name" at ${fieldPath}`);
          if (field.name === "label") errors.push(`Reserved field name "label" at ${fieldPath}`);
          if (field.type === "textarea") errors.push(`Deprecated type "textarea" at ${fieldPath}, use "text"`);
          if (field.children) checkFields(field.children, fieldPath);
        }
      };
      checkFields(fields);
    } catch {
      errors.push("fields.json is not valid JSON");
    }
  }

  // Check for <style> blocks
  if (/<style[\s>]/i.test(html)) {
    errors.push("<style> block found (all CSS must be inline)");
  }

  // Check for banned CSS properties in inline styles
  for (const { pattern, msg } of BANNED_CSS) {
    pattern.lastIndex = 0;
    if (pattern.test(html)) {
      errors.push(`Banned CSS: ${msg}`);
    }
  }

  // Check for banned HubL
  for (const { pattern, msg } of BANNED_HUBL) {
    pattern.lastIndex = 0;
    if (pattern.test(html)) {
      errors.push(`Banned HubL: ${msg}`);
    }
  }

  // Check for table-based layout
  const hasTables = /<table[\s]/i.test(html);
  if (!hasTables) {
    errors.push("No <table> elements found — email layout must use tables");
  }

  // Check for role="presentation" on layout tables
  const tableCount = (html.match(/<table[\s][^>]*>/gi) || []).length;
  const presentationCount = (html.match(/role="presentation"/gi) || []).length;
  if (tableCount > 0 && presentationCount < tableCount) {
    warnings.push(`${tableCount - presentationCount} of ${tableCount} tables missing role="presentation"`);
  }

  // Check for MSO conditionals
  const hasMsoOpen = /<!--\[if mso\]>/i.test(html);
  const hasMsoClose = /<!\[endif\]-->/i.test(html);
  if (!hasMsoOpen || !hasMsoClose) {
    warnings.push("No MSO conditionals found (needed for Outlook desktop)");
  }

  // Check for preheader
  const hasPreheader = /display\s*:\s*none.*max-height\s*:\s*0/i.test(html) ||
                       /mso-hide\s*:\s*all/i.test(html);
  if (!hasPreheader) {
    warnings.push("No preheader text found (recommended for inbox preview)");
  }

  // Check for unsubscribe link
  if (!/unsubscribe_link/i.test(html)) {
    warnings.push("No unsubscribe_link reference (legally required in footer)");
  }

  // Check for company address
  if (!/site_settings\.company/i.test(html)) {
    warnings.push("No site_settings.company_* references (CAN-SPAM requires physical address)");
  }

  // Check for images without display:block
  const imgTags = html.match(/<img[^>]*>/gi) || [];
  for (const img of imgTags) {
    if (!/display\s*:\s*block/i.test(img)) {
      warnings.push(`Image missing display:block: ${img.slice(0, 60)}...`);
    }
    if (!/border\s*:\s*0/i.test(img)) {
      warnings.push(`Image missing border:0: ${img.slice(0, 60)}...`);
    }
    if (!/\balt\s*=/i.test(img)) {
      errors.push(`Image missing alt attribute: ${img.slice(0, 60)}...`);
    }
    if (!/\bwidth\s*=/i.test(img)) {
      warnings.push(`Image missing width attribute: ${img.slice(0, 60)}...`);
    }
  }

  // Check container width
  const has600 = /width="600"/i.test(html) || /width:\s*600px/i.test(html);
  if (!has600) {
    warnings.push("No 600px container width found (email standard)");
  }

  // Check for external CSS imports
  if (/@import\s+url/gi.test(html)) {
    errors.push("@import url() found (external stylesheets not supported)");
  }
  if (/<link[\s][^>]*stylesheet/gi.test(html)) {
    errors.push("<link stylesheet> found (external stylesheets not supported)");
  }

  // Check font stacks
  const fontDeclarations = html.match(/font-family\s*:\s*([^;"]+)/gi) || [];
  for (const decl of fontDeclarations) {
    if (/system-ui|-apple-system|"Segoe UI"|clamp/i.test(decl)) {
      warnings.push(`Modern font stack used: ${decl.trim()} (use web-safe fonts)`);
    }
  }

  // Check for rem/em units in font-size
  const fontSizes = html.match(/font-size\s*:\s*[\d.]+(?:rem|em)/gi) || [];
  if (fontSizes.length > 0) {
    warnings.push(`font-size uses rem/em units (use px): ${fontSizes.join(", ")}`);
  }

  return {
    module: moduleName,
    pass: errors.length === 0,
    errors,
    warnings,
  };
}

// Run validation
const spikeDir = new URL(".", import.meta.url).pathname;
const modules = readdirSync(spikeDir)
  .filter(f => f.endsWith(".module"))
  .map(f => join(spikeDir, f));

console.log("=== Email Template Validation (VIB-154 Spike) ===\n");

let allPass = true;
const results: ValidationResult[] = [];

for (const modulePath of modules) {
  const result = validateModule(modulePath);
  results.push(result);

  const status = result.pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`${status}  ${result.module}`);

  if (result.errors.length > 0) {
    allPass = false;
    for (const err of result.errors) {
      console.log(`  \x1b[31m✗ ${err}\x1b[0m`);
    }
  }
  if (result.warnings.length > 0) {
    for (const warn of result.warnings) {
      console.log(`  \x1b[33m⚠ ${warn}\x1b[0m`);
    }
  }
  console.log();
}

// Summary
console.log("---");
const passCount = results.filter(r => r.pass).length;
const totalErrors = results.reduce((n, r) => n + r.errors.length, 0);
const totalWarnings = results.reduce((n, r) => n + r.warnings.length, 0);
console.log(`${passCount}/${results.length} modules passed | ${totalErrors} errors | ${totalWarnings} warnings`);

if (!allPass) {
  console.log("\n\x1b[31mSome modules failed validation.\x1b[0m");
  process.exit(1);
} else {
  console.log("\n\x1b[32mAll modules pass email client compatibility checks.\x1b[0m");
}
