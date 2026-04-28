import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeTheme,
  extractDesignTokens,
  buildRootCssFromTokens,
  applyTokensToSharedCss,
  buildModuleGraph,
  collectFieldFlags,
  collectRoundTripRisks,
} from "../src/server/inverse-analyzer.js";

let theme: string;

function writeJson(file: string, data: unknown): void {
  mkdirSync(file.substring(0, file.lastIndexOf("/")), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function writeText(file: string, content: string): void {
  mkdirSync(file.substring(0, file.lastIndexOf("/")), { recursive: true });
  writeFileSync(file, content, "utf8");
}

beforeEach(() => {
  theme = mkdtempSync(join(tmpdir(), "vibespot-inverse-"));
});

afterEach(() => {
  rmSync(theme, { recursive: true, force: true });
});

describe("extractDesignTokens", () => {
  it("extracts :root custom properties from shared CSS", () => {
    writeText(
      join(theme, "css", "site-theme.css"),
      `:root {\n  --color-primary: #112233;\n  --font-family-base: "Inter", sans-serif;\n  --space-md: 1.25rem;\n}\n.hero { color: var(--color-primary); }`,
    );
    const tokens = extractDesignTokens(theme);
    expect(tokens.cssVariables["--color-primary"]).toBe("#112233");
    expect(tokens.cssVariables["--font-family-base"]).toContain("Inter");
    expect(tokens.cssVariables["--space-md"]).toBe("1.25rem");
  });

  it("infers a colour palette ranked by frequency from theme + module CSS", () => {
    writeText(
      join(theme, "css", "site-theme.css"),
      `.a { color: #0066ff; } .b { color: #0066ff; } .c { background: #ff8800; }`,
    );
    writeText(
      join(theme, "modules", "hero.module", "module.css"),
      `.hero { color: #0066ff; }`,
    );
    const tokens = extractDesignTokens(theme);
    expect(tokens.palette.length).toBeGreaterThan(0);
    expect(tokens.palette[0].value).toBe("#0066ff");
    expect(tokens.palette[0].count).toBeGreaterThanOrEqual(3);
  });

  it("excludes utility colours like black and white from the palette", () => {
    writeText(
      join(theme, "css", "site.css"),
      `.a { color: #fff; background: #000; } .b { color: #112233; }`,
    );
    const tokens = extractDesignTokens(theme);
    const values = tokens.palette.map((c) => c.value);
    expect(values).not.toContain("#ffffff");
    expect(values).not.toContain("#000000");
    expect(values).toContain("#112233");
  });

  it("expands 3-digit hex to 6-digit so #fff and #ffffff dedupe", () => {
    writeText(
      join(theme, "css", "site.css"),
      `.a { color: #abc; } .b { color: #aabbcc; }`,
    );
    const tokens = extractDesignTokens(theme);
    const aabbcc = tokens.palette.find((c) => c.value === "#aabbcc");
    expect(aabbcc).toBeDefined();
    expect(aabbcc!.count).toBe(2);
  });

  it("captures font families from declarations", () => {
    writeText(
      join(theme, "css", "site.css"),
      `body { font-family: "Inter", sans-serif; }\nh1 { font-family: 'Playfair Display', serif; }`,
    );
    const tokens = extractDesignTokens(theme);
    expect(tokens.fontFamilies).toContain("Inter");
    expect(tokens.fontFamilies).toContain("Playfair Display");
  });
});

describe("buildRootCssFromTokens", () => {
  it("returns the existing :root variables when present", () => {
    const root = buildRootCssFromTokens({
      cssVariables: { "--color-primary": "#112233", "--space-md": "1rem" },
      palette: [],
      fontFamilies: [],
      fontSizes: [],
      spacing: [],
      radii: [],
      shadows: [],
    });
    expect(root).toContain("--color-primary: #112233");
    expect(root).toContain("--space-md: 1rem");
  });

  it("synthesises tokens from the palette when no :root exists", () => {
    const root = buildRootCssFromTokens({
      cssVariables: {},
      palette: [
        { value: "#0066ff", count: 5 },
        { value: "#ff8800", count: 3 },
        { value: "#22aa44", count: 1 },
      ],
      fontFamilies: ["Inter", "Playfair Display"],
      fontSizes: [],
      spacing: [],
      radii: [],
      shadows: [],
    });
    expect(root).toContain("--color-primary: #0066ff");
    expect(root).toContain("--color-secondary: #ff8800");
    expect(root).toContain("--font-family-base: Inter");
    expect(root).toContain("--font-family-heading: Playfair Display");
  });

  it("returns an empty string when there is nothing to emit", () => {
    const root = buildRootCssFromTokens({
      cssVariables: {},
      palette: [],
      fontFamilies: [],
      fontSizes: [],
      spacing: [],
      radii: [],
      shadows: [],
    });
    expect(root).toBe("");
  });
});

describe("applyTokensToSharedCss", () => {
  it("writes a :root block when no shared theme CSS exists", () => {
    writeText(
      join(theme, "modules", "hero.module", "module.css"),
      `.hero { color: #0066ff; background: #112233; }`,
    );
    const target = applyTokensToSharedCss(theme, "imported");
    expect(target).not.toBeNull();
    expect(existsSync(target!)).toBe(true);
    const written = readFileSync(target!, "utf8");
    expect(written).toContain(":root");
    expect(written).toContain("#0066ff");
  });

  it("skips when shared theme CSS already exists", () => {
    writeText(join(theme, "css", "imported-theme.css"), `:root { --color-primary: #fff; }`);
    writeText(join(theme, "modules", "hero.module", "module.css"), `.hero { color: #0066ff; }`);
    const target = applyTokensToSharedCss(theme, "imported");
    expect(target).toBeNull();
  });
});

describe("buildModuleGraph", () => {
  it("maps modules to templates and surfaces orphans", () => {
    mkdirSync(join(theme, "modules", "hero.module"), { recursive: true });
    mkdirSync(join(theme, "modules", "footer.module"), { recursive: true });
    mkdirSync(join(theme, "modules", "orphan-card.module"), { recursive: true });
    writeText(
      join(theme, "templates", "lp-main.html"),
      `<!-- label: "Main" -->\n{% dnd_module path="../modules/hero.module" %}{% end_dnd_module %}\n{% dnd_module path="../modules/footer.module" %}{% end_dnd_module %}`,
    );
    const graph = buildModuleGraph(theme);
    expect(graph.templates.length).toBe(1);
    expect(graph.templates[0].modules).toEqual(["hero", "footer"]);
    expect(graph.modules.find((m) => m.name === "hero")?.templates).toEqual(["lp-main.html"]);
    expect(graph.orphanModules).toEqual(["orphan-card"]);
  });

  it("flags modules that ship custom JS", () => {
    mkdirSync(join(theme, "modules", "carousel.module"), { recursive: true });
    writeText(join(theme, "modules", "carousel.module", "module.js"), `console.log('carousel');`);
    const graph = buildModuleGraph(theme);
    const carousel = graph.modules.find((m) => m.name === "carousel");
    expect(carousel?.hasJs).toBe(true);
  });
});

describe("collectFieldFlags", () => {
  it("flags HubDB fields and unknown field types", () => {
    writeJson(join(theme, "modules", "table.module", "fields.json"), [
      { type: "hubdb_table", name: "table", label: "Table" },
      { type: "weird_widget", name: "weird", label: "Weird" },
      { type: "text", name: "title", label: "Title" },
    ]);
    const flags = collectFieldFlags(theme);
    const reasons = flags.map((f) => f.reason);
    expect(reasons.some((r) => r.includes("HubDB"))).toBe(true);
    expect(reasons.some((r) => r.includes("weird_widget"))).toBe(true);
    // Plain text field should not be flagged
    expect(flags.find((f) => f.field === "title")).toBeUndefined();
  });

  it("flags repeater (occurrence) fields", () => {
    writeJson(join(theme, "modules", "list.module", "fields.json"), [
      { type: "group", name: "items", label: "Items", occurrence: { min: 1, max: null }, children: [] },
    ]);
    const flags = collectFieldFlags(theme);
    expect(flags.some((f) => f.reason.includes("repeater"))).toBe(true);
  });

  it("flags deeply nested groups but not single-level groups", () => {
    writeJson(join(theme, "modules", "nest.module", "fields.json"), [
      {
        type: "group",
        name: "outer",
        label: "Outer",
        children: [
          { type: "group", name: "inner", label: "Inner", children: [] },
        ],
      },
    ]);
    const flags = collectFieldFlags(theme);
    expect(flags.some((f) => f.field === "inner" && f.reason.includes("nested group"))).toBe(true);
    expect(flags.some((f) => f.field === "outer" && f.reason.includes("nested group"))).toBe(false);
  });
});

describe("collectRoundTripRisks", () => {
  it("flags modules with custom JS and templates with custom macros", () => {
    writeText(
      join(theme, "modules", "fancy.module", "module.html"),
      `{% macro card(x) %}<div>{{ x }}</div>{% endmacro %}\n<section>{{ card("hi") }}</section>`,
    );
    writeText(join(theme, "modules", "fancy.module", "module.js"), `// custom`);
    const risks = collectRoundTripRisks(theme);
    expect(risks.some((r) => r.pattern === "hubl.macro")).toBe(true);
    expect(risks.some((r) => r.pattern === "module.js.custom")).toBe(true);
  });

  it("flags include of a partial outside modules/", () => {
    writeText(
      join(theme, "templates", "lp-main.html"),
      `{% include "./partials/header.html" %}`,
    );
    const risks = collectRoundTripRisks(theme);
    expect(risks.some((r) => r.pattern === "hubl.include")).toBe(true);
  });
});

describe("analyzeTheme — end to end", () => {
  it("returns a structured report with summary counts", () => {
    mkdirSync(join(theme, "modules", "hero.module"), { recursive: true });
    writeText(join(theme, "modules", "hero.module", "module.html"), `<section><h1>Hi</h1></section>`);
    writeJson(join(theme, "modules", "hero.module", "fields.json"), [
      { type: "text", name: "headline", label: "Headline" },
    ]);
    writeText(
      join(theme, "templates", "lp-main.html"),
      `{% dnd_module path="../modules/hero.module" %}{% end_dnd_module %}`,
    );
    writeText(join(theme, "css", "site-theme.css"), `:root { --color-primary: #112233; }\n.hero { color: #0066ff; }`);

    const report = analyzeTheme(theme);
    expect(report.summary.moduleCount).toBe(1);
    expect(report.summary.templateCount).toBe(1);
    expect(report.summary.cssVarCount).toBe(1);
    expect(report.summary.paletteSize).toBeGreaterThan(0);
    expect(report.graph.orphanModules).toEqual([]);
  });

  it("returns an error finding when the theme path does not exist", () => {
    const missing = join(theme, "does-not-exist");
    const report = analyzeTheme(missing);
    expect(report.findings.find((f) => f.rule === "theme.path.missing")).toBeDefined();
  });
});
