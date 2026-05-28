import { describe, it, expect } from "vitest";
import type { ModuleFiles } from "../../src/ai/engine.js";
import {
  scoreValidity,
  scoreCoverage,
  combineAccuracy,
  type ValidityScore,
  type CoverageScore,
  type JudgeScore,
} from "./scoring.js";
import type { ExpectedModule } from "./dataset.js";

const THEME = "eval-test";

function cleanModule(name: string): ModuleFiles {
  return {
    moduleName: name,
    fieldsJson: JSON.stringify([{ name: "headline", type: "text", default: "Hi" }]),
    metaJson: JSON.stringify({ host_template_types: ["PAGE"], is_available_for_new_content: true }),
    moduleHtml: `<section class="${THEME}-${name}"><h2>{{ module.headline }}</h2></section>`,
    moduleCss: `.${THEME}-${name} { padding: 16px; }`,
  };
}

describe("scoreValidity", () => {
  it("clean modules pass and are clean", () => {
    const v = scoreValidity([cleanModule("hero"), cleanModule("footer")], THEME, "page");
    expect(v.moduleCount).toBe(2);
    expect(v.passRate).toBe(1);
    expect(v.cleanRate).toBe(1);
    expect(v.unfixableIssues).toBe(0);
  });

  it("counts an auto-fixable reserved field name as a fixable issue, still passing", () => {
    const mod = cleanModule("hero");
    mod.fieldsJson = JSON.stringify([{ name: "name", type: "text", default: "x" }]);
    const v = scoreValidity([mod], THEME, "page");
    expect(v.passRate).toBe(1); // reserved-name rename is auto-fixable → still ships
    expect(v.cleanRate).toBe(0); // but it wasn't perfect on first generation
    expect(v.autoFixableIssues).toBeGreaterThan(0);
    expect(v.unfixableIssues).toBe(0);
  });

  it("flags an unfixable email issue (display:flex) so the module fails", () => {
    const mod: ModuleFiles = {
      moduleName: "hero",
      fieldsJson: "[]",
      metaJson: JSON.stringify({ host_template_types: ["EMAIL"] }),
      moduleHtml: `<div style="display:flex">{{ module.x }}</div>`,
      moduleCss: "",
    };
    const v = scoreValidity([mod], THEME, "email");
    expect(v.modulesWithUnfixable).toBe(1);
    expect(v.passRate).toBe(0);
    expect(v.unfixableSamples.some((s) => /flex/i.test(s))).toBe(true);
  });

  it("returns zeroes for an empty module set", () => {
    const v = scoreValidity([], THEME, "page");
    expect(v.moduleCount).toBe(0);
    expect(v.passRate).toBe(0);
  });
});

describe("scoreCoverage", () => {
  const expected: ExpectedModule[] = [
    { name: "hero", keywords: ["headline"] },
    { name: "pricing", keywords: ["tier", "plan"] },
    { name: "footer", keywords: ["newsletter"] },
  ];

  it("matches sections by name and by keyword", () => {
    const mods = [cleanModule("hero"), cleanModule("pricing-table")];
    const c = scoreCoverage(mods, expected);
    expect(c.coveredCount).toBe(2); // hero (name), pricing (substring), footer missing
    expect(c.missing).toEqual(["footer"]);
    expect(c.coverage).toBeCloseTo(2 / 3);
  });

  it("full coverage when all sections present", () => {
    const mods = [cleanModule("hero"), cleanModule("pricing"), cleanModule("footer")];
    expect(scoreCoverage(mods, expected).coverage).toBe(1);
  });
});

describe("combineAccuracy", () => {
  const validity = { passRate: 1, cleanRate: 1 } as ValidityScore;
  const coverage = { coverage: 1 } as CoverageScore;

  it("uses 0.4/0.2/0.4 weights when a judge score is present", () => {
    const judge = { overall: 0.5 } as JudgeScore;
    expect(combineAccuracy(validity, coverage, judge)).toBeCloseTo(0.4 * 1 + 0.2 * 1 + 0.4 * 0.5);
  });

  it("rebalances to 0.65/0.35 without a judge", () => {
    expect(combineAccuracy(validity, coverage, null)).toBeCloseTo(0.65 + 0.35);
  });
});

describe("scoreValidity — invalid CSS axis (VIB-1842)", () => {
  const styleTpl =
    "{% scope_css %}.x{background:rgba({{ module.styles.bg.color|convert_rgb }}, {{ module.styles.bg.opacity/100 }})}{% end_scope_css %}<section class=\"x\"></section>";

  function gptStyleModule(name: string): ModuleFiles {
    return {
      moduleName: name,
      fieldsJson: JSON.stringify([
        {
          name: "styles",
          type: "group",
          children: [
            { name: "bg", type: "group", children: [
              { name: "color", type: "color" },
              { name: "opacity", type: "number" },
            ] },
          ],
        },
      ]),
      metaJson: JSON.stringify({ host_template_types: ["PAGE"], is_available_for_new_content: true }),
      moduleHtml: styleTpl,
      moduleCss: "",
    };
  }

  it("counts undefaulted-style modules and docks pass-rate", () => {
    const v = scoreValidity([gptStyleModule("hero"), cleanModule("footer")], THEME, "page");
    expect(v.invalidCssModules).toBe(1);
    expect(v.passRate).toBe(0.5); // the hero ships broken → unfixable
    expect(v.unfixableSamples.some((s) => /invalid CSS color/i.test(s))).toBe(true);
  });

  it("is zero for modules that hard-code their colors", () => {
    const mod = cleanModule("hero");
    mod.moduleCss = `.${THEME}-hero{background:rgba(15, 17, 21, 0.5)}`;
    const v = scoreValidity([mod], THEME, "page");
    expect(v.invalidCssModules).toBe(0);
    expect(v.passRate).toBe(1);
  });
});
