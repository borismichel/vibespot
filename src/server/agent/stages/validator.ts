/**
 * Stage 4: Validator + Assembler
 * Mostly rule-based code — catches errors before they reach the user or HubSpot.
 * Reuses patterns from auto-fix.ts.
 */

import type { ModuleFiles } from "../../../ai/engine.js";
import type { PipelineEvent } from "../types.js";
import type { ContentType } from "../../session/types.js";
import { tryParseJSON } from "../../ai-parser.js";
import { log } from "../../log.js";

export interface ValidationIssue {
  module: string;
  field: string;
  message: string;
  autoFixed: boolean;
}

export interface ValidationResult {
  module: ModuleFiles;
  issues: ValidationIssue[];
  valid: boolean;
}

/**
 * Validate and auto-fix a set of generated modules.
 */
export function validateModules(
  modules: ModuleFiles[],
  themeName: string,
  onEvent: (event: PipelineEvent) => void,
  contentType?: ContentType,
): ValidationResult[] {
  onEvent({
    type: "agent_step",
    step: "quality_check",
    label: "Quality check...",
  });

  return modules.map((mod) => {
    const issues: ValidationIssue[] = [];
    let fixedModule = { ...mod };

    // --- JSON parsability ---
    fixedModule.fieldsJson = validateAndFixJson(
      fixedModule.fieldsJson,
      fixedModule.moduleName,
      "fieldsJson",
      issues,
    );
    fixedModule.metaJson = validateAndFixJson(
      fixedModule.metaJson,
      fixedModule.moduleName,
      "metaJson",
      issues,
    );

    // --- Reserved field names ---
    fixedModule.fieldsJson = fixReservedFieldNames(
      fixedModule.fieldsJson,
      fixedModule.moduleName,
      issues,
    );

    // --- Deprecated field types ---
    fixedModule.fieldsJson = fixDeprecatedFieldTypes(
      fixedModule.fieldsJson,
      fixedModule.moduleName,
      issues,
    );

    // --- CDN import stripping ---
    fixedModule.moduleCss = stripCdnImports(
      fixedModule.moduleCss,
      fixedModule.moduleName,
      "moduleCss",
      issues,
    );

    // --- CSS prefix auto-fix ---
    fixedModule.moduleCss = fixCssPrefix(
      fixedModule.moduleCss,
      fixedModule.moduleName,
      themeName,
      issues,
    );
    fixedModule.moduleHtml = fixHtmlClassPrefix(
      fixedModule.moduleHtml,
      fixedModule.moduleName,
      themeName,
      issues,
    );

    // --- HubL basic checks + auto-fix ---
    fixedModule.moduleHtml = fixHublSyntax(
      fixedModule.moduleHtml,
      fixedModule.moduleName,
      issues,
    );

    // --- metaJson required fields ---
    fixedModule.metaJson = ensureMetaFields(
      fixedModule.metaJson,
      fixedModule.moduleName,
      issues,
    );

    const valid = issues.every((i) => i.autoFixed);

    if (issues.length > 0) {
      log.info("validator", `${fixedModule.moduleName}: ${issues.length} issues`, {
        autoFixed: issues.filter((i) => i.autoFixed).length,
        unfixed: issues.filter((i) => !i.autoFixed).length,
      });
    }

    return { module: fixedModule, issues, valid };
  });
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function validateAndFixJson(
  jsonStr: string,
  moduleName: string,
  field: string,
  issues: ValidationIssue[],
): string {
  if (!jsonStr || jsonStr.trim() === "") {
    issues.push({
      module: moduleName,
      field,
      message: `Empty ${field}`,
      autoFixed: field === "metaJson", // metaJson can be auto-generated
    });
    if (field === "metaJson") {
      return JSON.stringify({
        host_template_types: ["PAGE"],
        is_available_for_new_content: true,
      });
    }
    return jsonStr;
  }

  const parsed = tryParseJSON(jsonStr);
  if (parsed === null) {
    issues.push({
      module: moduleName,
      field,
      message: `Invalid JSON in ${field}`,
      autoFixed: false,
    });
  }
  return jsonStr;
}

function fixReservedFieldNames(
  fieldsJson: string,
  moduleName: string,
  issues: ValidationIssue[],
): string {
  let fixed = fieldsJson;

  // "name": "name" → "name": "item_name"
  const namePattern = /"name"\s*:\s*"name"/g;
  if (namePattern.test(fixed)) {
    issues.push({
      module: moduleName,
      field: "fieldsJson",
      message: '"name" is a reserved field name → renamed to "item_name"',
      autoFixed: true,
    });
    fixed = fixed.replace(/"name"\s*:\s*"name"/g, '"name": "item_name"');
  }

  // "name": "label" → "name": "section_label"
  const labelPattern = /"name"\s*:\s*"label"/g;
  if (labelPattern.test(fixed)) {
    issues.push({
      module: moduleName,
      field: "fieldsJson",
      message: '"label" is a reserved field name → renamed to "section_label"',
      autoFixed: true,
    });
    fixed = fixed.replace(/"name"\s*:\s*"label"/g, '"name": "section_label"');
  }

  return fixed;
}

function fixDeprecatedFieldTypes(
  fieldsJson: string,
  moduleName: string,
  issues: ValidationIssue[],
): string {
  let fixed = fieldsJson;

  const textareaPattern = /"type"\s*:\s*"textarea"/g;
  if (textareaPattern.test(fixed)) {
    issues.push({
      module: moduleName,
      field: "fieldsJson",
      message: '"textarea" is deprecated → changed to "text"',
      autoFixed: true,
    });
    fixed = fixed.replace(/"type"\s*:\s*"textarea"/g, '"type": "text"');
  }

  return fixed;
}

function stripCdnImports(
  css: string,
  moduleName: string,
  field: string,
  issues: ValidationIssue[],
): string {
  if (!css) return css;
  let fixed = css;

  // @import url(...) for external fonts
  const importPattern = /@import\s+url\([^)]*(?:fonts\.googleapis|cdnjs|unpkg|jsdelivr)[^)]*\)\s*;?/gi;
  if (importPattern.test(fixed)) {
    issues.push({
      module: moduleName,
      field,
      message: "CDN @import removed (external imports not allowed)",
      autoFixed: true,
    });
    fixed = fixed.replace(importPattern, "/* CDN import removed */");
  }

  return fixed;
}

