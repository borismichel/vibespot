import { describe, it, expect } from "vitest";
import {
  parsePlanTemplate,
  listPlanTemplates,
  getPlanTemplate,
  listPlanTemplateMetadata,
} from "../src/server/plan-templates.js";

// ---------------------------------------------------------------------------
// parsePlanTemplate — frontmatter + body parsing
// ---------------------------------------------------------------------------

describe("parsePlanTemplate", () => {
  it("parses a valid template with all fields", () => {
    const raw = `---
id: test-template
label: Test Template
description: A test description
icon: rocket
order: 5
---

# Test Template

## Goal
Test goal here.
`;
    const tpl = parsePlanTemplate(raw);
    expect(tpl).not.toBeNull();
    expect(tpl!.id).toBe("test-template");
    expect(tpl!.label).toBe("Test Template");
    expect(tpl!.description).toBe("A test description");
    expect(tpl!.icon).toBe("rocket");
    expect(tpl!.order).toBe(5);
    expect(tpl!.body).toContain("# Test Template");
    expect(tpl!.body).toContain("## Goal");
  });

  it("returns null when frontmatter is missing", () => {
    const raw = `# No frontmatter\n\nBody only.`;
    expect(parsePlanTemplate(raw)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    const raw = `---
description: Missing id and label
---

# Body
`;
    expect(parsePlanTemplate(raw)).toBeNull();
  });

  it("strips quotes around frontmatter values", () => {
    const raw = `---
id: "quoted-id"
label: 'single-quoted'
description: ""
---

body
`;
    const tpl = parsePlanTemplate(raw);
    expect(tpl).not.toBeNull();
    expect(tpl!.id).toBe("quoted-id");
    expect(tpl!.label).toBe("single-quoted");
    expect(tpl!.description).toBe("");
  });

  it("defaults order to 9999 when not provided or invalid", () => {
    const a = parsePlanTemplate(`---
id: a
label: A
---
body
`);
    expect(a!.order).toBe(9999);

    const b = parsePlanTemplate(`---
id: b
label: B
order: notanumber
---
body
`);
    expect(b!.order).toBe(9999);
  });

  it("preserves the markdown body verbatim and trims surrounding whitespace", () => {
    const raw = `---
id: x
label: X
---


# Heading

Para.

`;
    const tpl = parsePlanTemplate(raw);
    expect(tpl!.body.startsWith("# Heading")).toBe(true);
    expect(tpl!.body.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listPlanTemplates — loads from assets/plan-templates/
// ---------------------------------------------------------------------------

describe("listPlanTemplates", () => {
  it("returns the templates that ship with the package", () => {
    const tpls = listPlanTemplates();
    // We ship at least the page types called out in VIB-57: SaaS, e-commerce,
    // event, blog, portfolio, agency. Restaurant is also bundled to match
    // the existing chat-input starter templates.
    const ids = tpls.map((t) => t.id);
    expect(ids).toContain("saas-landing");
    expect(ids).toContain("ecommerce-product");
    expect(ids).toContain("event-registration");
    expect(ids).toContain("blog-content-hub");
    expect(ids).toContain("portfolio");
    expect(ids).toContain("agency-services");
    expect(ids).toContain("restaurant");
  });

  it("sorts templates by order, then by label", () => {
    const tpls = listPlanTemplates();
    for (let i = 1; i < tpls.length; i++) {
      const prev = tpls[i - 1];
      const cur = tpls[i];
      if (prev.order === cur.order) {
        expect(prev.label.localeCompare(cur.label)).toBeLessThanOrEqual(0);
      } else {
        expect(prev.order).toBeLessThanOrEqual(cur.order);
      }
    }
  });

  it("each shipped template has a non-empty open-questions section", () => {
    // Open-questions drive the page-type-specific elicitation in plan mode,
    // so a template without them defeats the point.
    const tpls = listPlanTemplates();
    for (const tpl of tpls) {
      expect(tpl.body).toMatch(/##\s+Open questions/i);
      // At least one bullet/checkbox under the open-questions heading.
      const openIdx = tpl.body.search(/##\s+Open questions/i);
      const tail = tpl.body.slice(openIdx);
      expect(tail).toMatch(/-\s*\[\s?\]/);
    }
  });

  it("each shipped template has a sections/modules section listing kebab-case names", () => {
    const tpls = listPlanTemplates();
    for (const tpl of tpls) {
      expect(tpl.body).toMatch(/##\s+.*\bModules\b/i);
      // At least one bolded kebab-case module name.
      expect(tpl.body).toMatch(/\*\*[a-z0-9]+(?:-[a-z0-9]+)*\*\*/);
    }
  });
});

describe("getPlanTemplate", () => {
  it("returns the matching template by id", () => {
    const tpl = getPlanTemplate("saas-landing");
    expect(tpl).not.toBeNull();
    expect(tpl!.label).toBe("SaaS Landing Page");
  });

  it("returns null for an unknown id", () => {
    expect(getPlanTemplate("nope-not-here")).toBeNull();
  });
});

describe("listPlanTemplateMetadata", () => {
  it("returns metadata-only objects (no body)", () => {
    const meta = listPlanTemplateMetadata();
    expect(meta.length).toBeGreaterThan(0);
    for (const m of meta) {
      expect(m).toHaveProperty("id");
      expect(m).toHaveProperty("label");
      expect(m).toHaveProperty("description");
      expect(m).toHaveProperty("order");
      expect(m).not.toHaveProperty("body");
    }
  });
});
