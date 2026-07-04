/**
 * Lightweight HubL subset renderer for local preview.
 *
 * Supports the constructs that AI-generated HubSpot modules actually use:
 *   {{ module.field }}             — variable access
 *   {{ module.group.child }}       — nested access
 *   {% if module.field %}...{% endif %}     — conditionals (+ {% elif %}/{% else %})
 *   {% for item in module.list %}...{% endfor %} — loops
 *   {{ item.field }}               — loop variable access
 *
 * get_asset_url("assets/...") is resolved to /theme-assets/ for local preview.
 * Everything else (require_css, dnd_area, etc.) is stripped.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FieldDef {
  name: string;
  type: string;
  default?: unknown;
  children?: FieldDef[];
  occurrence?: { min: number; max: number };
  tab?: string;
}

export interface RenderContext {
  module: Record<string, unknown>;
  [key: string]: unknown;
}

const FIELD_TYPES = Symbol("hublFieldTypes");

interface TypedContextObject extends Record<string, unknown> {
  [FIELD_TYPES]?: Map<string, string>;
}

type ExpressionContext = "htmlText" | "htmlTag" | "style" | "script";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a render context from a fields.json array, using each field's default.
 */
export function buildContextFromFields(fields: FieldDef[]): Record<string, unknown> {
  const result: TypedContextObject = {};
  const fieldTypes = new Map<string, string>();

  for (const field of fields) {
    fieldTypes.set(field.name, field.type);

    if (field.type === "group" && field.occurrence && Array.isArray(field.default)) {
      // Repeater group — default is an array of objects
      result[field.name] = field.children
        ? annotateRepeaterDefaults(field.default, field.children)
        : field.default;
    } else if (field.type === "group" && field.children) {
      // Nested group (e.g. styles) — recurse into children
      const childContext = buildContextFromFields(field.children);
      mergeFieldTypes(fieldTypes, field.name, childContext);
      result[field.name] = childContext;
    } else {
      result[field.name] = field.default ?? "";
    }
  }

  defineFieldTypes(result, fieldTypes);
  return result;
}

/**
 * Render a HubL template string with the given context.
 * Returns plain HTML suitable for browser rendering.
 */
export function renderHubL(template: string, context: RenderContext): string {
  let output = template;

  // 1. Strip HubSpot-only directives that don't apply in preview
  output = stripDirectives(output);

  // 2. Process {% for %} loops (must come before if/expressions)
  output = processForLoops(output, context);

  // 3. Process {% if %} / {% else %} / {% endif %} conditionals
  output = processConditionals(output, context);

  // 4. Resolve {{ expression }} variable references
  output = resolveExpressions(output, context);

  // 5. Clean up any remaining unresolved tags
  output = cleanupRemaining(output);

  return output;
}

/**
 * Assemble a full preview HTML page from rendered modules + CSS/JS.
 */
