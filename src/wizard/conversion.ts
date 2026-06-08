import { join } from "node:path";
import { readdirSync, rmSync } from "node:fs";
import type { AIEngine, GeneratedAssets } from "../ai/engine.js";
import type { AIEngineType } from "../utils/config.js";
import { ClaudeCodeEngine } from "../ai/claude-code.js";
import { ClaudeAPIEngine } from "../ai/claude-api.js";
import { GeminiCLIEngine } from "../ai/gemini-cli.js";
import { CodexCLIEngine } from "../ai/codex-cli.js";
import { getConversionGuide } from "../ai/prompts.js";
import { readFile, writeFile, fileExists } from "../utils/fs.js";
import * as ui from "../prompts/prompter.js";

function createEngine(type: AIEngineType, model?: string): AIEngine {
  switch (type) {
    case "claude-code":
      return new ClaudeCodeEngine(model);
    case "gemini-cli":
      return new GeminiCLIEngine();
    case "codex-cli":
      return new CodexCLIEngine();
    // "api" is the legacy value; loadConfig() migrates it to "anthropic-api",
    // so accept both. "claude-oauth" also runs through the Anthropic SDK engine.
    case "api":
    case "anthropic-api":
    case "claude-oauth":
      return new ClaudeAPIEngine();
    default:
      throw new Error(
        `The wizard does not support the "${type}" engine. ` +
          `Use claude-code, gemini-cli, codex-cli, or the Anthropic API.`
      );
  }
}

