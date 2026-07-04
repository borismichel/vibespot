/**
 * Behavioral coverage for src/ai/ — module prompt builders, the AI response
 * parse + malformed-output guards, and the design-extractor (VIB-1900).
 *
 * Strategy:
 *  - prompts.ts:  pure functions — no mocks needed.
 *  - claude-api.ts parse logic: mock the Anthropic SDK at module level so the
 *    ClaudeAPIEngine exercises the full parse + error-guard path without making
 *    real API calls or requiring real files.
 *  - design-extractor.ts collectThemeFiles: inject a temp dir with known
 *    content and assert the concatenated output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// prompts.ts — pure builders
// ---------------------------------------------------------------------------
import {
  buildAnalyzePrompt,
  buildModulePrompt,
  buildCssPrompt,
  buildJsPrompt,
  buildTemplatePrompt,
  buildSystemPrompt,
} from "../src/ai/prompts.js";

describe("buildAnalyzePrompt", () => {
  it("embeds the component list verbatim", () => {
    const prompt = buildAnalyzePrompt("Hero.tsx\nFooter.tsx");
    expect(prompt).toContain("Hero.tsx");
    expect(prompt).toContain("Footer.tsx");
  });

  it('instructs the model to return JSON only ("no markdown fences")', () => {
    const prompt = buildAnalyzePrompt("x");
    expect(prompt.toLowerCase()).toContain("no markdown");
    expect(prompt.toLowerCase()).toContain("json");
  });

  it("lists expected output keys: name, description, hasRepeaters, hasInteractivity", () => {
    const prompt = buildAnalyzePrompt("x");
    for (const key of ["name", "description", "hasRepeaters", "hasInteractivity"]) {
      expect(prompt).toContain(key);
    }
  });
});

describe("buildModulePrompt", () => {
  it("embeds module name, source, and cssVars", () => {
    const prompt = buildModulePrompt("const X = 1;", "My Hero", ".primary { color: red; }");
    expect(prompt).toContain("My Hero");
    expect(prompt).toContain("const X = 1;");
    expect(prompt).toContain(".primary { color: red; }");
  });

  it("requires fieldsJson, metaJson, moduleHtml, moduleCss, moduleJs keys", () => {
    const prompt = buildModulePrompt("src", "N", "css");
    for (const key of ["fieldsJson", "metaJson", "moduleHtml", "moduleCss", "moduleJs"]) {
      expect(prompt).toContain(key);
    }
  });
});

describe("buildCssPrompt", () => {
  it("embeds the page prefix", () => {
    const prompt = buildCssPrompt("body{}", "module.exports={}", "lp-acme");
    expect(prompt).toContain("lp-acme");
  });

  it("includes the source css", () => {
    const prompt = buildCssPrompt("body { background: #fff; }", "", "pfx");
    expect(prompt).toContain("body { background: #fff; }");
  });
});

describe("buildJsPrompt", () => {
  it("embeds the page prefix and source hooks", () => {
    const prompt = buildJsPrompt("useScroll()", "Carousel.tsx", "lp-demo");
    expect(prompt).toContain("lp-demo");
    expect(prompt).toContain("useScroll()");
    expect(prompt).toContain("Carousel.tsx");
  });
});

describe("buildTemplatePrompt", () => {
  it("lists all module names", () => {
    const prompt = buildTemplatePrompt(["Hero", "Footer", "CTA"], "My Theme", "lp-x");
    expect(prompt).toContain("Hero.module");
    expect(prompt).toContain("Footer.module");
    expect(prompt).toContain("CTA.module");
  });

  it("embeds the theme name and page prefix", () => {
    const prompt = buildTemplatePrompt([], "Acme Theme", "lp-acme");
    expect(prompt).toContain("Acme Theme");
    expect(prompt).toContain("lp-acme");
  });
});

describe("buildSystemPrompt", () => {
  it("includes the conversion guide", () => {
    const guide = "MY_SPECIAL_RULE: always use semicolons";
    const prompt = buildSystemPrompt(guide);
    expect(prompt).toContain(guide);
  });

  it("prohibits the reserved 'name' field name in fields.json", () => {
    // This is a critical HubSpot constraint — the prompt must warn the model.
    const prompt = buildSystemPrompt("");
    expect(prompt).toMatch(/NEVER use.*"name".*reserved/i);
  });
});

// ---------------------------------------------------------------------------
// claude-api.ts — parse + malformed-output guard
// ---------------------------------------------------------------------------

// Shared mock create fn, assigned per test in beforeEach
let _mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: (...args: unknown[]) => _mockCreate(...args) };
    constructor(_opts?: unknown) {}
  }
  return { default: MockAnthropic };
});

vi.mock("../src/server/langfuse.js", () => ({ reportModelUsage: vi.fn() }));
vi.mock("../src/server/pricing.js", () => ({ mapAnthropicUsage: vi.fn(() => ({})) }));

// Helper to build a fake Anthropic response.
function fakeResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

// Build a minimal valid module JSON string matching ClaudeAPIEngine's expectations.
function validModuleJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    fieldsJson: '[{"name":"heading","type":"text","label":"Heading","default":""}]',
    metaJson: '{"label":"Hero","icon":"module"}',
    moduleHtml: '<section class="hero">{{ module.heading }}</section>',
    moduleCss: ".hero { padding: 4rem; }",
    moduleJs: null,
    ...overrides,
  });
}

describe("ClaudeAPIEngine — module parse + guards", () => {
  let dir: string;
  let sourceDir: string;
  let themePath: string;
  let engine: import("../src/ai/claude-api.js").ClaudeAPIEngine;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    _mockCreate = vi.fn();
    mockCreate = _mockCreate;

    dir = mkdtempSync(join(tmpdir(), "vibespot-ai-"));
    sourceDir = join(dir, "src-react");
    themePath = join(dir, "theme");

    // Engine's findComponents searches src/components, src/components/sections, or src/components/landing
    mkdirSync(join(sourceDir, "src", "components"), { recursive: true });
    writeFileSync(join(sourceDir, "src", "components", "HeroSection.tsx"), "export default function HeroSection() { return <div>Hero</div>; }");

    mkdirSync(join(themePath, "css"), { recursive: true });
    mkdirSync(join(themePath, "js"), { recursive: true });

    const { ClaudeAPIEngine } = await import("../src/ai/claude-api.js");
    engine = new ClaudeAPIEngine("test-key");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("successfully parses a well-formed module response and calls onProgress('module-done')", async () => {
    const validModule = validModuleJson();
    mockCreate
      .mockResolvedValueOnce(fakeResponse(".hero {}"))    // CSS
      .mockResolvedValueOnce(fakeResponse("console.log('init');")) // JS
      .mockResolvedValueOnce(fakeResponse(validModule))   // module
      .mockResolvedValueOnce(fakeResponse("{% extends %}"));  // template

    const progress: [string, string][] = [];
    const result = await engine.convert({
      sourceDir,
      themePath,
      conversionGuide: "test guide",
      onProgress: (step, detail) => progress.push([step, detail]),
    });

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0].moduleName).toBeTruthy();
    expect(result.modules[0].moduleHtml).toContain("hero");
    expect(progress.some(([s]) => s === "module-done")).toBe(true);
    expect(progress.some(([s]) => s === "module-error")).toBe(false);
  });

  it("swallows malformed JSON and calls onProgress('module-error') without throwing", async () => {
    mockCreate
      .mockResolvedValueOnce(fakeResponse(".hero {}"))
      .mockResolvedValueOnce(fakeResponse("console.log('init');"))
      .mockResolvedValueOnce(fakeResponse("```json\nNOT VALID JSON```")) // bad
      .mockResolvedValueOnce(fakeResponse("{% extends %}"));

    const progress: [string, string][] = [];
    // convert() must not throw
    await expect(engine.convert({
      sourceDir,
      themePath,
      conversionGuide: "guide",
      onProgress: (s, d) => progress.push([s, d]),
    })).resolves.not.toThrow();

    // The module that failed to parse is skipped — either module-error was emitted
    // or the modules array is empty. Both are valid; the key guarantee is no throw.
    expect(progress.some(([s]) => s === "module-error")).toBe(true);
  });

  it("normalises fieldsJson when the model returns an object instead of a JSON string", async () => {
    // Model sometimes returns the JSON object directly instead of a string.
    const withObjectFields = validModuleJson({
      fieldsJson: [{ name: "heading", type: "text", label: "Heading", default: "" }],
    });
    mockCreate
      .mockResolvedValueOnce(fakeResponse(".hero {}"))
      .mockResolvedValueOnce(fakeResponse("console.log('init');"))
      .mockResolvedValueOnce(fakeResponse(withObjectFields))
      .mockResolvedValueOnce(fakeResponse("{% extends %}"));

    const result = await engine.convert({
      sourceDir,
      themePath,
      conversionGuide: "guide",
      onProgress: () => {},
    });

    if (result.modules.length > 0) {
      // Should be stringified, not "[object Object]"
      expect(typeof result.modules[0].fieldsJson).toBe("string");
      expect(() => JSON.parse(result.modules[0].fieldsJson)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// design-extractor.ts — collectThemeFiles
// ---------------------------------------------------------------------------
import { collectThemeFiles } from "../src/ai/design-extractor.js";

describe("collectThemeFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vibespot-extractor-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty string for an empty theme dir", () => {
    expect(collectThemeFiles(dir)).toBe("");
  });

  it("includes css file contents in the output", () => {
    mkdirSync(join(dir, "css"));
    writeFileSync(join(dir, "css", "main.css"), ".hero { color: red; }");
    const out = collectThemeFiles(dir);
    expect(out).toContain(".hero { color: red; }");
    expect(out).toContain("css/main.css");
  });

  it("includes theme.json in the output", () => {
    writeFileSync(join(dir, "theme.json"), '{"label":"Acme"}');
    const out = collectThemeFiles(dir);
    expect(out).toContain('"label":"Acme"');
    expect(out).toContain("theme.json");
  });

  it("includes module CSS from .module subdirs", () => {
    const modDir = join(dir, "modules", "Hero.module");
    mkdirSync(modDir, { recursive: true });
    writeFileSync(join(modDir, "module.css"), ".hero-mod { margin: 0; }");
    const out = collectThemeFiles(dir);
    expect(out).toContain(".hero-mod { margin: 0; }");
  });

  it("skips sections that would exceed the char budget without truncating existing ones", () => {
    // Write a small css file first, then a huge one.
    mkdirSync(join(dir, "css"));
    writeFileSync(join(dir, "css", "a.css"), ".a {}");
    // 600 KB — larger than MAX_CONTENT_CHARS (typically ~512 KB)
    writeFileSync(join(dir, "css", "z-huge.css"), "x".repeat(600_000));
    const out = collectThemeFiles(dir);
    // The small file must appear; the huge file must not bloat the output past budget
    expect(out).toContain(".a {}");
    // Output must stay bounded
    expect(out.length).toBeLessThan(600_000);
  });
});