/** Classes that should NOT be prefixed (framework/HubSpot/utility). */
const SKIP_CLASSES = new Set([
  "visible", "active", "scroll-animate", "hidden", "open", "closed",
  "fade-in", "fade-out", "is-active", "is-open", "is-visible",
]);
function shouldSkipClass(name: string): boolean {
  return (
    SKIP_CLASSES.has(name) ||
    name.startsWith("body-wrapper") ||
    name.startsWith("dnd-") ||
    name.startsWith("row-") ||
    name.startsWith("hs-") ||
    name.startsWith("hs_")
  );
}

/**
 * Auto-fix CSS classes that don't use the theme prefix.
 * Adds `themeName-` prefix to unprefixed class selectors in CSS and returns the fixed CSS.
 */
function fixCssPrefix(
  css: string,
  moduleName: string,
  themeName: string,
  issues: ValidationIssue[],
): string {
  if (!css) return css;

  const prefix = themeName + "-";

  // Collect unprefixed class names (deduplicated, ordered by first occurrence)
  const classPattern = /\.([a-zA-Z][\w-]*)/g;
  const unprefixedSet = new Set<string>();
  let match;

  while ((match = classPattern.exec(css)) !== null) {
    const className = match[1];
    if (!className.startsWith(prefix) && !shouldSkipClass(className)) {
      unprefixedSet.add(className);
    }
  }

  if (unprefixedSet.size <= 3) return css; // minor — don't bother

  // Replace each unprefixed class with the prefixed version
  let fixed = css;
  for (const name of unprefixedSet) {
    // Replace in selectors: .className → .prefix-className
    // Use word boundary to avoid partial matches
    const selectorRe = new RegExp(`\\.${escapeRegex(name)}(?=[\\s,{:+~>\\[\\]])`, "g");
    fixed = fixed.replace(selectorRe, `.${prefix}${name}`);
  }

  if (fixed !== css) {
    issues.push({
      module: moduleName,
      field: "moduleCss",
      message: `${unprefixedSet.size} CSS classes auto-prefixed with "${prefix}"`,
      autoFixed: true,
    });
  }

  return fixed;
}

/**
 * Auto-fix class references in HTML to match prefixed CSS classes.
 */
