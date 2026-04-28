/**
 * Plan-mode templates — pre-canned plan structures for common page types.
 *
 * Each template is a markdown file in `assets/plan-templates/` with a small
 * YAML frontmatter block (id, label, description, icon, order) followed by a
 * markdown body that becomes the seed `vibespot-plan` document.
 *
 * Selecting a template skips the cold-start "what are you trying to build"
 * elicitation in plan mode — the AI inherits the structure and only asks
 * page-type-specific questions from the **Open questions** section.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface PlanTemplateMetadata {
  id: string;
  label: string;
  description: string;
  icon?: string;
  order: number;
}

export interface PlanTemplate extends PlanTemplateMetadata {
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } | null {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return null;
  const [, frontmatter, body] = match;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }
  return { fields, body: body.trimStart() };
}

/**
 * Parse a single template from raw markdown source. Exported for testing.
 * Returns null if the frontmatter is missing or required fields are absent.
 */
export function parsePlanTemplate(raw: string): PlanTemplate | null {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  const { fields, body } = parsed;
  const id = fields.id;
  const label = fields.label;
  const description = fields.description ?? "";
  if (!id || !label) return null;
  const orderRaw = fields.order ? Number(fields.order) : NaN;
  return {
    id,
    label,
    description,
    icon: fields.icon || undefined,
    order: Number.isFinite(orderRaw) ? orderRaw : 9999,
    body: body.trimEnd() + "\n",
  };
}

let _cache: PlanTemplate[] | null = null;

function templatesDir(): string | null {
  // Mirror resolveAsset()'s search order. Templates are optional — return
  // null if no directory exists rather than throwing, so the rest of the
  // app keeps working.
  const candidates = [
    join(import.meta.dirname, "../../assets/plan-templates"),
    join(import.meta.dirname, "../assets/plan-templates"),
    join(process.cwd(), "assets/plan-templates"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Load all plan-mode templates, sorted by `order` then by label.
 * Cached after the first call; in a long-running process the cache is
 * acceptable because templates ship with the package.
 */
export function listPlanTemplates(): PlanTemplate[] {
  if (_cache) return _cache;

  const dir = templatesDir();
  if (!dir) {
    _cache = [];
    return _cache;
  }

  const out: PlanTemplate[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    _cache = [];
    return _cache;
  }

  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    try {
      const raw = readFileSync(join(dir, name), "utf-8");
      const tpl = parsePlanTemplate(raw);
      if (tpl) out.push(tpl);
    } catch {
      // Skip unreadable / malformed templates rather than crashing the server.
    }
  }

  out.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.label.localeCompare(b.label);
  });

  _cache = out;
  return _cache;
}

export function getPlanTemplate(id: string): PlanTemplate | null {
  return listPlanTemplates().find((t) => t.id === id) ?? null;
}

/**
 * Strip the cache. Used by tests so that template-directory mocking takes
 * effect across runs in the same Node process.
 */
export function _resetPlanTemplatesCache(): void {
  _cache = null;
}

/**
 * Public metadata-only listing for the API.
 */
export function listPlanTemplateMetadata(): PlanTemplateMetadata[] {
  return listPlanTemplates().map(({ id, label, description, icon, order }) => ({
    id,
    label,
    description,
    icon,
    order,
  }));
}
