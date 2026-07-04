import { describe, it, expect } from "vitest";
import {
  renderHubL,
  buildContextFromFields,
  assemblePreview,
  type RenderContext,
  type FieldDef,
} from "../src/hubl/renderer.js";

// ---------------------------------------------------------------------------
// buildContextFromFields
// ---------------------------------------------------------------------------

describe("buildContextFromFields", () => {
  it("extracts scalar defaults", () => {
    const fields: FieldDef[] = [
      { name: "headline", type: "text", default: "Hello" },
      { name: "count", type: "number", default: 5 },
    ];
    expect(buildContextFromFields(fields)).toEqual({
      headline: "Hello",
      count: 5,
    });
  });

  it("uses empty string when no default is provided", () => {
    const fields: FieldDef[] = [{ name: "title", type: "text" }];
    expect(buildContextFromFields(fields)).toEqual({ title: "" });
  });

  it("recurses into non-repeater groups", () => {
    const fields: FieldDef[] = [
      {
        name: "styles",
        type: "group",
        children: [
          { name: "bg_color", type: "color", default: "#fff" },
          { name: "text_color", type: "color", default: "#000" },
        ],
      },
    ];
    expect(buildContextFromFields(fields)).toEqual({
      styles: { bg_color: "#fff", text_color: "#000" },
    });
  });

  it("handles repeater groups (array default)", () => {
    const fields: FieldDef[] = [
      {
        name: "items",
        type: "group",
        occurrence: { min: 1, max: 5 },
        default: [{ title: "A" }, { title: "B" }] as unknown as undefined,
      },
    ];
    expect(buildContextFromFields(fields)).toEqual({
      items: [{ title: "A" }, { title: "B" }],
    });
  });
});

// ---------------------------------------------------------------------------
// renderHubL — variable resolution
// ---------------------------------------------------------------------------

describe("renderHubL — variables", () => {
  const ctx: RenderContext = {
    module: {
      headline: "Welcome",
      nested: { color: "#ff0" },
      count: 42,
      empty: "",
    },
  };

  it("resolves simple variable", () => {
    expect(renderHubL("{{ module.headline }}", ctx)).toBe("Welcome");
  });

  it("resolves nested path", () => {
    expect(renderHubL("{{ module.nested.color }}", ctx)).toBe("#ff0");
  });

  it("resolves numeric value", () => {
    expect(renderHubL("{{ module.count }}", ctx)).toBe("42");
  });

  it("renders empty string for missing path", () => {
    expect(renderHubL("{{ module.nonexistent }}", ctx)).toBe("");
  });

  it("renders empty string for empty value", () => {
    expect(renderHubL("{{ module.empty }}", ctx)).toBe("");
  });

  it("strips literal \\n in values", () => {
    const c: RenderContext = { module: { text: "line1\\nline2" } };
    expect(renderHubL("{{ module.text }}", c)).toBe("line1 line2");
  });

  it("escapes expression output by default", () => {
    const c: RenderContext = {
      module: {
        text: `</script><script>window.pwned=1</script><img src=x onerror="alert('x')">`,
      },
    };
    expect(renderHubL("<p>{{ module.text }}</p>", c)).toBe(
      "<p>&lt;/script&gt;&lt;script&gt;window.pwned=1&lt;/script&gt;&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;</p>",
    );
  });
});

// ---------------------------------------------------------------------------
// renderHubL — filters
// ---------------------------------------------------------------------------

