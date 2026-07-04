/**
 * Preview trust-boundary messaging protocol (VIB-1892).
 *
 * The live preview is being split onto a *separate origin* so AI-generated
 * page code can no longer reach the app origin's DOM, cookies, or `/api/*`
 * routes (the old `srcdoc` + `sandbox="allow-scripts allow-same-origin"`
 * combination inherited the parent origin, making the sandbox a no-op).
 *
 * With the split, the parent (app origin) and the trusted in-frame agent
 * (preview origin) can only talk over `window.postMessage`. This module is
 * the single shared contract both sides import: the message vocabulary, the
 * envelope shape, and the validation both ends MUST run on every message.
 *
 * Security invariants enforced here (see `parseEnvelope`):
 *  - the sender's `event.origin` must equal the expected peer origin;
 *  - the envelope must carry the per-session handshake token verbatim;
 *  - the `type` must be one of the allow-listed verbs below.
 * Anything else is dropped. The vocabulary is deliberately narrow — the only
 * write verbs are field edits, so a fully-compromised preview frame can at
 * most change a field value on the theme already open (the same blast radius
 * as a manual edit), never drive uploads / flip settings / exfil API keys.
 *
 * Keeping this as a dependency-free, framework-free module means it bundles
 * into both the server (tsup) and the browser (served verbatim) unchanged.
 */

/** Bumped only on a breaking change to the envelope or vocabulary. */
export const PREVIEW_PROTOCOL_VERSION = 1 as const;

/**
 * Parent (app origin) → Preview (in-frame agent). Coarse commands + display
 * state only — never per-mouse-move (local chrome handles high-frequency
 * interaction in-frame; see the VIB-1892 interaction rules).
 */
export const PARENT_TO_PREVIEW = {
  /** Handshake: parent hands the agent its session id + initial mode. */
  INIT: "vs:init",
  /** Switch interaction mode. */
  SET_MODE: "vs:set-mode",
  /** Glow/slide-in the just-regenerated / newly-added modules. */
  HIGHLIGHT_CHANGED: "vs:highlight-changed",
  /** Show the "working on it" overlay on the named modules. */
  MARK_WORKING: "vs:mark-working",
  /** Clear the working overlay (all, or the named subset). */
  CLEAR_WORKING: "vs:clear-working",
  /** Smooth-scroll the frame to a module. */
  SCROLL_TO: "vs:scroll-to",
} as const;

/**
 * Preview (in-frame agent) → Parent (app origin). The parent honours ONLY
 * these verbs; the sole write verbs are the field edits.
 */
export const PREVIEW_TO_PARENT = {
  /** Handshake ack — echoes the token so the parent can confirm the peer. */
  READY: "vs:ready",
  /** Whether the rendered doc has any `[data-module]` content. */
  EMPTY_STATE: "vs:empty-state",
  /** User picked a module (section mode). */
  SELECT_MODULE: "vs:select-module",
  /** Inline text/image/link edit committed by the user. */
  EDIT_COMMIT: "vs:edit-commit",
  /** Section-controls field change committed by the user. */
  FIELD_COMMIT: "vs:field-commit",
  /** Optional: report the rendered content height for frame auto-size. */
  CONTENT_HEIGHT: "vs:content-height",
} as const;

/** Valid interaction modes carried by `vs:init` / `vs:set-mode`. */
export const PREVIEW_MODES = ["view", "interact", "section"] as const;
export type PreviewMode = (typeof PREVIEW_MODES)[number];

export type ParentToPreviewType = (typeof PARENT_TO_PREVIEW)[keyof typeof PARENT_TO_PREVIEW];
export type PreviewToParentType = (typeof PREVIEW_TO_PARENT)[keyof typeof PREVIEW_TO_PARENT];
export type PreviewMessageType = ParentToPreviewType | PreviewToParentType;

const PARENT_TO_PREVIEW_TYPES: ReadonlySet<string> = new Set(Object.values(PARENT_TO_PREVIEW));
const PREVIEW_TO_PARENT_TYPES: ReadonlySet<string> = new Set(Object.values(PREVIEW_TO_PARENT));

