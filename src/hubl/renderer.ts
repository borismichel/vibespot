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
 * Everything else (require_css, get_asset_url, dnd_area, etc.) is stripped.
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
</head>
<body>
${body}
${scriptBlocks}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Strip HubSpot-specific directives that have no meaning in local preview.
 */
function stripDirectives(tpl: string): string {
  // Remove {% require_css %}, {% require_js %}, {% end_require_css %}, etc.
  tpl = tpl.replace(/\{%[-\s]*require_(css|js)\b.*?%\}/gs, "");
  tpl = tpl.replace(/\{%[-\s]*end_require_(css|js)\s*%\}/gs, "");

  // Remove {{ require_css(...) }}, {{ require_js(...) }}
  tpl = tpl.replace(/\{\{[-\s]*require_(css|js)\(.*?\)\s*\}\}/gs, "");

  // Remove {{ get_asset_url(...) }}
  tpl = tpl.replace(/\{\{[-\s]*get_asset_url\(.*?\)\s*\}\}/gs, "");

  // Remove {% dnd_area %}, {% dnd_section %}, {% dnd_column %}, {% dnd_row %} and their end tags
  tpl = tpl.replace(/\{%[-\s]*(end_)?(dnd_area|dnd_section|dnd_column|dnd_row|dnd_module)\b.*?%\}/gs, "");

  // Remove {% module ... %} tags (standalone module includes)
  tpl = tpl.replace(/\{%[-\s]*module\b.*?%\}/gs, "");

  // Remove {% extends %}, {% block %}, {% endblock %}, {% set %} — template-level
  tpl = tpl.replace(/\{%[-\s]*(extends|block|endblock|set)\b.*?%\}/gs, "");

  // Remove template annotations {# ... #}
  tpl = tpl.replace(/\{#.*?#\}/gs, "");

  // Remove {{ content.* }} page-level variables
  tpl = tpl.replace(/\{\{[-\s]*content\.\w+.*?\}\}/gs, "");

  return tpl;
}

/**
 * Process {% for VAR in PATH %}...{% endfor %} loops.
 * Supports nested loops.
 */
function processForLoops(tpl: string, context: RenderContext): string {
  // Match outermost for-loops first (non-greedy within, but handle nesting)
  const forPattern = /\{%[-\s]*for\s+(\w+)\s+in\s+([\w.]+)\s*%\}([\s\S]*?)\{%[-\s]*endfor\s*%\}/g;

  let result = tpl;
  let safety = 0;

  // Repeat until no more for-loops (handles nested)
  while (forPattern.test(result) && safety < 20) {
    safety++;
    result = result.replace(forPattern, (_match, varName: string, path: string, body: string) => {
      const items = resolvePath(context, path);

      if (!Array.isArray(items)) return "";

      return items
        .map((item, index) => {
          // Create a sub-context with the loop variable + loop helpers
          const loopContext: RenderContext = {
            ...context,
            [varName]: item,
            loop: { index: index + 1, index0: index, first: index === 0, last: index === items.length - 1, length: items.length },
          };

          // Recursively process nested for-loops & conditionals in the body
          let rendered = processForLoops(body, loopContext);
          rendered = processConditionals(rendered, loopContext);
          rendered = resolveExpressions(rendered, loopContext);
          return rendered;
        })
        .join("");
    });

    forPattern.lastIndex = 0;
  }

  return result;
}

/**
 * Process {% if EXPR %}...{% else %}...{% endif %} conditionals.
 * Supports {% elif %} as well.
 */
function processConditionals(tpl: string, context: RenderContext): string {
  // Process from innermost out
  const ifPattern = /\{%[-\s]*if\s+(.*?)\s*%\}([\s\S]*?)\{%[-\s]*endif\s*%\}/g;

  let result = tpl;
  let safety = 0;

  while (ifPattern.test(result) && safety < 50) {
    safety++;
    result = result.replace(ifPattern, (_match, condition: string, body: string) => {
      // Split on {% else %} and {% elif %}
      const elseMatch = body.split(/\{%[-\s]*else\s*%\}/);
      const ifBody = elseMatch[0];
      const elseBody = elseMatch[1] || "";

      // Check for {% elif %} (treat as nested if-else)
      const elifParts = ifBody.split(/\{%[-\s]*elif\s+(.*?)\s*%\}/);

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

    ifPattern.lastIndex = 0;
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
    return String(value);
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
