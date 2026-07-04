/**
 * Regression coverage for the VIB-1894 AI-pipeline correctness fixes:
 *  - OpenAI max_tokens clamped to the model's completion cap (gpt-4o 400'd on 48000)
 *  - malformed AI modules (missing fieldsJson/metaJson, empty name) are dropped
 *    instead of poisoning the session and crash-looping writeModulesToDisk
 *  - buildStateContext budget counts every emitted source block (4 per module
 *    + shared CSS/JS), not one per module
 *  - autoFixError matches upload errors case-insensitively and reaches the
 *    dnd_area_stylesheet branch
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveOpenAIMaxTokens } from "../src/server/ai-engines.js";
import { parseAndApplyModules } from "../src/server/ai-parser.js";
import { buildStateContext, STATE_CONTEXT_CHAR_BUDGET } from "../src/server/ai-prompts.js";
import { createSession, getSession } from "../src/server/session.js";
import { autoFixError } from "../src/server/auto-fix.js";

// ---------------------------------------------------------------------------
// OpenAI completion-token clamp
// ---------------------------------------------------------------------------

describe("resolveOpenAIMaxTokens", () => {
  it("clamps to gpt-4o's 16384 cap (48000 used to 400 every call)", () => {
    expect(resolveOpenAIMaxTokens("gpt-4o")).toBe(16_384);
    expect(resolveOpenAIMaxTokens("gpt-4o-mini")).toBe(16_384);
  });

  it("uses the per-family caps", () => {
    expect(resolveOpenAIMaxTokens("gpt-4.1")).toBe(32_768);
    expect(resolveOpenAIMaxTokens("gpt-4-turbo")).toBe(4_096);
  });

  it("keeps the requested 48000 when the model's cap allows it", () => {
    expect(resolveOpenAIMaxTokens("gpt-5")).toBe(48_000);
    expect(resolveOpenAIMaxTokens("o3-mini")).toBe(48_000);
  });

  it("falls back to a safe default for unknown models (e.g. Langdock mistral)", () => {
    expect(resolveOpenAIMaxTokens("mistral-large-latest")).toBe(16_384);
  });
});

// ---------------------------------------------------------------------------
// Module validation before session persistence
// ---------------------------------------------------------------------------

describe("parseAndApplyModules validation", () => {
  let themeDir: string;

  beforeEach(() => {
    themeDir = mkdtempSync(join(tmpdir(), "vib1894-"));
    createSession(themeDir, "test-theme");
  });

  afterEach(() => {
    rmSync(themeDir, { recursive: true, force: true });
  });

  const validModule = {
    moduleName: "hero",
    fieldsJson: '[{"name":"headline","type":"text"}]',
    metaJson: '{"label":"Hero"}',
    moduleHtml: "<h1>Hi</h1>",
    moduleCss: ".hero{}",
  };

  function respond(modules: unknown[]): string {
    return "```vibespot-modules\n" + JSON.stringify({ modules }) + "\n```";
  }

  it("keeps valid modules and drops one missing fieldsJson/metaJson", () => {
    const warnings: string[] = [];
    parseAndApplyModules(
      respond([validModule, { moduleName: "broken", moduleHtml: "<div></div>" }]),
      (w) => warnings.push(w),
    );
    const session = getSession()!;
    expect(session.modules.map((m) => m.moduleName)).toEqual(["hero"]);
    expect(warnings.some((w) => w.includes("incomplete"))).toBe(true);
  });

  it("drops a module with an empty moduleName", () => {
    parseAndApplyModules(respond([{ ...validModule, moduleName: "  " }]));
    expect(getSession()!.modules).toHaveLength(0);
  });

  it("never stores stringified undefined for fields/meta", () => {
    parseAndApplyModules(respond([{ moduleName: "ghost", moduleHtml: "x", moduleCss: "y" }]));
    const session = getSession()!;
    expect(session.modules).toHaveLength(0);
    for (const mod of session.modules) {
      expect(mod.fieldsJson).not.toBe("undefined");
      expect(mod.metaJson).not.toBe("undefined");
    }
  });

  it("stringifies object-valued fieldsJson/metaJson as before", () => {
    parseAndApplyModules(
      respond([{ ...validModule, fieldsJson: [{ name: "x", type: "text" }], metaJson: { label: "L" } }]),
    );
    const session = getSession()!;
    expect(session.modules).toHaveLength(1);
    expect(JSON.parse(session.modules[0].fieldsJson)).toEqual([{ name: "x", type: "text" }]);
    expect(JSON.parse(session.modules[0].metaJson)).toEqual({ label: "L" });
  });
});

// ---------------------------------------------------------------------------
// State-context budget
// ---------------------------------------------------------------------------

describe("buildStateContext budget (VIB-1855 / VIB-1894)", () => {
  let themeDir: string;

  beforeEach(() => {
    themeDir = mkdtempSync(join(tmpdir(), "vib1894-ctx-"));
    createSession(themeDir, "budget-theme");
  });

  afterEach(() => {
    rmSync(themeDir, { recursive: true, force: true });
  });

  it("stays near the budget even for few huge modules with shared CSS/JS", () => {
    const session = getSession()!;
    const huge = "x".repeat(150_000);
    session.modules = [1, 2].map((i) => ({
      moduleName: `big-${i}`,
      fieldsJson: huge,
      metaJson: "{}",
      moduleHtml: huge,
      moduleCss: huge,
      moduleJs: huge,
    }));
    session.sharedCss = huge;
    session.sharedJs = huge;

    const ctx = buildStateContext();
    // Pre-fix this reached ~4-6x the budget (each of the 4 sources per module
    // was clamped at the full per-module cap and shared CSS/JS rode free).
    expect(ctx.length).toBeLessThan(STATE_CONTEXT_CHAR_BUDGET * 1.2);
    // Sanity: the context still carries real module source.
    expect(ctx).toContain("big-1.module");
    expect(ctx).toContain("Shared CSS");
  });
});

// ---------------------------------------------------------------------------
// Upload auto-fix routing
// ---------------------------------------------------------------------------

describe("autoFixError routing (VIB-1894)", () => {
  let themeDir: string;

  beforeEach(() => {
    themeDir = mkdtempSync(join(tmpdir(), "vib1894-fix-"));
  });

  afterEach(() => {
    rmSync(themeDir, { recursive: true, force: true });
  });

  it('applies the color fix for the parser\'s "Color field..." message', () => {
    const modDir = join(themeDir, "modules", "hero.module");
    mkdirSync(modDir, { recursive: true });
    writeFileSync(
      join(modDir, "fields.json"),
      JSON.stringify([{ name: "bg", type: "color", default: { color: "rgba(15, 17, 21, 0.5)" } }]),
      "utf-8",
    );

    const fixed = autoFixError(themeDir, {
      file: "fields.json",
      message: "Color field has invalid format (rgba/rgb/named — must be hex)",
      fixable: true,
    });

    expect(fixed).toBe(true);
    const fields = JSON.parse(readFileSync(join(modDir, "fields.json"), "utf-8"));
    expect(fields[0].default.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("reaches the dnd_area_stylesheet fix (previously shadowed by the generic dnd branch)", () => {
    const tplDir = join(themeDir, "templates");
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(
      join(tplDir, "email.html"),
      "<!--\n templateType: email\n-->\n<head>{{ standard_header_includes }}</head>",
      "utf-8",
    );

    const fixed = autoFixError(themeDir, {
      file: "templates/email.html",
      message: "Missing dnd_area_stylesheet in email template",
      fixable: true,
    });

    expect(fixed).toBe(true);
    expect(readFileSync(join(tplDir, "email.html"), "utf-8")).toContain("{{ dnd_area_stylesheet }}");
  });

  it("still routes generic dnd-area errors to the name fix", () => {
    const tplDir = join(themeDir, "templates");
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(
      join(tplDir, "email.html"),
      '<!--\n templateType: email\n-->\n{% dnd_area "sidebar" %}{% end_dnd_area %}',
      "utf-8",
    );

    const fixed = autoFixError(themeDir, {
      file: "templates/email.html",
      message: 'Dnd area can only have name "main"',
      fixable: true,
    });

    expect(fixed).toBe(true);
    expect(readFileSync(join(tplDir, "email.html"), "utf-8")).toContain('"main"');
  });
});
