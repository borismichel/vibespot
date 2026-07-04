/**
 * Structure-checkpoint preview + edit application (VIB-1879).
 *
 * The structure gate sits after the module planner (Stage 2b) and before the
 * expensive parallel build (Stage 3). It shows the planned module skeleton as an
 * editable outline — reorder, cut, add, rename — straight from the blueprint,
 * with NO model call. `buildStructurePreview` produces the card payload;
 * `applyStructureEdits` folds the user's edited outline back into the blueprint
 * so Stage 3 builds exactly what the user approved.
 */

import type {
  CheckpointPreview,
  PageBlueprint,
  StructureOutlineItem,
} from "./types.js";
import { kebabModuleName } from "../../utils/path-safety.js";

export interface StructureOutlineEntry {
  name: string;
  description: string;
  /** Index into `blueprint.modules` this row maps to (for rename/reorder). */
  sourceIndex: number;
}

export interface StructurePreviewData {
  narrative: string;
  modules: StructureOutlineEntry[];
}

// Canonical implementation lives in utils/path-safety.ts (VIB-1891) — it is
// both the naming convention and a security boundary (module names become
// path components). Re-exported here for existing importers.
export { kebabModuleName };

/**
 * Build the structure-checkpoint card payload from the blueprint. Modules are
 * listed in the planned page order so the outline reads top-to-bottom like the
 * page will render. Each entry carries its index in `blueprint.modules` so edits
 * can recover the original brief on resume.
 */
export function buildStructurePreview(blueprint: PageBlueprint): CheckpointPreview {
  const byName = new Map<string, number>();
  blueprint.modules.forEach((m, i) => {
    if (!byName.has(m.name)) byName.set(m.name, i);
  });

  const entries: StructureOutlineEntry[] = [];
  const used = new Set<number>();

  // Follow moduleOrder first so the outline matches the rendered page.
  for (const name of blueprint.moduleOrder || []) {
    const idx = byName.get(name);
    if (idx == null || used.has(idx)) continue;
    used.add(idx);
    const m = blueprint.modules[idx];
    entries.push({ name: m.name, description: m.description || "", sourceIndex: idx });
  }
  // Append any planned modules the order dropped (defensive — mirrors the
  // reconciliation in buildModuleOrder).
  blueprint.modules.forEach((m, idx) => {
    if (used.has(idx)) return;
    entries.push({ name: m.name, description: m.description || "", sourceIndex: idx });
  });

  const data: StructurePreviewData = {
    narrative: blueprint.narrative || "",
    modules: entries,
  };

  return {
    kind: "structure",
    headline: "Here's the structure — reorder, cut, or add sections before I build",
    data: data as unknown as Record<string, unknown>,
  };
}

/**
 * Fold a user-edited outline back into the blueprint. Each outline item keeps
 * the original module's brief/layout when it maps to one (`sourceIndex`), so a
 * pure reorder or rename costs nothing in build quality; hand-added rows get a
 * sensible default brief. Returns the blueprint unchanged when no outline was
 * provided (plain approve). `moduleOrder` is rebuilt from the final order.
 */
export function applyStructureEdits(
  blueprint: PageBlueprint,
  outline: StructureOutlineItem[] | undefined,
): PageBlueprint {
  if (!outline || outline.length === 0) return blueprint;

  const modules: PageBlueprint["modules"] = [];
  const seen = new Set<string>();

  for (const item of outline) {
    const src =
      item.sourceIndex != null ? blueprint.modules[item.sourceIndex] : undefined;
    // A planned module keeps its name on an empty rename; a hand-added row whose
    // name sanitizes to nothing is an incomplete add — drop it rather than
    // inventing a placeholder.
    const name = kebabModuleName(item.name) || src?.name;
    if (!name) continue;
    if (seen.has(name)) continue; // de-dupe — Stage 3 keys modules by name
    seen.add(name);

    if (src) {
      modules.push({
        name,
        description: item.description ?? src.description,
        contentBrief: src.contentBrief,
        layoutNotes: src.layoutNotes,
      });
    } else {
      // User-added section — no planned brief, so seed a generic one.
      modules.push({
        name,
        description: item.description || `User-added section: ${name}`,
        contentBrief: "Generate appropriate content based on the user request",
        layoutNotes: "Use a responsive layout matching the existing design system",
      });
    }
  }

  // Guard against an empty/garbage outline wiping the build.
  if (modules.length === 0) return blueprint;

  return {
    ...blueprint,
    modules,
    moduleOrder: modules.map((m) => m.name),
  };
}
