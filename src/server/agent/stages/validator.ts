/**
 * Stage 4: Validator + Assembler
 * Mostly rule-based code — catches errors before they reach the user or HubSpot.
 * Reuses patterns from auto-fix.ts.
 */

import type { ModuleFiles } from "../../../ai/engine.js";
import type { ContentType, PipelineEvent } from "../types.js";
import type { BrandKit } from "../../session/types.js";
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
  brandKit?: BrandKit,
): ValidationResult[] {
  const isEmail = contentType === "email";
  const isBlog = contentType === "blog";
  onEvent({
    type: "agent_step",
    step: "quality_check",
    label: isEmail ? "Email quality check..." : isBlog ? "Blog quality check..." : "Quality check...",
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
      isEmail,
    );
    fixedModule.metaJson = validateAndFixJson(
      fixedModule.metaJson,
      fixedModule.moduleName,
      "metaJson",
      issues,
      isEmail,
      isBlog,
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

    if (isEmail) {
      // --- Email-specific validation + auto-fix ---
      fixedModule = validateEmailModule(fixedModule, issues);
    } else {
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

      if (isBlog) {
        // --- Blog-specific validation + auto-fix ---
        fixedModule = validateBlogModule(fixedModule, issues);
      }
    }

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
      isEmail,
      isBlog,
    );

    // --- Brand kit compliance (warnings only) ---
    if (brandKit) {
      checkBrandKitCompliance(fixedModule, brandKit, issues);
    }

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
  isEmail = false,
  isBlog = false,
): string {
  if (!jsonStr || jsonStr.trim() === "") {
    issues.push({
      module: moduleName,
      field,
      message: `Empty ${field}`,
      autoFixed: field === "metaJson",
    });
    if (field === "metaJson") {
      const defaultType = isEmail ? "EMAIL" : isBlog ? "BLOG_POST" : "PAGE";
      return JSON.stringify({
        host_template_types: [defaultType],
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
 * Splits class attribute values by HubL tags first so keywords inside
 * {% %} and {{ }} blocks are never mistaken for CSS class names.
 */
function fixHtmlClassPrefix(
  html: string,
  moduleName: string,
  themeName: string,
  issues: ValidationIssue[],
): string {
  if (!html) return html;

  const prefix = themeName + "-";

  const classAttrRe = /class="([^"]*)"/g;
  let anyFixed = false;

  const fixed = html.replace(classAttrRe, (fullMatch, classValue: string) => {
    const hublRe = /(\{%[-~]?[\s\S]*?[-~]?%\}|\{\{[\s\S]*?\}\})/g;
    const segments = classValue.split(hublRe);
    let changed = false;

    const processed = segments
      .map((seg, i) => {
        if (i % 2 === 1) return seg;
        return seg
          .split(/(\s+)/)
          .map((token) => {
            if (/^\s*$/.test(token)) return token;
            if (
              token &&
              !token.startsWith(prefix) &&
              !shouldSkipClass(token) &&
              /^[a-zA-Z][\w-]*$/.test(token)
            ) {
              changed = true;
              return prefix + token;
            }
            return token;
          })
          .join("");
      })
      .join("");

    if (changed) {
      anyFixed = true;
      return `class="${processed}"`;
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

  // Strip CSS-class prefixes that leaked onto HubL keywords inside {% %} tags.
  // E.g. {% theme-name-if ... theme-name-is ... %} → {% if ... is ... %}
  const HUBL_KW = [
    "if", "elif", "else", "endif", "for", "endfor", "set", "do",
    "block", "endblock", "macro", "endmacro", "call", "endcall",
    "filter", "endfilter", "raw", "endraw", "include", "import",
    "from", "extends", "print", "unless", "endunless",
    "is", "not", "and", "or", "in",
  ];
  const kwAlt = HUBL_KW.join("|");
  const prefixedKwToken = new RegExp(`\\b[a-zA-Z][\\w-]*-(${kwAlt})\\b(?!-)`, "g");
  const hublTagRe = /(\{%[-~]?[\s\S]*?[-~]?%\})/g;
  let kwStripped = false;
  fixed = fixed.replace(hublTagRe, (tag) => {
    const cleaned = tag.replace(prefixedKwToken, (_match, kw) => {
      kwStripped = true;
      return kw;
    });
    return cleaned;
  });
  if (kwStripped) {
    issues.push({
      module: moduleName,
      field: "moduleHtml",
      message: "Stripped CSS-class prefix from HubL keywords inside {% %} tags",
      autoFixed: true,
    });
  }

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
  isEmail = false,
  isBlog = false,
): string {
  const parsed = tryParseJSON(metaJson);
  if (!parsed || typeof parsed !== "object") return metaJson;

  const obj = parsed as Record<string, unknown>;
  let changed = false;

  if (!obj.host_template_types) {
    const defaultType = isEmail ? "EMAIL" : isBlog ? "BLOG_POST" : "PAGE";
    obj.host_template_types = [defaultType];
    changed = true;
  } else if (isEmail) {
    const types = obj.host_template_types as string[];
    if (!types.includes("EMAIL")) {
      obj.host_template_types = ["EMAIL"];
      changed = true;
      issues.push({
        module: moduleName,
        field: "metaJson",
        message: 'Fixed host_template_types to ["EMAIL"] for email module',
        autoFixed: true,
      });
    }
  } else if (isBlog) {
    const types = obj.host_template_types as string[];
    const hasBlogType = types.includes("BLOG_POST") || types.includes("BLOG_LISTING");
    if (!hasBlogType) {
      obj.host_template_types = ["BLOG_POST"];
      changed = true;
      issues.push({
        module: moduleName,
        field: "metaJson",
        message: 'Fixed host_template_types to include blog type for blog module',
        autoFixed: true,
      });
    }
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

// ---------------------------------------------------------------------------
// Multi-page: cross-page navigation link validation
// ---------------------------------------------------------------------------

export interface NavValidationIssue {
  module: string;
  message: string;
  autoFixed: boolean;
}

export function validateNavLinks(
  modules: ModuleFiles[],
  pageSlugs: string[],
): NavValidationIssue[] {
  const issues: NavValidationIssue[] = [];
  const slugSet = new Set(pageSlugs.map((s) => `/${s}`));

  for (const mod of modules) {
    if (!mod.moduleName.includes("header") && !mod.moduleName.includes("nav") && !mod.moduleName.includes("footer")) {
      continue;
    }

    const hrefPattern = /href=["'](\/?[a-z0-9][a-z0-9-]*(?:\/[a-z0-9-]*)*)["']/gi;
    let match;
    const foundLinks: string[] = [];

    while ((match = hrefPattern.exec(mod.moduleHtml)) !== null) {
      let href = match[1];
      if (!href.startsWith("/")) href = "/" + href;
      if (href === "/" || href.startsWith("/http") || href.startsWith("/#")) continue;
      foundLinks.push(href);
    }

    for (const link of foundLinks) {
      if (!slugSet.has(link)) {
        issues.push({
          module: mod.moduleName,
          message: `Nav link "${link}" does not match any page slug (valid: ${pageSlugs.map((s) => "/" + s).join(", ")})`,
          autoFixed: false,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Brand kit compliance check
// ---------------------------------------------------------------------------

const HEX_COLOR_RE = /#[0-9a-fA-F]{6}\b/g;

function checkBrandKitCompliance(
  mod: ModuleFiles,
  kit: BrandKit,
  issues: ValidationIssue[],
): void {
  const brandColors = new Set<string>();
  if (kit.colors?.primary) brandColors.add(kit.colors.primary.toLowerCase());
  if (kit.colors?.secondary) brandColors.add(kit.colors.secondary.toLowerCase());
  if (kit.colors?.accent) brandColors.add(kit.colors.accent.toLowerCase());

  if (brandColors.size === 0 && !kit.fonts?.heading && !kit.fonts?.body) return;

  const htmlAndCss = (mod.moduleHtml || "") + (mod.moduleCss || "");

  if (brandColors.size > 0) {
    const usedColors = new Set<string>();
    for (const match of htmlAndCss.matchAll(HEX_COLOR_RE)) {
      usedColors.add(match[0].toLowerCase());
    }

    const neutrals = new Set([
      "#ffffff", "#000000", "#f4f4f4", "#f5f5f5", "#fafafa", "#eeeeee",
      "#e0e0e0", "#dddddd", "#cccccc", "#999999", "#666666", "#333333",
      "#1a1a1a", "#111111", "#222222", "#444444", "#555555", "#777777",
      "#888888", "#aaaaaa", "#bbbbbb",
    ]);

    for (const color of usedColors) {
      if (neutrals.has(color)) continue;
      if (!brandColors.has(color)) {
        issues.push({
          module: mod.moduleName,
          field: "moduleHtml",
          message: `Off-brand color ${color} (brand colors: ${[...brandColors].join(", ")})`,
          autoFixed: false,
        });
        break;
      }
    }
  }

  if (kit.fonts?.heading || kit.fonts?.body) {
    const brandFonts: string[] = [];
    if (kit.fonts.heading) brandFonts.push(kit.fonts.heading.toLowerCase());
    if (kit.fonts.body) brandFonts.push(kit.fonts.body.toLowerCase());

    const fontFamilyRe = /font-family:\s*([^;}"]+)/gi;
    for (const match of htmlAndCss.matchAll(fontFamilyRe)) {
      const fontValue = match[1].toLowerCase().trim();
      if (!brandFonts.some((bf) => fontValue.includes(bf))) {
        issues.push({
          module: mod.moduleName,
          field: "moduleHtml",
          message: `Off-brand font "${match[1].trim()}" (brand fonts: ${brandFonts.join(", ")})`,
          autoFixed: false,
        });
        break;
      }
    }
  }
}

/**
 * Email-specific validation and auto-fix.
 */
function validateEmailModule(
  mod: ModuleFiles,
  issues: ValidationIssue[],
): ModuleFiles {
  const fixedModule = { ...mod };
  let html = fixedModule.moduleHtml;

  if (fixedModule.moduleCss && fixedModule.moduleCss.trim()) {
    issues.push({
      module: mod.moduleName,
      field: "moduleCss",
      message: "Cleared moduleCss — email modules must use inline styles only",
      autoFixed: true,
    });
    fixedModule.moduleCss = "";
  }

  if (fixedModule.moduleJs && fixedModule.moduleJs.trim()) {
    issues.push({
      module: mod.moduleName,
      field: "moduleJs",
      message: "Cleared moduleJs — email clients do not support JavaScript",
      autoFixed: true,
    });
    fixedModule.moduleJs = undefined;
  }

  if (/<style[\s>]/i.test(html)) {
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "Removed <style> blocks — email clients strip them",
      autoFixed: true,
    });
  }

  if (/display\s*:\s*flex/i.test(html)) {
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "Contains display:flex — not supported in email clients",
      autoFixed: false,
    });
  }

  if (/display\s*:\s*grid/i.test(html)) {
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "Contains display:grid — not supported in email clients",
      autoFixed: false,
    });
  }

  if (/var\s*\(/i.test(html)) {
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "Contains var() — CSS custom properties not supported in email",
      autoFixed: false,
    });
  }

  const bannedHublRe = /\{[{%].*?(?:require_css|require_js|scope_css|get_asset_url)\s*\(.*?\}[}%]/g;
  if (bannedHublRe.test(html)) {
    html = html.replace(bannedHublRe, "");
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "Removed banned HubL functions for email (require_css, require_js, scope_css, get_asset_url)",
      autoFixed: true,
    });
  }

  const linkTagRe = /<link[^>]*href="https?:\/\/[^"]*(?:fonts\.googleapis|cdnjs|unpkg|jsdelivr)[^"]*"[^>]*\/?>/gi;
  if (linkTagRe.test(html)) {
    html = html.replace(linkTagRe, "");
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "Removed CDN <link> tags — external resources not supported in email",
      autoFixed: true,
    });
  }

  fixedModule.moduleHtml = html;
  return fixedModule;
}

/**
 * Blog-specific validation and auto-fix.
 */
function validateBlogModule(
  mod: ModuleFiles,
  issues: ValidationIssue[],
): ModuleFiles {
  const fixedModule = { ...mod };
  let html = fixedModule.moduleHtml;

  if (/\{\{[\s]*content\.body[\s]*\}\}/g.test(html)) {
    html = html.replace(
      /\{\{[\s]*content\.body[\s]*\}\}/g,
      "{{ content.post_body }}",
    );
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "Fixed content.body → content.post_body (correct blog variable)",
      autoFixed: true,
    });
  }

  if (/\{\{[\s]*content\.title[\s]*\}\}/g.test(html)) {
    html = html.replace(
      /\{\{[\s]*content\.title[\s]*\}\}/g,
      "{{ content.name }}",
    );
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "Fixed content.title → content.name (correct blog variable)",
      autoFixed: true,
    });
  }

  if (/\{\{[\s]*content\.author_name[\s]*\}\}/g.test(html)) {
    html = html.replace(
      /\{\{[\s]*content\.author_name[\s]*\}\}/g,
      "{{ content.blog_post_author }}",
    );
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "Fixed content.author_name → content.blog_post_author",
      autoFixed: true,
    });
  }

  if (/\{\{[\s]*content\.date[\s]*\}\}/g.test(html)) {
    html = html.replace(
      /\{\{[\s]*content\.date[\s]*\}\}/g,
      "{{ content.publish_date }}",
    );
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "Fixed content.date → content.publish_date",
      autoFixed: true,
    });
  }

  if (/\{\{[\s]*content\.image[\s]*\}\}/g.test(html)) {
    html = html.replace(
      /\{\{[\s]*content\.image[\s]*\}\}/g,
      "{{ content.featured_image }}",
    );
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "Fixed content.image → content.featured_image",
      autoFixed: true,
    });
  }

  if (/\{%.*dnd_area.*%\}/g.test(html)) {
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "Contains dnd_area — blog templates typically use fixed module positions",
      autoFixed: false,
    });
  }

  const rawDateRe = /\{\{[\s]*content\.publish_date[\s]*\}\}/g;
  if (rawDateRe.test(html)) {
    issues.push({
      module: mod.moduleName,
      field: "moduleHtml",
      message: "publish_date used without |datetimeformat filter — dates may render as raw timestamps",
      autoFixed: false,
    });
  }

  fixedModule.moduleHtml = html;
  return fixedModule;
}