/** The wire envelope. Every message — both directions — has this shape. */
export interface PreviewEnvelope<P = unknown> {
  /** Protocol version; a mismatch is dropped. */
  v: typeof PREVIEW_PROTOCOL_VERSION;
  /** Per-session handshake token, pinned on both ends. */
  token: string;
  /** One of the allow-listed `vs:*` verbs. */
  type: PreviewMessageType;
  /** Verb-specific payload (structurally-cloneable). */
  payload?: P;
}

/** Which direction of the vocabulary a `parseEnvelope` call should accept. */
export type ProtocolDirection = "parent->preview" | "preview->parent";

export interface ParseOptions {
  /** The token this end expects; a mismatch drops the message. */
  expectedToken: string;
  /**
   * Which verbs are legal *inbound* for this receiver. The parent accepts
   * only `preview->parent`; the agent accepts only `parent->preview`. This
   * stops a compromised frame from replaying a parent-only command back.
   */
  accept: ProtocolDirection;
}

export type ParseResult<P = unknown> =
  | { ok: true; envelope: PreviewEnvelope<P> }
  | { ok: false; reason: "not-object" | "bad-version" | "bad-token" | "unknown-type" | "wrong-direction" };

/**
 * Build a well-formed envelope. `token` and `type` are required so a caller
 * can never accidentally emit an unauthenticated or untyped message.
 */
export function makeEnvelope<P>(type: PreviewMessageType, token: string, payload?: P): PreviewEnvelope<P> {
  return { v: PREVIEW_PROTOCOL_VERSION, token, type, payload };
}

/**
 * Validate an inbound `MessageEvent.data`. Returns the typed envelope only
 * when version, token, and (direction-scoped) type all pass; otherwise a
 * discriminated reason the caller can log-and-drop.
 *
 * NOTE: the caller MUST already have compared `event.origin` to the expected
 * peer origin before calling this — origin is not on the envelope and cannot
 * be spoofed by frame content, so it is the primary gate. This function is
 * the second gate (token + vocabulary).
 */
export function parseEnvelope<P = unknown>(data: unknown, opts: ParseOptions): ParseResult<P> {
  if (typeof data !== "object" || data === null) return { ok: false, reason: "not-object" };
  const env = data as Record<string, unknown>;

  if (env.v !== PREVIEW_PROTOCOL_VERSION) return { ok: false, reason: "bad-version" };

  if (typeof env.token !== "string" || typeof opts.expectedToken !== "string") {
    return { ok: false, reason: "bad-token" };
  }
  // Exact match on a non-empty token. Both ends hold the same same-machine
  // local secret, so a plain === is sufficient; an empty expected token
  // (handshake not yet established) rejects everything.
  if (!opts.expectedToken || env.token !== opts.expectedToken) return { ok: false, reason: "bad-token" };

  if (typeof env.type !== "string") return { ok: false, reason: "unknown-type" };
  const legal = opts.accept === "parent->preview" ? PARENT_TO_PREVIEW_TYPES : PREVIEW_TO_PARENT_TYPES;
  if (!legal.has(env.type)) {
    // Distinguish "known verb, wrong direction" from "never a verb" so the
    // receiver can flag a replay/confused-deputy attempt distinctly.
    if (PARENT_TO_PREVIEW_TYPES.has(env.type) || PREVIEW_TO_PARENT_TYPES.has(env.type)) {
      return { ok: false, reason: "wrong-direction" };
    }
    return { ok: false, reason: "unknown-type" };
  }

  return { ok: true, envelope: { v: PREVIEW_PROTOCOL_VERSION, token: env.token, type: env.type as PreviewMessageType, payload: env.payload as P } };
}

/** True when `mode` is a valid `PreviewMode`. */
export function isPreviewMode(mode: unknown): mode is PreviewMode {
  return typeof mode === "string" && (PREVIEW_MODES as readonly string[]).includes(mode);
}
