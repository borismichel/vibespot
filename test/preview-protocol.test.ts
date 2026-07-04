import { describe, it, expect } from "vitest";
import {
  PREVIEW_PROTOCOL_VERSION,
  PARENT_TO_PREVIEW,
  PREVIEW_TO_PARENT,
  makeEnvelope,
  parseEnvelope,
  isPreviewMode,
  type ParseOptions,
} from "../src/server/preview-protocol.js";

const TOKEN = "handshake-secret-abc123";

const asParent: ParseOptions = { expectedToken: TOKEN, accept: "preview->parent" };
const asPreview: ParseOptions = { expectedToken: TOKEN, accept: "parent->preview" };

describe("preview-protocol envelope", () => {
  it("round-trips a well-formed message", () => {
    const env = makeEnvelope(PREVIEW_TO_PARENT.READY, TOKEN, { hello: true });
    expect(env.v).toBe(PREVIEW_PROTOCOL_VERSION);
    const res = parseEnvelope<{ hello: boolean }>(env, asParent);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.envelope.type).toBe(PREVIEW_TO_PARENT.READY);
      expect(res.envelope.payload).toEqual({ hello: true });
    }
  });

  it("drops non-objects", () => {
    for (const bad of [null, undefined, "string", 42, true]) {
      const res = parseEnvelope(bad, asParent);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("not-object");
    }
  });

  it("drops a version mismatch", () => {
    const res = parseEnvelope({ v: 99, token: TOKEN, type: PREVIEW_TO_PARENT.READY }, asParent);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad-version");
  });

  it("drops a wrong / empty token", () => {
    const wrong = parseEnvelope(makeEnvelope(PREVIEW_TO_PARENT.READY, "nope"), asParent);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe("bad-token");

    // An empty expected token (pre-handshake) rejects even a matching-looking msg.
    const preHandshake = parseEnvelope(makeEnvelope(PREVIEW_TO_PARENT.READY, ""), {
      expectedToken: "",
      accept: "preview->parent",
    });
    expect(preHandshake.ok).toBe(false);
    if (!preHandshake.ok) expect(preHandshake.reason).toBe("bad-token");
  });

  it("drops an unknown verb", () => {
    const res = parseEnvelope({ v: 1, token: TOKEN, type: "vs:run-on-parent" }, asParent);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unknown-type");
  });

  it("rejects a known verb replayed in the wrong direction", () => {
    // A compromised frame replays a parent-only command back to the parent.
    const replay = parseEnvelope(makeEnvelope(PARENT_TO_PREVIEW.SET_MODE, TOKEN), asParent);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("wrong-direction");

    // ...and the parent's SET_MODE is legal *inbound* for the preview agent.
    const legit = parseEnvelope(makeEnvelope(PARENT_TO_PREVIEW.SET_MODE, TOKEN), asPreview);
    expect(legit.ok).toBe(true);
  });

  it("only the field-edit verbs can flow preview->parent as writes", () => {
    // Guardrail: the write vocabulary must never widen past field edits.
    const writeVerbs = Object.values(PREVIEW_TO_PARENT);
    expect(writeVerbs).toContain("vs:edit-commit");
    expect(writeVerbs).toContain("vs:field-commit");
    // No settings / upload / delete / git verb may exist in either direction.
    const allVerbs = [...Object.values(PARENT_TO_PREVIEW), ...Object.values(PREVIEW_TO_PARENT)];
    for (const forbidden of ["settings", "apikey", "upload", "delete", "git", "module-delete"]) {
      expect(allVerbs.some((v) => v.includes(forbidden))).toBe(false);
    }
  });

  it("vs:request-mode flows preview->parent only (Esc-to-exit ask, no write)", () => {
    // The agent may ask to drop back to view mode; the parent stays
    // authoritative (it answers with vs:set-mode). Inbound for the parent:
    const ask = parseEnvelope(makeEnvelope(PREVIEW_TO_PARENT.REQUEST_MODE, TOKEN, { mode: "view" }), asParent);
    expect(ask.ok).toBe(true);
    // ...but never legal parent->preview (that direction uses vs:set-mode).
    const replay = parseEnvelope(makeEnvelope(PREVIEW_TO_PARENT.REQUEST_MODE, TOKEN), asPreview);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("wrong-direction");
  });

  it("validates preview modes", () => {
    expect(isPreviewMode("view")).toBe(true);
    expect(isPreviewMode("interact")).toBe(true);
    expect(isPreviewMode("section")).toBe(true);
    expect(isPreviewMode("admin")).toBe(false);
    expect(isPreviewMode(undefined)).toBe(false);
  });
});
