import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import {
  enrichImportedThemeBrandAssets,
  missingBrandAssets,
} from "../src/server/brand-enrichment.js";
import type { VibeSession } from "../src/server/session/types.js";

let themePath = "";

afterEach(() => {
  if (themePath) rmSync(themePath, { recursive: true, force: true });
  themePath = "";
});

function makeSession(overrides: Partial<VibeSession> = {}): VibeSession {
  themePath = mkdtempSync(join(tmpdir(), "vibespot-brand-enrichment-"));
  return {
    id: "session-1",
    themePath,
    themeName: "imported",
    templates: [],
    activeTemplateId: "",
    messages: [],
    modules: [],
    sharedCss: "",
    sharedJs: "",
    template: "",
    moduleOrder: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("brand enrichment", () => {
  it("detects only missing brand assets", () => {
    const session = makeSession({
      brandAssets: {
        styleguide: "# Style",
        themeContext: "# Context",
      },
    });

    expect(missingBrandAssets(session)).toEqual(["brandvoice"]);
  });

  it("extracts and persists missing imported-theme brand assets", async () => {
    const session = makeSession({
      brandAssets: {
        styleguide: "# Existing styleguide",
      },
    });

    const result = await enrichImportedThemeBrandAssets(session, {
      extractStyleguide: async () => {
        throw new Error("styleguide should not be re-extracted");
      },
      buildPreviewHtml: () => "<main><h1>Acme Analytics</h1><p>Make revenue teams faster.</p></main>",
      extractBrandvoice: async () => "# Brand Voice\nDirect and practical.",
      extractThemeContext: async () => "# Product / Company\nAcme Analytics.",
    });

    expect(result.attempted).toEqual(["brandvoice", "themeContext"]);
    expect(result.extracted).toEqual(["brandvoice", "themeContext"]);
    expect(result.errors).toEqual([]);
    expect(session.brandAssets?.styleguide).toBe("# Existing styleguide");
    expect(session.brandAssets?.brandvoice).toContain("Direct");
    expect(session.brandAssets?.themeContext).toContain("Acme");
    expect(readFileSync(join(themePath, ".vibespot", "brandvoice.md"), "utf-8")).toContain("Direct");
    expect(readFileSync(join(themePath, ".vibespot", "theme-context.md"), "utf-8")).toContain("Acme");
  });

  it("keeps imports successful when one AI enrichment step fails", async () => {
    const session = makeSession();

    const result = await enrichImportedThemeBrandAssets(session, {
      extractStyleguide: async () => {
        throw new Error("API key not configured");
      },
      buildPreviewHtml: () => "<main><h1>Imported theme</h1><p>Enough content for copy extraction.</p></main>",
      extractBrandvoice: async () => "# Brand Voice\nCalm.",
      extractThemeContext: async () => null,
    });

    expect(result.extracted).toEqual(["brandvoice"]);
    expect(result.skipped).toEqual(["styleguide", "themeContext"]);
    expect(result.errors).toEqual([{ asset: "styleguide", message: "API key not configured" }]);
    expect(session.brandAssets?.brandvoice).toContain("Calm");
  });
});