export async function runConversion(opts: {
  aiEngine: AIEngineType;
  model?: string;
  sourceDir: string;
  themePath: string;
}): Promise<GeneratedAssets> {
  await ui.intro("Converting React to HubSpot Modules");

  await ui.note(
    "AI will now analyze your React code and create\nHubSpot-native modules. This takes 2-5 minutes.",
    "AI Conversion"
  );

  const engine = createEngine(opts.aiEngine, opts.model);

  const conversionGuide = getConversionGuide();

  const s = await ui.spinner();
  s.start("Starting AI conversion...");

  const startTime = Date.now();

  const result = await engine.convert({
    sourceDir: opts.sourceDir,
    themePath: opts.themePath,
    conversionGuide,
    onProgress: (step, detail) => {
      if (step === "created") {
        ui.logSuccess(detail);
      } else {
        s.message(detail);
      }
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  s.stop(`AI conversion complete (${elapsed}s)`);

  // Validate and auto-fix all known HubSpot issues before upload
  const fixes = validateAndFix(opts.themePath);
  for (const fix of fixes) {
    ui.logSuccess(`Auto-fixed: ${fix}`);
  }

  // Show conversion checklist
  const checklist = buildChecklist(opts.themePath, result);
  const lines: string[] = [];
  for (const item of checklist) {
    const icon = item.passed ? "\u2705" : "\u274c";
    const severity = !item.passed ? (item.critical ? " (CRITICAL)" : " (cosmetic)") : "";
    lines.push(`${icon} ${item.label}${severity}`);
  }
  const passed = checklist.filter((c) => c.passed).length;
  lines.push(`\n${passed}/${checklist.length} checks passed`);
  await ui.note(lines.join("\n"), "Conversion Checklist");

  const criticalFailures = checklist.filter((c) => !c.passed && c.critical);
  const cosmeticFailures = checklist.filter((c) => !c.passed && !c.critical);

  if (criticalFailures.length > 0) {
    ui.logError(
      `${criticalFailures.length} critical issue(s) — upload will likely fail:\n` +
      criticalFailures.map((c) => `  - ${c.label}`).join("\n")
    );
    const proceed = await ui.confirm({
      message: "Continue with upload anyway?",
      initialValue: false,
    });
    if (!proceed) {
      throw new Error("Conversion aborted due to critical checklist failures.");
    }
  } else if (cosmeticFailures.length > 0) {
    ui.logWarn(
      `${cosmeticFailures.length} non-critical issue(s) — page will work but may look incomplete:\n` +
      cosmeticFailures.map((c) => `  - ${c.label}`).join("\n")
    );
  }

  // Offer to clean up log file
  const logPath = join(opts.themePath, "..", "vibespot-conversion.log");
  if (fileExists(logPath)) {
    const keepLog = await ui.confirm({
      message: "Keep conversion log file for debugging?",
      initialValue: false,
    });
    if (!keepLog) {
      rmSync(logPath);
    } else {
      ui.logSuccess(`Log saved: ${logPath}`);
    }
  }

  await ui.outro("Files ready for upload!");

  return result;
}

/**
 * Run all validation and auto-fix routines before upload.
 * Returns a list of human-readable fix descriptions.
 */
export function validateAndFix(themePath: string): string[] {
  const fixes: string[] = [];

  // 1. Template annotations
  validateTemplates(themePath);

  // 2. Module meta.json
  validateModuleMeta(themePath);

  // 3. Fix fields.json issues in all modules
  const modulesDir = join(themePath, "modules");
  if (fileExists(modulesDir)) {
    for (const entry of readdirSync(modulesDir)) {
      if (!entry.endsWith(".module")) continue;
      const fieldsPath = join(modulesDir, entry, "fields.json");
      if (!fileExists(fieldsPath)) continue;

      const moduleName = entry.replace(".module", "");
      let content = readFile(fieldsPath);
      let changed = false;

      // 3a. "textarea" → "text"
      if (content.includes('"textarea"')) {
        content = content.replace(/"textarea"/g, '"text"');
        changed = true;
        fixes.push(`${moduleName}: "textarea" → "text"`);
      }

      // 3b. "name": "name" → "name": "item_name"
      if (/"name":\s*"name"/.test(content)) {
        content = content.replace(/"name":\s*"name"/g, '"name": "item_name"');
        changed = true;
        fixes.push(`${moduleName}: reserved field name "name" → "item_name"`);
      }

      // 3c. Fix "choice" fields — choices must be [["value","Label"]] not ["value"]
      // 3d. Fix "link" fields — default must be { url: { href, type }, open_in_new_tab, no_follow }
      try {
        const fields = JSON.parse(content);
        let jsonFixed = false;
        if (fixChoiceFields(fields)) {
          jsonFixed = true;
          fixes.push(`${moduleName}: fixed choice field format`);
        }
        if (fixLinkFields(fields)) {
          jsonFixed = true;
          fixes.push(`${moduleName}: fixed link field default value`);
        }
        if (jsonFixed) {
          content = JSON.stringify(fields, null, 2) + "\n";
          changed = true;
        }
      } catch {
        fixes.push(`${moduleName}: fields.json has invalid JSON — manual fix needed`);
      }

      if (changed) writeFile(fieldsPath, content);

      // 3d. Fix now() in module.html
      const htmlPath = join(modulesDir, entry, "module.html");
      if (fileExists(htmlPath)) {
        let html = readFile(htmlPath);
        if (html.includes("now()")) {
          html = html.replace(/now\(\)/g, "local_dt");
          writeFile(htmlPath, html);
          fixes.push(`${moduleName}: now() → local_dt`);
        }
      }
    }
  }

  // 4. Remove HubDB templates (requires CMS Hub Pro/Enterprise)
  const templatesDir = join(themePath, "templates");
  if (fileExists(templatesDir)) {
    for (const file of readdirSync(templatesDir)) {
      if (!file.endsWith(".html")) continue;
      const filePath = join(templatesDir, file);
      const content = readFile(filePath);
      if (content.includes("hubdb_table") || content.includes("hubdb_table_rows")) {
        rmSync(filePath);
        fixes.push(`Removed ${file} (HubDB requires CMS Hub Pro/Enterprise)`);
      }
    }
  }

  return fixes;
}

/** Recursively fix choice fields: convert string[] choices to [value, Label][] */
function fixChoiceFields(fields: unknown[]): boolean {
  let fixed = false;
  for (const field of fields) {
    if (typeof field !== "object" || field === null) continue;
    const f = field as Record<string, unknown>;

    if (f.type === "choice" && Array.isArray(f.choices)) {
      const needsFix = f.choices.some((c: unknown) => typeof c === "string");
      if (needsFix) {
        f.choices = (f.choices as unknown[]).map((c: unknown) => {
          if (typeof c === "string") {
            const label = c.charAt(0).toUpperCase() + c.slice(1);
            return [c, label];
          }
          return c;
        });
        fixed = true;
      }
    }

    // Recurse into group children
    if (Array.isArray(f.children)) {
      if (fixChoiceFields(f.children as unknown[])) fixed = true;
    }
  }
  return fixed;
}

/** Recursively fix link fields: default must be { url: { href, type }, open_in_new_tab, no_follow } */
function fixLinkFields(fields: unknown[]): boolean {
  let fixed = false;
  for (const field of fields) {
    if (typeof field !== "object" || field === null) continue;
    const f = field as Record<string, unknown>;

    if (f.type === "link") {
      const def = f.default;
      // Fix if default is a string, missing, or doesn't have the required url.href structure
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

    // Recurse into group children
    if (Array.isArray(f.children)) {
      if (fixLinkFields(f.children as unknown[])) fixed = true;
    }
  }
  return fixed;
}

interface CheckItem {
  label: string;
  passed: boolean;
  /** If true, failure blocks upload. If false, it's cosmetic / nice-to-have. */
  critical: boolean;
}

function buildChecklist(themePath: string, result: GeneratedAssets): CheckItem[] {
  const items: CheckItem[] = [];

  // Modules — critical: upload will fail with zero modules
  const moduleCount = result.modules.length;
  items.push({
    label: `Modules created (${moduleCount})`,
    passed: moduleCount > 0,
    critical: true,
  });

  // fields.json — critical: invalid fields cause upload deserialization errors
  let fieldsOk = true;
  for (const m of result.modules) {
    if (m.fieldsJson.includes('"textarea"') || /"name":\s*"name"/.test(m.fieldsJson)) {
      fieldsOk = false;
      break;
    }
  }
  items.push({
    label: "fields.json valid (no textarea, no reserved names)",
    passed: moduleCount > 0 && fieldsOk,
    critical: true,
  });

  // module.html — critical: modules won't render without it
  const allHaveHtml = result.modules.every((m) => m.moduleHtml.length > 0);
  items.push({
    label: "module.html created for each module",
    passed: moduleCount > 0 && allHaveHtml,
    critical: true,
  });

  // module.css — not critical (page works but looks unstyled)
  const missingCss = result.modules.filter((m) => !m.moduleCss).map((m) => m.moduleName);
  const allHaveCss = missingCss.length === 0;
  items.push({
    label: allHaveCss
      ? "module.css created for each module"
      : `module.css missing for: ${missingCss.join(", ")}`,
    passed: moduleCount > 0 && allHaveCss,
    critical: false,
  });

  // Style tab — not critical (modules work without style tab)
  const hasStyleTab = result.modules.some((m) => m.fieldsJson.includes('"STYLE"'));
  items.push({
    label: "Style tab fields (color pickers)",
    passed: hasStyleTab,
    critical: false,
  });

  // Shared CSS — not critical (modules have their own CSS)
  items.push({
    label: "Shared CSS with design system variables",
    passed: result.sharedCss.length > 50,
    critical: false,
  });

  // Shared JS — not critical (page works without animations)
  items.push({
    label: "Shared JS for scroll animations",
    passed: result.sharedJs.length > 50,
    critical: false,
  });

  // Page template — critical: no template means no page in HubSpot
  items.push({
    label: "Page template with dnd_area",
    passed: result.template.length > 0 && result.template.includes("dnd_area"),
    critical: true,
  });

  // Template annotations — critical: template won't appear in picker
  const templatesDir = join(themePath, "templates");
  let templateAnnotated = false;
  if (fileExists(templatesDir)) {
    for (const file of readdirSync(templatesDir)) {
      if (!file.endsWith(".html") || file === "base.html" || file.startsWith("system")) continue;
      const content = readFile(join(templatesDir, file));
      if (content.includes("dnd_area") && /templateType\s*:\s*page/i.test(content)) {
        templateAnnotated = true;
        break;
      }
    }
  }
  items.push({
    label: "Template annotations (templateType: page)",
    passed: templateAnnotated,
    critical: true,
  });

  return items;
}

/**
 * Ensure all templates in templates/ have the required HubSpot annotations.
 * Without `templateType: page` and `isAvailableForNewContent: true`,
 * the template won't appear in HubSpot's template picker.
 */
export function validateTemplates(themePath: string): void {
  const templatesDir = join(themePath, "templates");
  if (!fileExists(templatesDir)) return;

  for (const file of readdirSync(templatesDir)) {
    if (!file.endsWith(".html") || file === "base.html" || file.startsWith("system")) continue;

    const filePath = join(templatesDir, file);
    let content = readFile(filePath);

    // Skip files that don't look like page templates
    if (!content.includes("dnd_area") && !content.includes("extends")) continue;

    const hasTemplateType = /templateType\s*:\s*page/i.test(content);
    const hasAvailable = /isAvailableForNewContent\s*:\s*true/i.test(content);

    if (hasTemplateType && hasAvailable) continue;

    // Build the annotation block
    const label = file.replace(".html", "").replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    if (content.includes("<!--") && content.indexOf("-->") < 200) {
      // Has an existing comment block at the top — patch it
      const commentEnd = content.indexOf("-->");
      let annotation = content.slice(0, commentEnd);

      if (!hasTemplateType) {
        annotation += "\n  templateType: page";
      }
      if (!hasAvailable) {
        annotation += "\n  isAvailableForNewContent: true";
      }
      if (!/label\s*:/i.test(annotation)) {
        annotation += `\n  label: ${label}`;
      }

      content = annotation + content.slice(commentEnd);
    } else {
      // No annotation block — prepend one
      const block = `<!--\n  templateType: page\n  isAvailableForNewContent: true\n  label: ${label}\n-->\n`;
      content = block + content;
    }

    writeFile(filePath, content);
    ui.logSuccess(`Template "${file}" — annotations verified`);
  }

}

/**
 * Ensure all module meta.json files have the required fields for
 * landing page compatibility.
 */
export function validateModuleMeta(themePath: string): void {
  const modulesDir = join(themePath, "modules");
  if (!fileExists(modulesDir)) return;

  for (const entry of readdirSync(modulesDir)) {
    if (!entry.endsWith(".module")) continue;
    const metaPath = join(modulesDir, entry, "meta.json");
    if (!fileExists(metaPath)) continue;

    try {
      const meta = JSON.parse(readFile(metaPath));
      let changed = false;

      if (!meta.host_template_types || !meta.host_template_types.includes("PAGE")) {
        meta.host_template_types = ["PAGE"];
        changed = true;
      }
      if (!meta.is_available_for_new_content) {
        meta.is_available_for_new_content = true;
        changed = true;
      }

      if (changed) {
        writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
      }
    } catch {
      // Skip malformed meta.json
    }
  }
}
