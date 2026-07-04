/**
 * Protocol parity (VIB-1892): the browser ends of the preview channel are
 * plain classic scripts (no bundler), so they carry their own copies of the
 * vs:* verb strings. This test locks those copies to the canonical protocol
 * module — if a verb is added/renamed in one place but not the others, this
 * fails before drift can ship.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARENT_TO_PREVIEW, PREVIEW_TO_PARENT } from "../src/server/preview-protocol.js";

const uiDir = join(import.meta.dirname, "..", "ui");
const agentSrc = readFileSync(join(uiDir, "preview-agent.js"), "utf-8");
const parentSrc = readFileSync(join(uiDir, "preview.js"), "utf-8");

function verbsIn(src: string): Set<string> {
  return new Set(Array.from(src.matchAll(/"(vs:[a-z-]+)"/g), (m) => m[1]));
}

const parentVerbs = Object.values(PARENT_TO_PREVIEW) as string[];
const previewVerbs = Object.values(PREVIEW_TO_PARENT) as string[];
const allVerbs = new Set([...parentVerbs, ...previewVerbs]);

describe("preview protocol parity (server <-> browser copies)", () => {
  it("the in-frame agent knows every parent->preview verb", () => {
    const found = verbsIn(agentSrc);
    for (const verb of parentVerbs) {
      expect(found.has(verb), `agent missing ${verb}`).toBe(true);
    }
  });

  it("the agent emits only real preview->parent verbs", () => {
    // Every vs:* string in the agent must exist in the protocol vocabulary.
    for (const verb of verbsIn(agentSrc)) {
      expect(allVerbs.has(verb), `agent uses unknown verb ${verb}`).toBe(true);
    }
  });

  it("the parent dispatches every preview->parent verb and nothing else", () => {
    const found = verbsIn(parentSrc);
    for (const verb of found) {
      expect(allVerbs.has(verb), `parent uses unknown verb ${verb}`).toBe(true);
    }
    // The parent's inbound allow-list must cover the full preview->parent set.
    for (const verb of previewVerbs) {
      expect(found.has(verb), `parent missing ${verb}`).toBe(true);
    }
  });

  it("write verbs stay capped at field edits (no privileged verb sneaks in)", () => {
    for (const verb of [...verbsIn(agentSrc), ...verbsIn(parentSrc)]) {
      expect(verb).not.toMatch(/setting|apikey|upload|delete|git|deploy|token/);
    }
  });
});