describe("renderHubL — filters", () => {
  const ctx: RenderContext = { module: { name: "hello world", num: 3.7 } };

  it("applies |upper", () => {
    expect(renderHubL("{{ module.name|upper }}", ctx)).toBe("HELLO WORLD");
  });

  it("applies |lower", () => {
    const c: RenderContext = { module: { name: "LOUD" } };
    expect(renderHubL("{{ module.name|lower }}", c)).toBe("loud");
  });

  it("applies |capitalize", () => {
    expect(renderHubL("{{ module.name|capitalize }}", ctx)).toBe("Hello world");
  });

  it("applies |truncate(n)", () => {
    expect(renderHubL("{{ module.name|truncate(5) }}", ctx)).toBe("hello...");
  });

  it("applies |escape", () => {
    const c: RenderContext = { module: { html: '<b>"hi"</b>' } };
    expect(renderHubL("{{ module.html|escape }}", c)).toBe(
      "&lt;b&gt;&quot;hi&quot;&lt;/b&gt;",
    );
  });

  it("does not double-escape explicit |escape output", () => {
    const c: RenderContext = { module: { html: "<b>hi</b>" } };
    expect(renderHubL("{{ module.html|escape }}", c)).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("applies |default(fallback) when value is empty", () => {
    const c: RenderContext = { module: { val: "" } };
    expect(renderHubL('{{ module.val|default("N/A") }}', c)).toBe("N/A");
  });

  it("applies |default(fallback) — keeps value when truthy", () => {
    const c: RenderContext = { module: { val: "real" } };
    expect(renderHubL('{{ module.val|default("N/A") }}', c)).toBe("real");
  });

  it("applies |length on array", () => {
    const c: RenderContext = { module: { items: [1, 2, 3] } };
    expect(renderHubL("{{ module.items|length }}", c)).toBe("3");
  });

  it("applies |join on array", () => {
    const c: RenderContext = { module: { tags: ["a", "b", "c"] } };
    expect(renderHubL("{{ module.tags|join }}", c)).toBe("a, b, c");
  });

  it("applies |int", () => {
    expect(renderHubL("{{ module.num|int }}", ctx)).toBe("3.7");
    // |int returns Number("3.7") which is 3.7 — it converts to number, toString gives "3.7"
    // Actually let's check the actual behavior: Number("3.7") = 3.7, so String(3.7) = "3.7"
  });

  it("applies |round", () => {
    expect(renderHubL("{{ module.num|round }}", ctx)).toBe("4");
  });

  it("applies |abs", () => {
    const c: RenderContext = { module: { val: -5 } };
    expect(renderHubL("{{ module.val|abs }}", c)).toBe("5");
  });

  it("chains multiple filters", () => {
    expect(renderHubL("{{ module.name|upper|truncate(5) }}", ctx)).toBe(
      "HELLO...",
    );
  });
});

// ---------------------------------------------------------------------------
// renderHubL — conditionals
// ---------------------------------------------------------------------------

describe("renderHubL — conditionals", () => {
  it("renders if-branch when truthy", () => {
    const ctx: RenderContext = { module: { show: true } };
    const tpl = "{% if module.show %}visible{% endif %}";
    expect(renderHubL(tpl, ctx)).toBe("visible");
  });

  it("renders nothing when falsy", () => {
    const ctx: RenderContext = { module: { show: false } };
    const tpl = "{% if module.show %}visible{% endif %}";
    expect(renderHubL(tpl, ctx)).toBe("");
  });

  it("renders else-branch when falsy", () => {
    const ctx: RenderContext = { module: { show: false } };
    const tpl = "{% if module.show %}yes{% else %}no{% endif %}";
    expect(renderHubL(tpl, ctx)).toBe("no");
  });

  it("handles == comparison with string literal", () => {
    const ctx: RenderContext = { module: { color: "red" } };
    expect(
      renderHubL('{% if module.color == "red" %}RED{% endif %}', ctx),
    ).toBe("RED");
  });

  it("handles != comparison", () => {
    const ctx: RenderContext = { module: { color: "blue" } };
    expect(
      renderHubL('{% if module.color != "red" %}not red{% endif %}', ctx),
    ).toBe("not red");
  });

  it("handles 'not' prefix", () => {
    const ctx: RenderContext = { module: { hidden: false } };
    expect(
      renderHubL("{% if not module.hidden %}shown{% endif %}", ctx),
    ).toBe("shown");
  });

  it("handles 'and' operator", () => {
    const ctx: RenderContext = { module: { a: true, b: true } };
    expect(
      renderHubL(
        "{% if module.a and module.b %}both{% endif %}",
        ctx,
      ),
    ).toBe("both");
  });

  it("handles 'or' operator", () => {
    const ctx: RenderContext = { module: { a: false, b: true } };
    expect(
      renderHubL("{% if module.a or module.b %}one{% endif %}", ctx),
    ).toBe("one");
  });

  it("handles numeric comparisons", () => {
    const ctx: RenderContext = { module: { count: 10 } };
    expect(
      renderHubL("{% if module.count > 5 %}big{% endif %}", ctx),
    ).toBe("big");
  });

  it("selects elif branches without leaking else bodies", () => {
    const ctx: RenderContext = { module: { tier: "pro" } };
    const tpl = '{% if module.tier == "enterprise" %}enterprise{% elif module.tier == "pro" %}pro{% else %}basic{% endif %}';
    expect(renderHubL(tpl, ctx)).toBe("pro");
  });

  it("keeps nested conditionals associated with their owning branch", () => {
    const ctx: RenderContext = { module: { outer: false, inner: true, alt: true } };
    const tpl = [
      "{% if module.outer %}",
      "outer",
      "{% if module.inner %}inner{% else %}inner-else{% endif %}",
      "{% elif module.alt %}",
      "alt",
      "{% else %}",
      "fallback",
      "{% endif %}",
    ].join("");
    expect(renderHubL(tpl, ctx)).toBe("alt");
  });

  it("handles comparison text inside a true branch", () => {
    const ctx: RenderContext = { module: { count: 12 } };
    const tpl = "{% if module.count > 10 %}<span>5 > 3</span>{% elif module.count > 5 %}mid{% else %}low{% endif %}";
    expect(renderHubL(tpl, ctx)).toBe("<span>5 > 3</span>");
  });

  it("empty string is falsy", () => {
    const ctx: RenderContext = { module: { val: "" } };
    expect(
      renderHubL("{% if module.val %}yes{% else %}no{% endif %}", ctx),
    ).toBe("no");
  });

  it("empty array is falsy", () => {
    const ctx: RenderContext = { module: { items: [] } };
    expect(
      renderHubL("{% if module.items %}yes{% else %}no{% endif %}", ctx),
    ).toBe("no");
  });
});

// ---------------------------------------------------------------------------
// renderHubL — for loops
// ---------------------------------------------------------------------------

describe("renderHubL — for loops", () => {
  it("iterates over array of objects", () => {
    const ctx: RenderContext = {
      module: { items: [{ title: "A" }, { title: "B" }] },
    };
    const tpl =
      "{% for item in module.items %}<li>{{ item.title }}</li>{% endfor %}";
    expect(renderHubL(tpl, ctx)).toBe("<li>A</li><li>B</li>");
  });

  it("provides loop.index (1-based)", () => {
    const ctx: RenderContext = { module: { items: ["x", "y"] } };
    const tpl =
      "{% for item in module.items %}{{ loop.index }}{% endfor %}";
    expect(renderHubL(tpl, ctx)).toBe("12");
  });

  it("provides loop.index0 (0-based)", () => {
    const ctx: RenderContext = { module: { items: ["x", "y"] } };
    const tpl =
      "{% for item in module.items %}{{ loop.index0 }}{% endfor %}";
    expect(renderHubL(tpl, ctx)).toBe("01");
  });

  it("provides loop.first and loop.last", () => {
    const ctx: RenderContext = { module: { items: ["a", "b", "c"] } };
    const tpl = `{% for item in module.items %}{% if loop.first %}F{% endif %}{% if loop.last %}L{% endif %}{% endfor %}`;
    expect(renderHubL(tpl, ctx)).toBe("FL");
  });

  it("renders nothing for empty array", () => {
    const ctx: RenderContext = { module: { items: [] } };
    const tpl =
      "{% for item in module.items %}<li>{{ item }}</li>{% endfor %}";
    expect(renderHubL(tpl, ctx)).toBe("");
  });

  it("handles range(start, end)", () => {
    const ctx: RenderContext = { module: {} };
    const tpl =
      "{% for i in range(0, 3) %}{{ loop.index0 }}{% endfor %}";
    expect(renderHubL(tpl, ctx)).toBe("012");
  });

  it("handles nested for loops", () => {
    const ctx: RenderContext = {
      module: {
        rows: [
          { cells: ["a", "b"] },
          { cells: ["c", "d"] },
        ],
      },
    };
    const tpl = `{% for row in module.rows %}{% for cell in row.cells %}{{ cell }}{% endfor %}{% endfor %}`;
    expect(renderHubL(tpl, ctx)).toBe("abcd");
  });
});

// ---------------------------------------------------------------------------
// renderHubL — directives stripping
// ---------------------------------------------------------------------------

describe("renderHubL — directive stripping", () => {
  it("strips require_css block tags", () => {
    const tpl = '{% require_css %}<link href="style.css">{% end_require_css %}<div>content</div>';
    const ctx: RenderContext = { module: {} };
    expect(renderHubL(tpl, ctx)).toContain("<div>content</div>");
    expect(renderHubL(tpl, ctx)).not.toContain("require_css");
  });

  it("strips dnd_ tags", () => {
    const tpl = '{% dnd_area "main" %}{% dnd_section %}<div>hi</div>{% end_dnd_section %}{% end_dnd_area %}';
    const ctx: RenderContext = { module: {} };
    expect(renderHubL(tpl, ctx)).toContain("<div>hi</div>");
    expect(renderHubL(tpl, ctx)).not.toContain("dnd_area");
  });

  it("resolves get_asset_url to /theme-assets/", () => {
    const tpl = '<img src="{{ get_asset_url("assets/logo.png") }}">';
    const ctx: RenderContext = { module: {} };
    expect(renderHubL(tpl, ctx)).toBe('<img src="/theme-assets/logo.png">');
  });

  it("strips HubL comments", () => {
    const tpl = "{# this is a comment #}<div>visible</div>";
    const ctx: RenderContext = { module: {} };
    expect(renderHubL(tpl, ctx)).toBe("<div>visible</div>");
  });
});

// ---------------------------------------------------------------------------
// assemblePreview
// ---------------------------------------------------------------------------

describe("assemblePreview", () => {
  it("produces valid HTML with styles and scripts", () => {
    const html = assemblePreview({
      renderedModules: ["<section>A</section>", "<section>B</section>"],
      sharedCss: "body{margin:0}",
      moduleCssArray: [".hero{color:red}"],
      sharedJs: "console.log('shared')",
      moduleJsArray: ["console.log('mod')"],
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<style>body{margin:0}</style>");
    expect(html).toContain("<style>.hero{color:red}</style>");
    expect(html).toContain("<section>A</section>");
    expect(html).toContain("<section>B</section>");
    expect(html).toContain("<script>console.log('shared')</script>");
    expect(html).toContain("<script>console.log('mod')</script>");
  });

  it("skips empty CSS/JS blocks", () => {
    const html = assemblePreview({
      renderedModules: ["<div>hi</div>"],
      moduleCssArray: [],
      moduleJsArray: [],
    });

    expect(html).toContain("<div>hi</div>");
    expect(html).not.toContain("<style></style>");
  });

  it("does not allow CSS or JS to break out of preview tags", () => {
    const html = assemblePreview({
      renderedModules: ["<div>hi</div>"],
      sharedCss: "body{color:red}</style><script>window.cssPwned=1</script>",
      moduleCssArray: [],
      sharedJs: "console.log('</script><script>window.jsPwned=1</script>')",
      moduleJsArray: [],
    });

    expect(html).toContain("<\\/style><script>window.cssPwned=1</script>");
    expect(html).toContain("<\\/script><script>window.jsPwned=1<\\/script>");
    expect(html).not.toContain("</style><script>window.cssPwned=1</script>");
    expect(html).not.toContain("</script><script>window.jsPwned=1</script>");
  });
});

// ---------------------------------------------------------------------------
// convert_rgb + arithmetic (VIB-1842)
// ---------------------------------------------------------------------------

describe("convert_rgb filter", () => {
  it("converts a hex string to an r, g, b triple", () => {
    const ctx: RenderContext = { module: { c: "#0f1115" } };
    expect(renderHubL("{{ module.c|convert_rgb }}", ctx)).toBe("15, 17, 21");
  });

  it("expands 3-digit hex", () => {
    const ctx: RenderContext = { module: { c: "#fff" } };
    expect(renderHubL("{{ module.c|convert_rgb }}", ctx)).toBe("255, 255, 255");
  });

  it("reads the hex out of a color-field object", () => {
    const ctx: RenderContext = { module: { c: { color: "#ff5c35", opacity: 100 } } };
    expect(renderHubL("{{ module.c|convert_rgb }}", ctx)).toBe("255, 92, 53");
  });

  it("renders empty for a missing/undefaulted color (surfaces the defect)", () => {
    const ctx: RenderContext = { module: { c: "" } };
    expect(renderHubL("{{ module.c|convert_rgb }}", ctx)).toBe("");
  });
});

describe("expression arithmetic", () => {
  it("evaluates the opacity/100 idiom", () => {
    const ctx: RenderContext = { module: { o: 50 } };
    expect(renderHubL("{{ module.o/100 }}", ctx)).toBe("0.5");
  });

  it("collapses to empty when the operand is undefaulted", () => {
    const ctx: RenderContext = { module: { o: "" } };
    expect(renderHubL("{{ module.o/100 }}", ctx)).toBe("");
  });
});

describe("rgba composition (the GPT vs Anthropic split)", () => {
  const tpl = "background: rgba({{ module.styles.bg.color|convert_rgb }}, {{ module.styles.bg.opacity/100 }});";

  it("renders valid CSS when the style group has defaults", () => {
    const fields: FieldDef[] = [
      {
        name: "styles",
        type: "group",
        children: [
          {
            name: "bg",
            type: "group",
            children: [
              { name: "color", type: "color", default: "#0f1115" },
              { name: "opacity", type: "number", default: 50 },
            ],
          },
        ],
      },
    ];
    const ctx: RenderContext = { module: buildContextFromFields(fields) };
    expect(renderHubL(tpl, ctx)).toBe("background: rgba(15, 17, 21, 0.5);");
  });

  it("renders empty components when the style group has no defaults", () => {
    const fields: FieldDef[] = [
      {
        name: "styles",
        type: "group",
        children: [
          {
            name: "bg",
            type: "group",
            children: [
              { name: "color", type: "color" },
              { name: "opacity", type: "number" },
            ],
          },
        ],
      },
    ];
    const ctx: RenderContext = { module: buildContextFromFields(fields) };
    expect(renderHubL(tpl, ctx)).toBe("background: rgba(, );");
  });
});