export function assemblePreview(opts: {
  renderedModules: string[];
  sharedCss?: string;
  moduleCssArray: string[];
  sharedJs?: string;
  moduleJsArray: string[];
}): string {
  const styleBlocks = [
    opts.sharedCss || "",
    ...opts.moduleCssArray,
  ]
    .filter(Boolean)
    .map((css) => `<style>${escapeStyleContent(css)}</style>`)
    .join("\n");

  const scriptBlocks = [
    opts.sharedJs || "",
    ...opts.moduleJsArray,
  ]
    .filter(Boolean)
    .map((js) => `<script>${escapeScriptContent(js)}</script>`)
    .join("\n");

  const body = opts.renderedModules.join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${styleBlocks}
<style>
html{scroll-behavior:smooth}
.vsp-img-wrap{position:relative;display:inline-block}
.vsp-img-badge{position:absolute;top:8px;right:8px;background:rgba(0,0,0,.75);color:#fff;font:500 11px/1 -apple-system,sans-serif;padding:5px 8px;border-radius:4px;pointer-events:none;opacity:.85;white-space:nowrap;z-index:10}
</style>
</head>
<body>
${body}
${scriptBlocks}
<script>
// Anchor link handler — smooth scroll to module sections
document.addEventListener('click',function(e){
  var a=e.target.closest('a[href^="#"]');
  if(!a)return;
  var id=a.getAttribute('href').slice(1);
  if(!id)return;
  var el=document.getElementById(id);
  if(el){
    e.preventDefault();
    el.scrollIntoView({behavior:'smooth',block:'start'});
  }
});
// Placeholder image badges
document.querySelectorAll('img').forEach(function(img){
  var src=img.src||img.getAttribute('src')||'';
  if(src.indexOf('placehold')!==-1){
    var w=document.createElement('span');
    w.className='vsp-img-wrap';
    img.parentNode.insertBefore(w,img);
    w.appendChild(img);
    var b=document.createElement('span');
    b.className='vsp-img-badge';
    b.textContent='Placeholder — replace in HubSpot';
    w.appendChild(b);
  }
});
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// Pre-compiled regex patterns for stripDirectives (avoid recompilation per render)
const RE_REQUIRE_TAG = /\{%[-\s]*require_(css|js)\b.*?%\}/gs;
const RE_END_REQUIRE_TAG = /\{%[-\s]*end_require_(css|js)\s*%\}/gs;
const RE_REQUIRE_EXPR = /\{\{[-\s]*require_(css|js)\(.*?\)\s*\}\}/gs;
const RE_GET_ASSET_URL = /\{\{[-\s]*get_asset_url\(["'](?:[^"'\/]+\/)?assets\/(.*?)["']\)\s*\}\}/gs;
const RE_GET_ASSET_URL_STRIP = /\{\{[-\s]*get_asset_url\(.*?\)\s*\}\}/gs;
const RE_DND_TAGS = /\{%[-\s]*(end_)?(dnd_area|dnd_section|dnd_column|dnd_row|dnd_module)\b.*?%\}/gs;
const RE_MODULE_TAG = /\{%[-\s]*module\b.*?%\}/gs;
const RE_TEMPLATE_TAGS = /\{%[-\s]*(extends|block|endblock|set)\b.*?%\}/gs;
const RE_ANNOTATIONS = /\{#.*?#\}/gs;
const RE_CONTENT_VARS = /\{\{[-\s]*content\.\w+.*?\}\}/gs;
const RE_CONDITIONAL_TAG = /\{%[-\s]*(if\s+([\s\S]*?)|elif\s+([\s\S]*?)|else|endif)\s*-?%\}/g;

/**
 * Strip HubSpot-specific directives that have no meaning in local preview.
 */
function stripDirectives(tpl: string): string {
  tpl = tpl.replace(RE_REQUIRE_TAG, "");
  tpl = tpl.replace(RE_END_REQUIRE_TAG, "");
  tpl = tpl.replace(RE_REQUIRE_EXPR, "");
  // Resolve get_asset_url("assets/filename") → /theme-assets/filename for preview
  RE_GET_ASSET_URL.lastIndex = 0;
  tpl = tpl.replace(RE_GET_ASSET_URL, (_match, filename) => `/theme-assets/${filename}`);
  // Strip any remaining get_asset_url() calls with non-standard paths
  RE_GET_ASSET_URL_STRIP.lastIndex = 0;
  tpl = tpl.replace(RE_GET_ASSET_URL_STRIP, "");
  tpl = tpl.replace(RE_DND_TAGS, "");
  tpl = tpl.replace(RE_MODULE_TAG, "");
  tpl = tpl.replace(RE_TEMPLATE_TAGS, "");
  tpl = tpl.replace(RE_ANNOTATIONS, "");
  tpl = tpl.replace(RE_CONTENT_VARS, "");
  return tpl;
}

function defineFieldTypes(target: TypedContextObject, fieldTypes: Map<string, string>): void {
  Object.defineProperty(target, FIELD_TYPES, {
    value: fieldTypes,
    enumerable: false,
    configurable: false,
  });
}

function mergeFieldTypes(target: Map<string, string>, prefix: string, childContext: Record<string, unknown>): void {
  const childTypes = getFieldTypes(childContext);
  if (!childTypes) return;

  for (const [path, type] of childTypes) {
    target.set(`${prefix}.${path}`, type);
  }
}

function annotateRepeaterDefaults(defaults: unknown[], children: FieldDef[]): unknown[] {
  return defaults.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;

    const annotated = { ...(item as Record<string, unknown>) } as TypedContextObject;
    const childTypes = buildFieldTypes(children);
    defineFieldTypes(annotated, childTypes);
    return annotated;
  });
}

function buildFieldTypes(fields: FieldDef[], prefix = ""): Map<string, string> {
  const fieldTypes = new Map<string, string>();

  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    fieldTypes.set(path, field.type);
    if (field.type === "group" && field.children) {
      const childTypes = buildFieldTypes(field.children, path);
      for (const [childPath, type] of childTypes) {
        fieldTypes.set(childPath, type);
      }
    }
  }

  return fieldTypes;
}

