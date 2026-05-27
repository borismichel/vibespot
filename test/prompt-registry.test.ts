/**
 * Stage-prompt registry tests (VIB-1769, Langfuse Phase 3).
 *
 * Guards three guarantees from the ticket:
 *  1. Externalizing the stage instruction prompts changed NOTHING — every
 *     builder renders byte-identical to the committed golden snapshot, on both
 *     the langfuse-bundled and the local-fallback source paths.
 *  2. Version pinning + allow-listed placeholders: a stale/mismatched/tampered
 *     bundle silently falls back to the local copy (a Langfuse outage can't
 *     change generation behavior).
 *  3. No untrusted interpolation: substitution is single-pass and never
 *     re-expands an inserted value.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildIntentAnalyzerPrompt } from "../src/server/agent/prompts/intent-analyzer.js";
import {
  buildDesignSystemPrompt,
  buildModulePlannerPrompt,
} from "../src/server/agent/prompts/page-architect.js";
import { buildSiteModulePlannerPrompt } from "../src/server/agent/prompts/site-module-planner.js";
import { buildModuleDeveloperPrompt } from "../src/server/agent/prompts/module-developer.js";
import {
  getStagePrompt,
  renderStagePrompt,
  _resetPromptBundleCache,
  _setPromptBundleForTest,
  type PromptBundle,
} from "../src/server/agent/prompts/registry.js";
import { LOCAL_STAGE_PROMPTS } from "../src/server/agent/prompts/managed/local-prompts.js";
import { buildGoldenCases } from "./prompt-golden-cases.js";

const GOLDEN: Record<string, string> = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/prompt-golden.json"), "utf8"),
);

const cases = buildGoldenCases({
  buildIntentAnalyzerPrompt,
  buildDesignSystemPrompt,
  buildModulePlannerPrompt,
  buildSiteModulePlannerPrompt,
  buildModuleDeveloperPrompt,
});

/** A valid bundle built from the in-code defaults (mirrors `sync --from-local`). */
function seedBundle(): PromptBundle {
  const prompts: PromptBundle["prompts"] = {};
  for (const [id, p] of Object.entries(LOCAL_STAGE_PROMPTS)) {
    prompts[id] = { version: p.version, label: "local", placeholders: p.placeholders, template: p.template };
  }
  return { generatedAt: "test", source: "local-seed", prompts };
}

afterEach(() => {
  _setPromptBundleForTest(undefined);
  _resetPromptBundleCache();
});

describe("golden: builders are byte-identical after externalization", () => {
  describe("local-fallback source (no bundle)", () => {
    for (const c of cases) {
      it(c.id, () => {
        _setPromptBundleForTest(null);
        expect(c.render()).toBe(GOLDEN[c.id]);
      });
    }
  });

  describe("langfuse-bundled source (seed bundle)", () => {
    for (const c of cases) {
      it(c.id, () => {
        _setPromptBundleForTest(seedBundle());
        expect(c.render()).toBe(GOLDEN[c.id]);
      });
    }
  });

  it("committed disk bundle (assets/prompts.bundle.json) also yields the golden output", () => {
    // No override → registry loads the shipped bundle from disk.
    _setPromptBundleForTest(undefined);
    _resetPromptBundleCache();
    for (const c of cases) expect(c.render(), c.id).toBe(GOLDEN[c.id]);
  });
});

describe("source selection + version pinning", () => {
  it("uses the bundle when version matches the pin", () => {
    _setPromptBundleForTest(seedBundle());
    const sel = getStagePrompt("module-developer");
    expect(sel.source).toBe("langfuse-bundled");
  });

  it("falls back to local when the bundle is absent", () => {
    _setPromptBundleForTest(null);
    expect(getStagePrompt("module-developer").source).toBe("local-fallback");
  });

  it("falls back to local on a version mismatch", () => {
    const b = seedBundle();
    b.prompts["module-developer"].version = 999; // pin is 1
    _setPromptBundleForTest(b);
    const sel = getStagePrompt("module-developer");
    expect(sel.source).toBe("local-fallback");
    expect(sel.version).toBe(LOCAL_STAGE_PROMPTS["module-developer"].version);
  });

  it("falls back to local when the bundle references a disallowed placeholder", () => {
    const b = seedBundle();
    b.prompts["module-developer"].template += " {{evilInjected}}";
    _setPromptBundleForTest(b);
    expect(getStagePrompt("module-developer").source).toBe("local-fallback");
  });

  it("per-prompt fallback: missing id uses local, present id uses bundle", () => {
    const b = seedBundle();
    delete b.prompts["intent-analyzer"];
    _setPromptBundleForTest(b);
    expect(getStagePrompt("intent-analyzer").source).toBe("local-fallback");
    expect(getStagePrompt("module-developer").source).toBe("langfuse-bundled");
  });
});

describe("no untrusted interpolation", () => {
  it("substitution is single-pass: an inserted value is never re-expanded", () => {
    _setPromptBundleForTest(null);
    // themeName value itself contains a token; it must appear verbatim, once.
    const out = renderStagePrompt("module-developer", { themeName: "{{themeName}}" });
    expect(out).toContain('## Theme: "{{themeName}}"');
    // The literal sentinel proves no recursive expansion happened.
    expect(out).toContain("{{themeName}}");
  });

  it("unknown tokens in vars are ignored (only allow-listed keys substitute)", () => {
    _setPromptBundleForTest(null);
    const out = renderStagePrompt("module-developer", {
      themeName: "acme",
      notAllowed: "SHOULD_NOT_APPEAR",
    } as Record<string, string>);
    expect(out).not.toContain("SHOULD_NOT_APPEAR");
    expect(out).toContain("acme-");
  });

  it("every local template only references its declared placeholders", () => {
    const tokenRe = /\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g;
    for (const [id, p] of Object.entries(LOCAL_STAGE_PROMPTS)) {
      const used = new Set([...p.template.matchAll(tokenRe)].map((m) => m[1]));
      for (const t of used) expect(p.placeholders, `${id}:${t}`).toContain(t);
    }
  });
});
