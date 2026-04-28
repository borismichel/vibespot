import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateMarketplace,
  applyMarketplaceAutoFixes,
} from "../src/server/marketplace.js";

let theme: string;

const FULL_THEME_JSON = {
  label: "My Theme",
  preview_path: "./templates/home.html",
  screenshot_path: "./images/screenshot.png",
  version: "1.0.0",
  documentation_url: "https://example.com/docs",
  license: "MIT",
  example_url: "https://example.com/preview",
  enable_domain_stylesheets: true,
  is_available_for_new_content: true,
  author: { name: "Acme", email: "hi@acme.com", url: "https://acme.com" },
};

function writeJson(file: string, data: unknown): void {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function bootstrapMinimalTheme(themeJson: Record<string, unknown> = FULL_THEME_JSON): void {
  writeJson(join(theme, "theme.json"), themeJson);
  mkdirSync(join(theme, "templates"), { recursive: true });
  writeFileSync(join(theme, "templates", "home.html"), "<html></html>", "utf8");
  mkdirSync(join(theme, "images"), { recursive: true });
  writeFileSync(join(theme, "images", "screenshot.png"), "PNG_BYTES", "utf8");
  mkdirSync(join(theme, "modules", "hero.module"), { recursive: true });
  writeFileSync(
    join(theme, "modules", "hero.module", "module.html"),
    "<section><h1>Hi</h1></section>",
    "utf8",
  );
  writeJson(join(theme, "modules", "hero.module", "meta.json"), { label: "Hero" });
  writeJson(join(theme, "modules", "hero.module", "fields.json"), [
    { type: "text", name: "headline", label: "Headline", help_text: "Main heading." },
  ]);
}

beforeEach(() => {
  theme = mkdtempSync(join(tmpdir(), "vibespot-mkt-"));
});

afterEach(() => {
  rmSync(theme, { recursive: true, force: true });
});

describe("validateMarketplace — theme.json required fields", () => {
  it("passes when every HubSpot-required theme.json field is present", () => {
    bootstrapMinimalTheme();
    const report = validateMarketplace(theme);
    expect(report.errorCount).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("flags missing documentation_url, license, example_url as errors", () => {
    const incomplete: Record<string, unknown> = { ...FULL_THEME_JSON };
    delete incomplete.documentation_url;
    delete incomplete.license;
    delete incomplete.example_url;
    bootstrapMinimalTheme(incomplete);

    const report = validateMarketplace(theme);
    const rules = report.findings.map((f) => f.rule);
    expect(rules).toContain("theme.json.documentation_url.missing");
    expect(rules).toContain("theme.json.license.missing");
    expect(rules).toContain("theme.json.example_url.missing");
    for (const rule of [
      "theme.json.documentation_url.missing",
      "theme.json.license.missing",
      "theme.json.example_url.missing",
    ]) {
      expect(report.findings.find((f) => f.rule === rule)?.severity).toBe("error");
    }
  });

  it("flags missing boolean fields (enable_domain_stylesheets, is_available_for_new_content) as errors", () => {
    const incomplete: Record<string, unknown> = { ...FULL_THEME_JSON };
    delete incomplete.enable_domain_stylesheets;
    delete incomplete.is_available_for_new_content;
    bootstrapMinimalTheme(incomplete);

    const report = validateMarketplace(theme);
    const rules = report.findings
      .filter((f) => f.severity === "error")
      .map((f) => f.rule);
    expect(rules).toContain("theme.json.enable_domain_stylesheets.missing");
    expect(rules).toContain("theme.json.is_available_for_new_content.missing");
  });

  it("flags author.email as required (was previously not checked)", () => {
    const incomplete: Record<string, unknown> = { ...FULL_THEME_JSON, author: { name: "Acme", url: "https://acme.com" } };
    bootstrapMinimalTheme(incomplete);

    const report = validateMarketplace(theme);
    const finding = report.findings.find((f) => f.rule === "theme.json.author.email.missing");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("error");
  });

  it("does not produce a green light for the previous minimal field set", () => {
    // Reproduces the reviewer's repro case: only the four old required fields.
    bootstrapMinimalTheme({
      label: "X",
      preview_path: "./templates/home.html",
      screenshot_path: "./images/screenshot.png",
      version: "1.0.0",
    });
    const report = validateMarketplace(theme);
    expect(report.passed).toBe(false);
    expect(report.errorCount).toBeGreaterThan(0);
  });
});

describe("applyMarketplaceAutoFixes — CDN imports", () => {
  it("strips CDN @import from shared CSS files", () => {
    bootstrapMinimalTheme();
    mkdirSync(join(theme, "css"), { recursive: true });
    const sharedCss = join(theme, "css", "shared.css");
    writeFileSync(
      sharedCss,
      "@import url('https://cdn.example.com/foo.css');\nbody { color: red; }",
      "utf8",
    );

    // Pre-condition: the validator surfaces the CDN finding as auto-fixable.
    const before = validateMarketplace(theme);
    const cdnBefore = before.findings.find((f) => f.rule === "asset.cdn-import");
    expect(cdnBefore).toBeDefined();
    expect(cdnBefore!.autoFixable).toBe(true);

    // Apply fixes — should report the file and remove the @import.
    const result = applyMarketplaceAutoFixes(theme);
    expect(result.applied.some((line) => line.includes("css/shared.css"))).toBe(true);
    expect(readFileSync(sharedCss, "utf8")).not.toContain("cdn.example.com");

    // Post-condition: validator no longer flags the CDN finding.
    const after = validateMarketplace(theme);
    expect(after.findings.find((f) => f.rule === "asset.cdn-import")).toBeUndefined();
  });

  it("strips CDN @import from module CSS files", () => {
    bootstrapMinimalTheme();
    const moduleCss = join(theme, "modules", "hero.module", "module.css");
    writeFileSync(
      moduleCss,
      "@import url(https://fonts.googleapis.com/css?family=Inter);\n.hero { padding: 20px; }",
      "utf8",
    );

    const result = applyMarketplaceAutoFixes(theme);
    expect(
      result.applied.some((line) => line.includes("modules/hero.module/module.css")),
    ).toBe(true);
    expect(readFileSync(moduleCss, "utf8")).not.toContain("fonts.googleapis.com");
  });

  it("strips external <link> and <script> tags from module HTML", () => {
    bootstrapMinimalTheme();
    const moduleHtml = join(theme, "modules", "hero.module", "module.html");
    writeFileSync(
      moduleHtml,
      `<section><link rel="stylesheet" href="https://cdn.example.com/x.css"><script src="https://cdn.example.com/x.js"></script><h1>Hi</h1></section>`,
      "utf8",
    );

    const result = applyMarketplaceAutoFixes(theme);
    expect(
      result.applied.some((line) => line.includes("modules/hero.module/module.html")),
    ).toBe(true);
    const after = readFileSync(moduleHtml, "utf8");
    expect(after).not.toContain("cdn.example.com");
  });
});

describe("validateMarketplace — listing feature counts", () => {
  it("warns when fewer than 2 features", () => {
    bootstrapMinimalTheme();
    writeJson(join(theme, "marketplace.json"), {
      category: "SaaS & Technology",
      description: "A clean SaaS landing page theme that converts visitors.",
      features: ["Just one"],
      supportUrl: "https://example.com/support",
    });

    const report = validateMarketplace(theme);
    const finding = report.findings.find((f) => f.rule === "marketplace.json.features.too_few");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("warns when more than 5 features", () => {
    bootstrapMinimalTheme();
    writeJson(join(theme, "marketplace.json"), {
      category: "SaaS & Technology",
      description: "A clean SaaS landing page theme that converts visitors.",
      features: ["A", "B", "C", "D", "E", "F"],
      supportUrl: "https://example.com/support",
    });

    const report = validateMarketplace(theme);
    const finding = report.findings.find((f) => f.rule === "marketplace.json.features.too_many");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warning");
  });

  it("accepts feature counts in the 2-5 range", () => {
    bootstrapMinimalTheme();
    writeJson(join(theme, "marketplace.json"), {
      category: "SaaS & Technology",
      description: "A clean SaaS landing page theme that converts visitors.",
      features: ["Hero", "Pricing", "Footer"],
      supportUrl: "https://example.com/support",
    });

    const report = validateMarketplace(theme);
    expect(report.findings.find((f) => f.rule === "marketplace.json.features.too_few")).toBeUndefined();
    expect(report.findings.find((f) => f.rule === "marketplace.json.features.too_many")).toBeUndefined();
  });
});