function getFieldTypes(value: unknown): Map<string, string> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return (value as TypedContextObject)[FIELD_TYPES];
}

/**
 * Process {% for VAR in PATH %}...{% endfor %} loops.
 * Uses balanced tag matching to handle nested for-loops correctly.
 */
function processForLoops(tpl: string, context: RenderContext): string {
  let result = tpl;
  let safety = 0;

  while (safety < 30) {
    safety++;
    const match = findOutermostFor(result);
    if (!match) break;

    const { varName, iterExpr, body, start, end } = match;
    const items = resolveIterable(iterExpr, context);

    let rendered = "";
    if (Array.isArray(items)) {
      rendered = items
        .map((item, index) => {
          const loopContext: RenderContext = {
            ...context,
            [varName]: item,
            loop: { index: index + 1, index0: index, first: index === 0, last: index === items.length - 1, length: items.length },
          };

          let out = processForLoops(body, loopContext);
          out = processConditionals(out, loopContext);
          out = resolveExpressions(out, loopContext);
          return out;
        })
        .join("");
    }

    result = result.slice(0, start) + rendered + result.slice(end);
  }

  return result;
}

/**
 * Find the first outermost {% for %}...{% endfor %} block with balanced nesting.
 */
function findOutermostFor(tpl: string): { varName: string; iterExpr: string; body: string; start: number; end: number } | null {
  const openTag = /\{%[-\s]*for\s+(\w+)\s+in\s+([\w.]+(?:\([^)]*\))?(?:\|[\w(),"' ]+)*)\s*-?%\}/g;
  const forOrEndfor = /\{%[-\s]*(for\s|endfor)\s*.*?-?%\}/g;

  const firstOpen = openTag.exec(tpl);
  if (!firstOpen) return null;

  const varName = firstOpen[1];
  const iterExpr = firstOpen[2];
  const bodyStart = firstOpen.index + firstOpen[0].length;

  // Find matching endfor by counting nesting depth
  forOrEndfor.lastIndex = bodyStart;
  let depth = 1;
  let m: RegExpExecArray | null;

  while ((m = forOrEndfor.exec(tpl)) !== null) {
    if (m[1].startsWith("for")) {
      depth++;
    } else {
      depth--;
      if (depth === 0) {
        const body = tpl.slice(bodyStart, m.index);
        return { varName, iterExpr, body, start: firstOpen.index, end: m.index + m[0].length };
      }
    }
  }

  return null; // Unmatched for-loop
}

/**
 * Process {% if EXPR %}...{% else %}...{% endif %} conditionals.
 * Supports {% elif %} as well.
 */
function processConditionals(tpl: string, context: RenderContext): string {
  let result = tpl;
  let safety = 0;
  const maxBlocks = countIfBlocks(tpl);

  while (safety < maxBlocks) {
    safety++;
    const block = findInnermostIfBlock(result);
    if (!block) break;

    const rendered = renderConditionalBlock(block.condition, block.body, context);
    result = result.slice(0, block.start) + rendered + result.slice(block.end);
  }

  return result;
}

function countIfBlocks(tpl: string): number {
  const matches = tpl.match(/\{%[-\s]*if\s+/g);
  return matches ? matches.length : 0;
}

function findInnermostIfBlock(tpl: string): { condition: string; body: string; start: number; end: number } | null {
  const stack: { condition: string; start: number; bodyStart: number }[] = [];
  RE_CONDITIONAL_TAG.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = RE_CONDITIONAL_TAG.exec(tpl)) !== null) {
    const tag = match[1].trim();

    if (tag.startsWith("if ")) {
      stack.push({
        condition: match[2].trim(),
        start: match.index,
        bodyStart: match.index + match[0].length,
      });
    } else if (tag === "endif" && stack.length > 0) {
      const open = stack.pop()!;
      return {
        condition: open.condition,
        body: tpl.slice(open.bodyStart, match.index),
        start: open.start,
        end: match.index + match[0].length,
      };
    }
  }

  return null;
}

function renderConditionalBlock(condition: string, body: string, context: RenderContext): string {
  const branches: { condition: string | null; body: string }[] = [];
  let branchCondition: string | null = condition;
  let branchStart = 0;
  let nestedDepth = 0;

  RE_CONDITIONAL_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RE_CONDITIONAL_TAG.exec(body)) !== null) {
    const tag = match[1].trim();

    if (tag.startsWith("if ")) {
      nestedDepth++;
      continue;
    }
    if (tag === "endif") {
      nestedDepth = Math.max(0, nestedDepth - 1);
      continue;
    }
    if (nestedDepth > 0) continue;

    if (tag.startsWith("elif ") || tag === "else") {
      branches.push({ condition: branchCondition, body: body.slice(branchStart, match.index) });
      branchCondition = tag === "else" ? null : match[3].trim();
      branchStart = match.index + match[0].length;
    }
  }

  branches.push({ condition: branchCondition, body: body.slice(branchStart) });

  for (const branch of branches) {
    if (branch.condition === null || evaluateCondition(branch.condition, context)) {
      return branch.body;
    }
  }

  return "";
}