function fixHtmlClassPrefix(
  html: string,
  moduleName: string,
  themeName: string,
  issues: ValidationIssue[],
): string {
  if (!html) return html;

  const prefix = themeName + "-";

  // Find all class="..." attributes and check for unprefixed classes
  const classAttrRe = /class="([^"]*)"/g;
  let anyFixed = false;

  const fixed = html.replace(classAttrRe, (fullMatch, classValue: string) => {
    const classes = classValue.split(/\s+/);
    let changed = false;
    const newClasses = classes.map((cls: string) => {
      if (cls && !cls.startsWith(prefix) && !shouldSkipClass(cls) && /^[a-zA-Z][\w-]*$/.test(cls)) {
        changed = true;
        return prefix + cls;
      }
      return cls;
    });
    if (changed) {
      anyFixed = true;
      return `class="${newClasses.join(" ")}"`;
    }
    return fullMatch;
  });

  if (anyFixed) {
    issues.push({
      module: moduleName,
      field: "moduleHtml",
      message: `HTML class references auto-prefixed with "${prefix}"`,
      autoFixed: true,
    });
  }

  return fixed;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fixHublSyntax(
  html: string,
  moduleName: string,
  issues: ValidationIssue[],
): string {
  if (!html) return html;
  let fixed = html;

  // Two-pass approach to handle unbalanced HubL tags:
  // Pass 1: collect all tags in order to find orphans
  // Pass 2: apply fixes

  const tagPattern = /\{%[-~]?\s*(if|for|block|macro|endif|endfor|endblock|endmacro)\b[^%]*%\}/g;
  const tags: { tag: string; isOpen: boolean; baseTag: string; start: number; end: number }[] = [];
  let match;

  while ((match = tagPattern.exec(fixed)) !== null) {
    const tag = match[1];
    const isOpen = !tag.startsWith("end");
    const baseTag = isOpen ? tag : tag.replace("end", "");
    tags.push({ tag, isOpen, baseTag, start: match.index, end: match.index + match[0].length });
  }

  // Match openers to closers using a stack
  const stack: number[] = []; // indices into tags[]
  const orphanClosers: number[] = []; // indices of unmatched closers

  for (let i = 0; i < tags.length; i++) {
    if (tags[i].isOpen) {
      stack.push(i);
    } else {
      // Find matching opener on the stack (search from top)
      let found = -1;
      for (let j = stack.length - 1; j >= 0; j--) {
        if (tags[stack[j]].baseTag === tags[i].baseTag) {
          found = j;
          break;
        }
      }
      if (found !== -1) {
        stack.splice(found, 1);
      } else {
        orphanClosers.push(i);
      }
    }
  }

  // Remove orphan closing tags (replace in reverse order to keep positions valid)
  if (orphanClosers.length > 0) {
    for (let i = orphanClosers.length - 1; i >= 0; i--) {
      const t = tags[orphanClosers[i]];
      fixed =
        fixed.slice(0, t.start) +
        `<!-- removed orphan {% ${t.tag} %} -->` +
        fixed.slice(t.end);
    }
    issues.push({
      module: moduleName,
      field: "moduleHtml",
      message: `Removed ${orphanClosers.length} orphan closing tag${orphanClosers.length === 1 ? "" : "s"} with no matching opener`,
      autoFixed: true,
    });
  }

  // Append missing closing tags for unclosed openers (stack has unmatched openers)
  if (stack.length > 0) {
    const unclosed = stack.map((i) => tags[i].baseTag);
    const closers = unclosed
      .reverse()
      .map((tag) => `{% end${tag} %}`)
      .join("\n");
    fixed = `${fixed}\n${closers}`;
    issues.push({
      module: moduleName,
      field: "moduleHtml",
      message: `Added ${unclosed.length} missing closing tag${unclosed.length === 1 ? "" : "s"}: ${unclosed.map((t) => `{% end${t} %}`).join(", ")}`,
      autoFixed: true,
    });
  }

  // Fix now() → local_dt
  if (/\bnow\(\)/.test(fixed)) {
    fixed = fixed.replace(/\bnow\(\)/g, "local_dt");
    issues.push({
      module: moduleName,
      field: "moduleHtml",
      message: "Replaced now() with local_dt (now() is not valid HubL)",
      autoFixed: true,
    });
  }

  return fixed;
}

function ensureMetaFields(
  metaJson: string,
  moduleName: string,
  issues: ValidationIssue[],
): string {
  const parsed = tryParseJSON(metaJson);
  if (!parsed || typeof parsed !== "object") return metaJson;

  const obj = parsed as Record<string, unknown>;
  let changed = false;

  if (!obj.host_template_types) {
    obj.host_template_types = ["PAGE"];
    changed = true;
  }
  if (obj.is_available_for_new_content === undefined) {
    obj.is_available_for_new_content = true;
    changed = true;
  }

  if (changed) {
    issues.push({
      module: moduleName,
      field: "metaJson",
      message: "Added missing meta.json required fields",
      autoFixed: true,
    });
    return JSON.stringify(obj, null, 2);
  }

  return metaJson;
}
