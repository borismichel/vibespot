import { describe, it, expect, vi } from "vitest";
import { validateModules, type ValidationResult } from "../src/server/agent/stages/validator.js";
import type { ModuleFiles } from "../src/ai/engine.js";
import type { PipelineEvent } from "../src/server/agent/types.js";

function makeModule(overrides: Partial<ModuleFiles> = {}): ModuleFiles {
  return {
    moduleName: "test-module",
    fieldsJson: JSON.stringify([
      { name: "headline", type: "text", default: "Hello" },
    ]),
    metaJson: JSON.stringify({
      host_template_types: ["PAGE"],
      is_available_for_new_content: true,
    }),
    moduleHtml: "<h1>{{ module.headline }}</h1>",
    moduleCss: ".test-module-hero { color: red; }",
    ...overrides,
  };
}

function run(modules: ModuleFiles[], themeName = "mytheme"): ValidationResult[] {
  const events: PipelineEvent[] = [];
  return validateModules(modules, themeName, (e) => events.push(e));
}

// ---------------------------------------------------------------------------
// JSON validation
// ---------------------------------------------------------------------------

describe("validator — JSON checks", () => {
  it("passes valid modules without issues", () => {
    const results = run([makeModule()]);
    expect(results).toHaveLength(1);
    expect(results[0].issues).toHaveLength(0);
    expect(results[0].valid).toBe(true);
  });

  it("flags invalid fieldsJson", () => {
    const results = run([makeModule({ fieldsJson: "{broken" })]);
    const jsonIssue = results[0].issues.find(
      (i) => i.field === "fieldsJson" && i.message.includes("Invalid JSON"),
    );
    expect(jsonIssue).toBeDefined();
    expect(jsonIssue!.autoFixed).toBe(false);
  });

  it("auto-generates metaJson when empty", () => {
    const results = run([makeModule({ metaJson: "" })]);
    const meta = results[0].module.metaJson;
    const parsed = JSON.parse(meta);
    expect(parsed.host_template_types).toEqual(["PAGE"]);
    expect(parsed.is_available_for_new_content).toBe(true);
    const issue = results[0].issues.find((i) => i.field === "metaJson");
    expect(issue?.autoFixed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reserved field names
// ---------------------------------------------------------------------------

describe("validator — reserved field names", () => {
  it('renames "name": "name" → "item_name"', () => {
    const fields = JSON.stringify([{ name: "name", type: "text", default: "" }]);
    const results = run([makeModule({ fieldsJson: fields })]);
    expect(results[0].module.fieldsJson).toContain('"item_name"');
    expect(results[0].module.fieldsJson).not.toMatch(/"name"\s*:\s*"name"/);
    expect(results[0].issues.some((i) => i.message.includes("item_name"))).toBe(true);
  });

  it('renames "name": "label" → "section_label"', () => {
    const fields = JSON.stringify([{ name: "label", type: "text", default: "" }]);
    const results = run([makeModule({ fieldsJson: fields })]);
    expect(results[0].module.fieldsJson).toContain('"section_label"');
  });
});

// ---------------------------------------------------------------------------
// Deprecated field types
// ---------------------------------------------------------------------------

describe("validator — deprecated field types", () => {
  it('fixes "textarea" → "text"', () => {
    const fields = JSON.stringify([
      { name: "description", type: "textarea", default: "" },
    ]);
    const results = run([makeModule({ fieldsJson: fields })]);
    expect(results[0].module.fieldsJson).toContain('"type": "text"');
    expect(results[0].module.fieldsJson).not.toContain('"textarea"');
  });
});

// ---------------------------------------------------------------------------
// CDN import stripping
// ---------------------------------------------------------------------------

describe("validator — CDN imports", () => {
  it("strips Google Fonts @import", () => {
    const css =
      '@import url(https://fonts.googleapis.com/css2?family=Inter);\n.hero { color: red; }';
    const results = run([makeModule({ moduleCss: css })]);
    expect(results[0].module.moduleCss).not.toContain("googleapis");
    expect(results[0].module.moduleCss).toContain(".hero { color: red; }");
  });

  it("strips cdnjs/unpkg/jsdelivr imports", () => {
    const css = '@import url(https://cdnjs.cloudflare.com/ajax/libs/foo.css);';
    const results = run([makeModule({ moduleCss: css })]);
    expect(results[0].module.moduleCss).not.toContain("cdnjs");
  });
});

// ---------------------------------------------------------------------------
// HubL syntax fixes
// ---------------------------------------------------------------------------

describe("validator — HubL syntax", () => {
  it("removes orphan closing tags", () => {
    const html = "<div>{% endif %}</div>";
    const results = run([makeModule({ moduleHtml: html })]);
    expect(results[0].module.moduleHtml).toContain("removed orphan");
    expect(results[0].module.moduleHtml).not.toContain("<div>{% endif %}</div>");
  });

  it("appends missing closing tags", () => {
    const html = "{% if module.show %}<div>content</div>";
    const results = run([makeModule({ moduleHtml: html })]);
    expect(results[0].module.moduleHtml).toContain("{% endif %}");
  });

  it("handles multiple unmatched openers", () => {
    const html = "{% if module.a %}{% for item in module.items %}<li>{{ item }}</li>";
    const results = run([makeModule({ moduleHtml: html })]);
    expect(results[0].module.moduleHtml).toContain("{% endfor %}");
    expect(results[0].module.moduleHtml).toContain("{% endif %}");
  });

  it("replaces now() with local_dt", () => {
    const html = "<span>{{ now() }}</span>";
    const results = run([makeModule({ moduleHtml: html })]);
    expect(results[0].module.moduleHtml).toContain("local_dt");
    expect(results[0].module.moduleHtml).not.toContain("now()");
  });
});

// ---------------------------------------------------------------------------
// metaJson required fields
// ---------------------------------------------------------------------------

describe("validator — metaJson required fields", () => {
  it("adds host_template_types if missing", () => {
    const meta = JSON.stringify({ is_available_for_new_content: true });
    const results = run([makeModule({ metaJson: meta })]);
    const parsed = JSON.parse(results[0].module.metaJson);
    expect(parsed.host_template_types).toEqual(["PAGE"]);
  });

  it("adds is_available_for_new_content if missing", () => {
    const meta = JSON.stringify({ host_template_types: ["PAGE"] });
    const results = run([makeModule({ metaJson: meta })]);
    const parsed = JSON.parse(results[0].module.metaJson);
    expect(parsed.is_available_for_new_content).toBe(true);
  });

  it("leaves complete metaJson unchanged", () => {
    const meta = JSON.stringify({
      host_template_types: ["PAGE"],
      is_available_for_new_content: true,
    });
    const results = run([makeModule({ metaJson: meta })]);
    expect(results[0].issues.filter((i) => i.field === "metaJson")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CSS prefix auto-fix
// ---------------------------------------------------------------------------

describe("validator — CSS prefix auto-fix", () => {
  it("prefixes unprefixed CSS classes (>3 unique)", () => {
    const css = `.hero { color: red; }
.card { margin: 10px; }
.footer { padding: 20px; }
.nav { display: flex; }`;
    const results = run([makeModule({ moduleCss: css })], "mytheme");
    expect(results[0].module.moduleCss).toContain(".mytheme-hero");
    expect(results[0].module.moduleCss).toContain(".mytheme-card");
  });

  it("skips framework classes (hs-, dnd-, body-wrapper)", () => {
    const css = `.hs-button { color: red; }
.dnd-section { margin: 10px; }
.one { padding: 1px; }
.two { padding: 2px; }
.three { padding: 3px; }
.four { padding: 4px; }`;
    const results = run([makeModule({ moduleCss: css })], "mytheme");
    expect(results[0].module.moduleCss).toContain(".hs-button");
    expect(results[0].module.moduleCss).toContain(".dnd-section");
  });

  it("does not prefix when <=3 unique classes", () => {
    const css = `.a { color: red; } .b { color: blue; } .c { color: green; }`;
    const results = run([makeModule({ moduleCss: css })], "mytheme");
    expect(results[0].module.moduleCss).not.toContain("mytheme-");
  });
});

// ---------------------------------------------------------------------------
// Multiple modules
// ---------------------------------------------------------------------------

describe("validator — multiple modules", () => {
  it("validates each module independently", () => {
    const mod1 = makeModule({ moduleName: "hero" });
    const mod2 = makeModule({
      moduleName: "footer",
      moduleHtml: "{% endif %}<footer>hi</footer>",
    });
    const results = run([mod1, mod2]);
    expect(results).toHaveLength(2);
    expect(results[0].issues).toHaveLength(0);
    expect(results[1].issues.length).toBeGreaterThan(0);
  });
});
