/**
 * Lightweight HubL subset renderer for local preview.
 *
 * Supports the constructs that AI-generated HubSpot modules actually use:
 *   {{ module.field }}             — variable access
 *   {{ module.group.child }}       — nested access
 *   {% if module.field %}...{% endif %}     — conditionals (+ {% else %})
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a render context from a fields.json array, using each field's default.
 */
export function buildContextFromFields(fields: FieldDef[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    if (field.type === "group" && field.occurrence && Array.isArray(field.default)) {
      // Repeater group — default is an array of objects
      result[field.name] = field.default;
    } else if (field.type === "group" && field.children) {
      // Nested group (e.g. styles) — recurse into children
      result[field.name] = buildContextFromFields(field.children);
    } else {
      result[field.name] = field.default ?? "";
    }
  }

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
    .map((css) => `<style>${css}</style>`)
    .join("\n");

  const scriptBlocks = [
    opts.sharedJs || "",
    ...opts.moduleJsArray,
  ]
    .filter(Boolean)
    .map((js) => `<script>${js}</script>`)
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
const RE_IF_PATTERN = /\{%[-\s]*if\s+(.*?)\s*-?%\}([\s\S]*?)\{%[-\s]*endif\s*-?%\}/g;

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
  // Process from innermost out
  let result = tpl;
  let safety = 0;

  while (RE_IF_PATTERN.test(result) && safety < 50) {
    safety++;
    result = result.replace(RE_IF_PATTERN, (_match, condition: string, body: string) => {
      // Split on {% else %} and {% elif %}
      const elseMatch = body.split(/\{%[-\s]*else\s*-?%\}/);
      const ifBody = elseMatch[0];
      const elseBody = elseMatch[1] || "";

      // Check for {% elif %} (treat as nested if-else)
      const elifParts = ifBody.split(/\{%[-\s]*elif\s+(.*?)\s*-?%\}/);

      if (elifParts.length > 1) {
        // Has elif branches
        if (evaluateCondition(condition, context)) {
          return elifParts[0];
        }
        // Check elif branches
        for (let i = 1; i < elifParts.length; i += 2) {
          const elifCondition = elifParts[i];
          const elifBody = elifParts[i + 1] || "";
          if (evaluateCondition(elifCondition, context)) {
            return elifBody;
          }
        }
        return elseBody;
      }

      if (evaluateCondition(condition, context)) {
        return ifBody;
      }
      return elseBody;
    });

    RE_IF_PATTERN.lastIndex = 0;
  }

  return result;
}

/**
 * Resolve all {{ expression }} references in the template.
 */
function resolveExpressions(tpl: string, context: RenderContext): string {
  return tpl.replace(/\{\{[-\s]*(.*?)[-\s]*\}\}/g, (_match, expr: string) => {
    const trimmed = expr.trim();

    // Handle filters: {{ value|filter }}
    const filterParts = trimmed.split("|");
    const path = filterParts[0].trim();

    let value = resolvePath(context, path);

    // Apply basic filters
    for (let i = 1; i < filterParts.length; i++) {
      value = applyFilter(value, filterParts[i].trim());
    }

    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    // Strip literal \n sequences that AI sometimes puts in field defaults
    let str = String(value);
    str = str.replace(/\\n/g, " ").replace(/\n/g, " ");
    return str;
  });
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
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
    default:
      // Unknown filter — pass through
      return value;
  }
}