/**
 * Resolve all {{ expression }} references in the template.
 */
function resolveExpressions(tpl: string, context: RenderContext): string {
  return tpl.replace(/\{\{[-\s]*(.*?)[-\s]*\}\}/g, (_match, expr: string, offset: number) => {
    const trimmed = expr.trim();
    const expressionContext = getExpressionContext(tpl, offset);

    // Handle filters: {{ value|filter }}
    const filterParts = trimmed.split("|");
    const path = filterParts[0].trim();

    let value = resolveValueExpr(context, path);
    let escapedByFilter = false;
    let safeByFilter = false;

    // Apply basic filters
    for (let i = 1; i < filterParts.length; i++) {
      const filter = filterParts[i].trim();
      const filterName = getFilterName(filter);
      value = applyFilter(value, filter);
      if (filterName === "escape" || filterName === "e") {
        escapedByFilter = true;
      } else if (filterName === "safe") {
        safeByFilter = true;
      }
    }

    if (value === null || value === undefined) return "";
    if (typeof value === "object") value = JSON.stringify(value);
    // Strip literal \n sequences that AI sometimes puts in field defaults
    let str = String(value);
    str = str.replace(/\\n/g, " ").replace(/\n/g, " ");

    if (escapedByFilter) return str;

    if (expressionContext === "style") return escapeStyleContent(str);
    if (expressionContext === "script") return escapeScriptExpression(str);

    if (
      expressionContext === "htmlText" &&
      (safeByFilter || isHtmlFieldPath(context, path))
    ) {
      return sanitizeTrustedHtml(str);
    }

    return escapeHtml(str);
  });
}

function getExpressionContext(tpl: string, offset: number): ExpressionContext {
  const before = tpl.slice(0, offset);
  const lastScriptOpen = before.toLowerCase().lastIndexOf("<script");
  const lastScriptClose = before.toLowerCase().lastIndexOf("</script");
  if (lastScriptOpen > lastScriptClose) return "script";

  const lastStyleOpen = before.toLowerCase().lastIndexOf("<style");
  const lastStyleClose = before.toLowerCase().lastIndexOf("</style");
  if (lastStyleOpen > lastStyleClose) return "style";

  const lastTagOpen = before.lastIndexOf("<");
  const lastTagClose = before.lastIndexOf(">");
  return lastTagOpen > lastTagClose ? "htmlTag" : "htmlText";
}

