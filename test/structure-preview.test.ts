import { describe, it, expect } from "vitest";
import {
  buildStructurePreview,
  applyStructureEdits,
  kebabModuleName,
} from "../src/server/agent/structure-preview.js";
import type { PageBlueprint } from "../src/server/agent/types.js";

function makeBlueprint(): PageBlueprint {
  return {
    designSystem: { cssVariables: { "--accent": "#e8613a" }, sharedCss: ":root{}" },
    modules: [
      { name: "hero", description: "Hero with headline + CTA", contentBrief: "brief-hero", layoutNotes: "layout-hero" },
      { name: "features", description: "Three feature cards", contentBrief: "brief-feat", layoutNotes: "layout-feat" },
      { name: "footer", description: "Footer with links", contentBrief: "brief-foot", layoutNotes: "layout-foot" },
    ],
    moduleOrder: ["hero", "features", "footer"],
    narrative: "A simple landing page",
  };
}

describe("buildStructurePreview", () => {
  it("lists modules in page order, each carrying its source index and no model call", () => {
    const preview = buildStructurePreview(makeBlueprint());
    expect(preview.kind).toBe("structure");
    const mods = preview.data.modules as { name: string; description: string; sourceIndex: number }[];
    expect(mods.map((m) => m.name)).toEqual(["hero", "features", "footer"]);
    expect(mods.map((m) => m.sourceIndex)).toEqual([0, 1, 2]);
    expect(mods[0].description).toBe("Hero with headline + CTA");
  });

  it("follows moduleOrder even when it differs from the modules array order", () => {
    const bp = makeBlueprint();
    bp.moduleOrder = ["footer", "hero", "features"];
    const preview = buildStructurePreview(bp);
    const mods = preview.data.modules as { name: string; sourceIndex: number }[];
    expect(mods.map((m) => m.name)).toEqual(["footer", "hero", "features"]);
    // sourceIndex still points back to the original modules array
    expect(mods.map((m) => m.sourceIndex)).toEqual([2, 0, 1]);
  });

  it("recovers planned modules dropped from moduleOrder", () => {
    const bp = makeBlueprint();
    bp.moduleOrder = ["hero"]; // features + footer dropped
    const mods = buildStructurePreview(bp).data.modules as { name: string }[];
    expect(mods.map((m) => m.name)).toEqual(["hero", "features", "footer"]);
  });
});

describe("applyStructureEdits", () => {
  it("returns the blueprint unchanged when no outline is provided (plain approve)", () => {
    const bp = makeBlueprint();
    expect(applyStructureEdits(bp, undefined)).toBe(bp);
    expect(applyStructureEdits(bp, [])).toBe(bp);
  });

  it("honors a reorder + cut, preserving each module's brief/layout", () => {
    const bp = makeBlueprint();
    // Drop "features", swap hero/footer order.
    const edited = applyStructureEdits(bp, [
      { name: "footer", sourceIndex: 2 },
      { name: "hero", sourceIndex: 0 },
    ]);
    expect(edited.moduleOrder).toEqual(["footer", "hero"]);
    expect(edited.modules.map((m) => m.name)).toEqual(["footer", "hero"]);
    // Original briefs preserved across reorder.
    expect(edited.modules[0].contentBrief).toBe("brief-foot");
    expect(edited.modules[1].layoutNotes).toBe("layout-hero");
  });

  it("honors a rename while keeping the original brief", () => {
    const bp = makeBlueprint();
    const edited = applyStructureEdits(bp, [
      { name: "Hero Banner", sourceIndex: 0 },
      { name: "features", sourceIndex: 1 },
      { name: "footer", sourceIndex: 2 },
    ]);
    // Renamed + kebab-cased.
    expect(edited.modules[0].name).toBe("hero-banner");
    expect(edited.moduleOrder[0]).toBe("hero-banner");
    // Brief/layout carried over from the source module.
    expect(edited.modules[0].contentBrief).toBe("brief-hero");
    expect(edited.modules[0].layoutNotes).toBe("layout-hero");
  });

  it("seeds a generic brief for user-added sections (no sourceIndex)", () => {
    const bp = makeBlueprint();
    const edited = applyStructureEdits(bp, [
      { name: "hero", sourceIndex: 0 },
      { name: "Pricing Table", description: "Three tiers" },
    ]);
    const added = edited.modules.find((m) => m.name === "pricing-table");
    expect(added).toBeDefined();
    expect(added!.description).toBe("Three tiers");
    expect(added!.contentBrief).toContain("Generate appropriate content");
    expect(edited.moduleOrder).toEqual(["hero", "pricing-table"]);
  });

  it("de-dupes colliding names and ignores a fully-empty outline", () => {
    const bp = makeBlueprint();
    const edited = applyStructureEdits(bp, [
      { name: "hero", sourceIndex: 0 },
      { name: "hero", sourceIndex: 1 }, // collides → dropped
    ]);
    expect(edited.modules.map((m) => m.name)).toEqual(["hero"]);

    // An outline that sanitizes to nothing must not wipe the build.
    const safe = applyStructureEdits(bp, [{ name: "!!!" }]);
    expect(safe).toBe(bp);
  });
});

describe("kebabModuleName", () => {
  it("coerces free text to kebab-case module identifiers", () => {
    expect(kebabModuleName("Hero Banner")).toBe("hero-banner");
    expect(kebabModuleName("  CTA / Footer!  ")).toBe("cta-footer");
    expect(kebabModuleName('"quoted"')).toBe("quoted");
    expect(kebabModuleName("!!!")).toBe("");
  });
});