function isHtmlFieldPath(context: RenderContext, path: string): boolean {
  const parts = path.split(".");
  if (parts.length < 2) return false;

  let current: unknown = context;
  let metadataPath = "";

  for (let i = 0; i < parts.length; i++) {
    if (current === null || typeof current !== "object") return false;

    const fieldTypes = getFieldTypes(current);
    if (fieldTypes) {
      metadataPath = parts.slice(i).join(".");
      const type = fieldTypes.get(metadataPath);
      return type === "richtext" || type === "html";
    }

    current = (current as Record<string, unknown>)[parts[i]];
  }

  return false;
}

/**
 * Clean up any remaining HubL tags that weren't handled.
 */
function cleanupRemaining(tpl: string): string {
  // Remove any remaining {% ... %} tags
  tpl = tpl.replace(/\{%.*?%\}/gs, "");
  // Remove any remaining {{ ... }} that reference unknown paths
  tpl = tpl.replace(/\{\{.*?\}\}/gs, "");
  return tpl;
}

/**
 * Resolve an iterable expression for {% for %} loops.
 * Handles dotted paths (module.services) and range(start, end) calls.
 */
function resolveIterable(expr: string, context: RenderContext): unknown {
  // Handle range(start, end) — with possible filter on args
  const rangeMatch = expr.match(/^range\(\s*(.+?)\s*,\s*(.+?)\s*\)$/);
  if (rangeMatch) {
    const start = resolveNumericArg(rangeMatch[1], context);
    const end = resolveNumericArg(rangeMatch[2], context);
    const arr: number[] = [];
    for (let i = start; i < end; i++) arr.push(i);
    return arr;
  }

  // Handle split('...') filter: "value|split('\n')"
  const splitMatch = expr.match(/^(.+?)\|split\(['"](.+?)['"]\)$/);
  if (splitMatch) {
    const val = resolvePath(context, splitMatch[1].trim());
    if (typeof val === "string") return val.split(splitMatch[2]);
    return [];
  }

  return resolvePath(context, expr);
}

/**
 * Resolve a numeric argument that may be a literal, a path, or a path|filter.
 */
function resolveNumericArg(arg: string, context: RenderContext): number {
  const trimmed = arg.trim();

  // Apply filters (e.g. "item.rating|int")
  const filterParts = trimmed.split("|");
  const path = filterParts[0].trim();

  // Literal number
  if (!isNaN(Number(path))) return Number(path);

  // Path lookup
  let value = resolvePath(context, path);
  for (let i = 1; i < filterParts.length; i++) {
    value = applyFilter(value, filterParts[i].trim());
  }
  return Number(value) || 0;
}

/**
 * Resolve a dot-path expression against a context object.
 * E.g. "module.styles.bg_color.color" → context.module.styles.bg_color.color
 */
function resolvePath(context: RenderContext, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = context;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Resolve a value expression that may include simple arithmetic on a path.
 * Handles the common HubSpot opacity idiom `module.styles.x.opacity/100` (and `*`).
 * If the left path is empty/non-numeric, the whole expression collapses to "" —
 * this is intentional: an undefaulted style field renders empty, which surfaces
 * the invalid-CSS defect instead of masking it.
 */
function resolveValueExpr(context: RenderContext, expr: string): unknown {
  const arith = expr.match(/^(.+?)\s*([*/])\s*([\d.]+)$/);
  if (arith) {
    const left = resolvePath(context, arith[1].trim());
    if (left === undefined || left === null || left === "") return "";
    const ln = Number(left);
    if (Number.isNaN(ln)) return "";
    const rn = Number(arith[3]);
    if (arith[2] === "/") return rn === 0 ? "" : ln / rn;
    return ln * rn;
  }
  return resolvePath(context, expr);
}

/**
 * Evaluate a simple condition expression.
 * Supports: path truthiness, "not path", "path == value", "path != value"
 */
function evaluateCondition(expr: string, context: RenderContext): boolean {
  const trimmed = expr.trim();

  // Handle "not" prefix
  if (trimmed.startsWith("not ")) {
    return !evaluateCondition(trimmed.slice(4), context);
  }

  // Handle "and" / "or"
  if (trimmed.includes(" and ")) {
    return trimmed.split(" and ").every((part) => evaluateCondition(part, context));
  }
  if (trimmed.includes(" or ")) {
    return trimmed.split(" or ").some((part) => evaluateCondition(part, context));
  }

  // Handle comparison operators
  const eqMatch = trimmed.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (eqMatch) {
    const left = resolvePath(context, eqMatch[1].trim());
    const operator = eqMatch[2];
    let right: unknown = eqMatch[3].trim();

    // Parse right side: string literal, number, or path
    if (
      (typeof right === "string" && right.startsWith('"') && right.endsWith('"')) ||
      (typeof right === "string" && right.startsWith("'") && right.endsWith("'"))
    ) {
      right = (right as string).slice(1, -1);
    } else if (!isNaN(Number(right))) {
      right = Number(right);
    } else {
      right = resolvePath(context, right as string);
    }

    switch (operator) {
      case "==": return left == right;
      case "!=": return left != right;
      case ">": return Number(left) > Number(right);
      case "<": return Number(left) < Number(right);
      case ">=": return Number(left) >= Number(right);
      case "<=": return Number(left) <= Number(right);
    }
  }

  // Simple truthiness
  const value = resolvePath(context, trimmed);
  return isTruthy(value);
}

/**
 * Check HubL-style truthiness (empty strings and 0 are falsy).
 */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value === "") return false;
  if (value === 0) return false;
  if (value === false) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/**
 * Apply a basic HubL filter.
 */
function applyFilter(value: unknown, filter: string): unknown {
  const str = value === null || value === undefined ? "" : String(value);

  // Handle filters with arguments: truncate(100), default("fallback")
  const argMatch = filter.match(/^(\w+)\((.*)\)$/);
  const filterName = argMatch ? argMatch[1] : filter;
  const filterArg = argMatch ? argMatch[2].replace(/^["']|["']$/g, "") : undefined;

  switch (filterName) {
    case "escape":
    case "e":
      return escapeHtml(str);
    case "safe":
      return value;
    case "lower":
      return str.toLowerCase();
    case "upper":
      return str.toUpperCase();
    case "capitalize":
      return str.charAt(0).toUpperCase() + str.slice(1);
    case "trim":
      return str.trim();
    case "truncate":
      if (filterArg) {
        const len = parseInt(filterArg, 10);
        return str.length > len ? str.slice(0, len) + "..." : str;
      }
      return str;
    case "default":
      return isTruthy(value) ? value : (filterArg ?? "");
    case "length":
      if (Array.isArray(value)) return value.length;
      return str.length;
    case "join":
      if (Array.isArray(value)) return value.join(filterArg ?? ", ");
      return str;
    case "int":
    case "float":
      return Number(str) || 0;
    case "abs":
      return Math.abs(Number(str));
    case "round":
      return Math.round(Number(str));
    case "convert_rgb": {
      // HubSpot filter: hex color (or color-field object) → "r, g, b".
      // Empty/invalid input → "" so the surrounding rgba() collapses, surfacing
      // the defect rather than emitting invalid CSS like rgba(#hex, ...).
      const hex = extractHex(value);
      return hex ? hexToRgbTriple(hex) : "";
    }
    default:
      // Unknown filter — pass through
      return value;
  }
}

function getFilterName(filter: string): string {
  const match = filter.match(/^(\w+)(?:\(.*\))?$/);
  return match ? match[1] : filter;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeStyleContent(value: string): string {
  return value.replace(/<\/style/gi, "<\\/style");
}

function escapeScriptContent(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function escapeScriptExpression(value: string): string {
  return escapeScriptContent(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

interface HtmlTagToken {
  tagName: string;
  closing: boolean;
  attrs: HtmlAttribute[];
}

interface HtmlAttribute {
  name: string;
  value: string | null;
}

const RAW_TEXT_BLOCKED_TAGS = new Set(["script", "style", "iframe", "object", "embed"]);
const ALLOWED_HTML_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "cite",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const GLOBAL_HTML_ATTRS = new Set([
  "class",
  "dir",
  "id",
  "lang",
  "role",
  "title",
]);

const TAG_HTML_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "name", "rel", "target"]),
  blockquote: new Set(["cite"]),
  del: new Set(["cite", "datetime"]),
  details: new Set(["open"]),
  img: new Set(["alt", "decoding", "height", "loading", "src", "title", "width"]),
  ins: new Set(["cite", "datetime"]),
  q: new Set(["cite"]),
  td: new Set(["colspan", "headers", "rowspan"]),
  th: new Set(["colspan", "headers", "rowspan", "scope"]),
};

const URL_HTML_ATTRS = new Set(["cite", "href", "src"]);
const VOID_HTML_TAGS = new Set(["br", "hr", "img"]);

function sanitizeTrustedHtml(value: string): string {
  let sanitized = "";
  let index = 0;
  let skipRawTextTag: string | null = null;

  while (index < value.length) {
    const nextTagStart = value.indexOf("<", index);
    if (nextTagStart === -1) {
      if (!skipRawTextTag) sanitized += value.slice(index);
      break;
    }

    if (!skipRawTextTag) sanitized += value.slice(index, nextTagStart);

    const tagEnd = findHtmlTagEnd(value, nextTagStart);
    if (tagEnd === -1) {
      if (!skipRawTextTag) sanitized += "&lt;";
      index = nextTagStart + 1;
      continue;
    }

    const rawTag = value.slice(nextTagStart, tagEnd + 1);
    const token = parseHtmlTag(rawTag);
    index = tagEnd + 1;

    if (!token) continue;

    if (skipRawTextTag) {
      if (token.closing && token.tagName === skipRawTextTag) {
        skipRawTextTag = null;
      }
      continue;
    }

    if (RAW_TEXT_BLOCKED_TAGS.has(token.tagName)) {
      if (!token.closing) skipRawTextTag = token.tagName;
      continue;
    }

    if (!ALLOWED_HTML_TAGS.has(token.tagName)) continue;

    if (token.closing) {
      if (!VOID_HTML_TAGS.has(token.tagName)) sanitized += `</${token.tagName}>`;
      continue;
    }

    sanitized += renderSanitizedOpeningTag(token);
  }

  return sanitized
    .replace(/<\/style/gi, "<\\/style")
    .replace(/<\/script/gi, "<\\/script");
}

function findHtmlTagEnd(value: string, start: number): number {
  let quote: string | null = null;

  for (let i = start + 1; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return i;
  }

  return -1;
}

function parseHtmlTag(rawTag: string): HtmlTagToken | null {
  if (rawTag.startsWith("<!--")) return null;

  let inner = rawTag.slice(1, -1).trim();
  if (!inner || inner.startsWith("!") || inner.startsWith("?")) return null;

  const closing = inner.startsWith("/");
  if (closing) inner = inner.slice(1).trimStart();

  const tagNameMatch = inner.match(/^([A-Za-z][A-Za-z0-9:-]*)/);
  if (!tagNameMatch) return null;

  const tagName = tagNameMatch[1].toLowerCase();
  const attrs = closing ? [] : parseHtmlAttributes(inner.slice(tagNameMatch[0].length));
  return { tagName, closing, attrs };
}

function parseHtmlAttributes(input: string): HtmlAttribute[] {
  const attrs: HtmlAttribute[] = [];
  let index = 0;

  while (index < input.length) {
    while (index < input.length && /[\s/]/.test(input[index])) index++;
    if (index >= input.length) break;

    const nameStart = index;
    while (index < input.length && !/[\s/=]/.test(input[index])) index++;
    const rawName = input.slice(nameStart, index);
    if (!rawName) {
      index++;
      continue;
    }

    while (index < input.length && /\s/.test(input[index])) index++;

    let value: string | null = null;
    if (input[index] === "=") {
      index++;
      while (index < input.length && /\s/.test(input[index])) index++;

      const quote = input[index];
      if (quote === '"' || quote === "'") {
        index++;
        const valueStart = index;
        while (index < input.length && input[index] !== quote) index++;
        value = input.slice(valueStart, index);
        if (input[index] === quote) index++;
      } else {
        const valueStart = index;
        while (index < input.length && !/\s/.test(input[index])) index++;
        value = input.slice(valueStart, index);
      }
    }

    attrs.push({ name: rawName.toLowerCase(), value });
  }

  return attrs;
}

function renderSanitizedOpeningTag(token: HtmlTagToken): string {
  const attrs = token.attrs
    .map((attr) => sanitizeHtmlAttribute(token.tagName, attr))
    .filter((attr): attr is HtmlAttribute => Boolean(attr))
    .map((attr) => {
      if (attr.value === null) return attr.name;
      return `${attr.name}="${escapeHtml(attr.value)}"`;
    })
    .join(" ");

  return attrs ? `<${token.tagName} ${attrs}>` : `<${token.tagName}>`;
}

function sanitizeHtmlAttribute(tagName: string, attr: HtmlAttribute): HtmlAttribute | null {
  const attrName = attr.name;
  if (!attrName) return null;
  if (attrName.startsWith("on")) return null;
  if (attrName === "style") return null;

  const allowedForTag = TAG_HTML_ATTRS[tagName];
  const isAllowed =
    GLOBAL_HTML_ATTRS.has(attrName) ||
    attrName.startsWith("aria-") ||
    attrName.startsWith("data-") ||
    Boolean(allowedForTag?.has(attrName));

  if (!isAllowed) return null;

  if (URL_HTML_ATTRS.has(attrName) && attr.value !== null && !isSafeHtmlUrl(attr.value)) {
    return { name: attrName, value: "#" };
  }

  if (tagName === "a" && attrName === "target" && attr.value === "_blank") {
    return attr;
  }

  if (attrName === "target") return null;

  return attr;
}

function isSafeHtmlUrl(value: string): boolean {
  const decoded = decodeHtmlEntities(value).trim();
  const normalized = decoded.replace(/[\u0000-\u001F\u007F\s]+/g, "").toLowerCase();

  if (
    normalized.startsWith("#") ||
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../")
  ) {
    return true;
  }

  if (normalized.startsWith("data:")) {
    return /^data:image\/(?:gif|jpe?g|png|webp);/i.test(normalized);
  }

  const schemeMatch = normalized.match(/^([a-z][a-z0-9+.-]*):/);
  if (!schemeMatch) return true;

  return ["http", "https", "mailto", "tel"].includes(schemeMatch[1]);
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    colon: ":",
    gt: ">",
    lt: "<",
    newline: "\n",
    quot: '"',
    tab: "\t",
  };

  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);?/gi, (entity, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) {
      const codePoint = parseInt(lower.slice(2), 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (lower.startsWith("#")) {
      const codePoint = parseInt(lower.slice(1), 10);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return namedEntities[lower] ?? entity;
  });
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

/**
 * Pull a 6-digit hex out of a color value: a hex string ("#0f1115" / "0f1115" /
 * "#abc") or a HubSpot color-field object ({ color: "#hex", opacity }).
 * Returns the normalised 6-char hex (no "#") or null.
 */
function extractHex(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const m = value.match(/#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/);
    return m ? normalizeHex(m[1]) : null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.color === "string") return extractHex(obj.color);
    if (typeof obj.hex === "string") return extractHex(obj.hex);
  }
  return null;
}

function normalizeHex(h: string): string {
  const lower = h.toLowerCase();
  if (lower.length === 3) return lower.split("").map((c) => c + c).join("");
  return lower;
}

function hexToRgbTriple(hex: string): string {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}
