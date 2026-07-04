/**
 * UI smoke harness (VIB-1917): boots the real ui/index.html plus every
 * first-party script in its production load order inside jsdom, with the
 * browser seams stubbed (fetch, WebSocket, vendor globals), then drives the
 * three core flows end-to-end at the DOM level:
 *
 *   - chat-send: composer -> ws {type:"chat"} + transcript bubble + send lock
 *   - checkpoint resolve: checkpoint_requested parks a gate card that locks
 *     the composer; approve/cancel resolve over the ws {type:"checkpoint_resolve"}
 *   - field-save: field-editor edits reach POST /api/field through the unified
 *     per-field-debounced save module (ui/field-save.js, VIB-1898)
 *
 * Unlike test/field-save.test.ts (module semantics in isolation), this file
 * exercises the wiring: real markup, real load order, real event listeners.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const uiDir = join(import.meta.dirname, "..", "ui");
const indexHtml = readFileSync(join(uiDir, "index.html"), "utf-8");

/** First-party <script src> entries from index.html, in load order. Vendor
 * bundles (marked, CodeMirror) are replaced by stubs — both are feature-
 * guarded in the UI (`typeof marked !== "undefined"`, "CodeMirror not
 * loaded") so the stubs only need to exist. */
const scriptFiles = Array.from(indexHtml.matchAll(/<script src="([^"]+)"><\/script>/g))
  .map((m) => m[1])
  .filter((src) => !src.startsWith("/vendor/"))
  .map((src) => src.replace(/^\//, "").split("?")[0]);

const scriptSources = scriptFiles.map((file) => ({
  file,
  code: readFileSync(join(uiDir, file), "utf-8"),
}));

type FetchCall = { url: string; method: string; body: unknown };

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  readyState = FakeWebSocket.OPEN;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
  /** Deliver a server->client message as the real socket would. */
  receive(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const HERO_FIELDS = [
  { name: "headline", label: "Headline", type: "text", default: "Hello" },
  { name: "subline", label: "Subline", type: "text", default: "World" },
];

const DEFAULT_ROUTES: Record<string, unknown> = {
  "/api/modules": {
    modules: [{ moduleName: "hero", fieldsJson: JSON.stringify(HERO_FIELDS) }],
  },
  // dashboard.js expects a bare array here and .filter()s it on load.
  "/api/fonts": [],
};

let activeDom: JSDOM | null = null;

afterEach(() => {
  activeDom?.window.close();
  activeDom = null;
});

function bootUi(routes: Record<string, unknown> = DEFAULT_ROUTES) {
  const dom = new JSDOM(indexHtml, {
    url: "http://127.0.0.1:4200/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  activeDom = dom;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = dom.window as any;

  const fetchCalls: FetchCall[] = [];
  const sockets: FakeWebSocket[] = [];

  win.WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  };

  win.fetch = (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    fetchCalls.push({ url, method: init?.method || "GET", body });
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const data = routes[path] ?? { ok: true };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(typeof data === "string" ? data : JSON.stringify(data)),
      headers: { get: () => null },
    });
  };

  // Browser APIs jsdom lacks; all no-op-safe for the flows under test.
  win.Element.prototype.scrollIntoView = () => {};
  win.matchMedia =
    win.matchMedia ||
    (() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
  win.ResizeObserver =
    win.ResizeObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  win.IntersectionObserver =
    win.IntersectionObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  win.marked = { parse: (s: string) => String(s) };

  for (const { file, code } of scriptSources) {
    try {
      win.eval(code);
    } catch (err) {
      throw new Error(`UI script ${file} failed to evaluate in jsdom: ${err}`);
    }
  }

  return { dom, win, fetchCalls, sockets };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Boot, connect the ws (as setup.js does after session create) and open it. */
function bootConnected() {
  const ctx = bootUi();
  ctx.win.connectWebSocket();
  const ws = ctx.sockets[ctx.sockets.length - 1];
  ws.onopen?.();
  return { ...ctx, ws };
}

function sendChat(win: any, text: string) {
  const input = win.document.getElementById("chat-input");
  input.value = text;
  win.document.getElementById("chat-send").click();
}

const DESIGN_CHECKPOINT = {
  type: "checkpoint_requested",
  estCostNext: 1.25,
  preview: {
    kind: "design",
    headline: "Review the design before building",
    data: {
      palette: [
        { label: "Primary", value: "#1a2b3c" },
        { label: "Accent", value: "#ff6600" },
      ],
      typography: { heading: "Inter", body: "Inter" },
    },
  },
};

describe("UI smoke harness — boot", () => {
  it("evaluates every first-party script from index.html without errors", () => {
    const { win } = bootUi();
    // Load-order sanity: the flows' entry points all landed on the window.
    expect(typeof win.connectWebSocket).toBe("function");
    expect(typeof win.sendMessage).toBe("function");
    expect(typeof win.resolveCheckpoint).toBe("function");
    expect(typeof win.openFieldEditor).toBe("function");
    expect(typeof win.saveFieldDebounced).toBe("function"); // unified module (VIB-1898)
    // Core surfaces exist in the markup the scripts wired up.
    for (const id of ["chat-messages", "chat-input", "chat-send", "field-editor-content", "preview-frame"]) {
      expect(win.document.getElementById(id), `#${id}`).toBeTruthy();
    }
  });
});

describe("UI smoke harness — chat-send", () => {
  it("send button pushes {type:'chat'} over the ws, renders the bubble, clears and locks the composer", async () => {
    const { win, ws } = bootConnected();
    sendChat(win, "Build me a landing page");
    await sleep(10);

    const chatMsgs = ws.sent.filter((m) => m.type === "chat");
    expect(chatMsgs).toEqual([{ type: "chat", message: "Build me a landing page" }]);

    const bubble = win.document.querySelector("#chat-messages .chat-msg--user .chat-msg__bubble");
    expect(bubble?.textContent).toBe("Build me a landing page");
    expect(win.document.getElementById("chat-input").value).toBe("");
    // Single-call streaming locks further sends until the run finishes.
    expect(win.document.getElementById("chat-send").disabled).toBe(true);
    sendChat(win, "second message");
    await sleep(10);
    expect(ws.sent.filter((m) => m.type === "chat")).toHaveLength(1);
  });

  it("does not send blank messages", async () => {
    const { win, ws } = bootConnected();
    sendChat(win, "   ");
    await sleep(10);
    expect(ws.sent).toHaveLength(0);
  });
});

describe("UI smoke harness — checkpoint resolve", () => {
  it("checkpoint_requested parks a gate card and locks the composer; approve resolves over the ws", async () => {
    const { win, ws } = bootConnected();
    sendChat(win, "Build me a landing page");
    await sleep(10);

    ws.receive(DESIGN_CHECKPOINT);
    const card = win.document.querySelector("#chat-messages .checkpoint");
    expect(card).toBeTruthy();
    expect(card.querySelector(".checkpoint__badge").textContent).toBe("Design checkpoint");
    expect(win.document.getElementById("chat-send").disabled).toBe(true);

    // The parked gate must also block the Enter/sendMessage path (VIB-1898).
    sendChat(win, "sneaky message during gate");
    await sleep(10);
    expect(ws.sent.filter((m) => m.type === "chat")).toHaveLength(1);

    card.querySelector('.checkpoint__btn[data-action="approve"]').click();
    await sleep(10);
    const resolves = ws.sent.filter((m) => m.type === "checkpoint_resolve");
    expect(resolves).toEqual([expect.objectContaining({ type: "checkpoint_resolve", action: "approve" })]);

    // The card became a static decision record in the transcript (VIB-1876)...
    const record = win.document.querySelector(".chat-msg--checkpoint-resolved");
    expect(record?.textContent).toContain("Design: approved");
    expect(record?.textContent).toContain("#1a2b3c");
    // ...and the composer stays locked while the build resumes.
    expect(win.document.getElementById("chat-send").disabled).toBe(true);
  });

  it("cancel resolves the gate and re-enables the composer", async () => {
    const { win, ws } = bootConnected();
    sendChat(win, "Build me a landing page");
    await sleep(10);
    ws.receive(DESIGN_CHECKPOINT);

    win.document.querySelector('.checkpoint__btn[data-action="cancel"]').click();
    await sleep(10);
    expect(ws.sent.filter((m) => m.type === "checkpoint_resolve")).toEqual([
      expect.objectContaining({ action: "cancel" }),
    ]);
    expect(win.document.querySelector(".chat-msg--checkpoint-resolved")?.textContent).toContain(
      "Design: cancelled",
    );
    expect(win.document.getElementById("chat-send").disabled).toBe(false);

    // The composer is genuinely live again: the next send goes through.
    sendChat(win, "start over");
    await sleep(10);
    expect(ws.sent.filter((m) => m.type === "chat").map((m) => m.message)).toEqual([
      "Build me a landing page",
      "start over",
    ]);
  });
});

describe("UI smoke harness — field-save (unified path, VIB-1898)", () => {
  function fieldPosts(fetchCalls: FetchCall[]) {
    return fetchCalls
      .filter((c) => c.url.endsWith("/api/field") && c.method === "POST")
      .map((c) => c.body as { moduleName: string; fieldPath: string; value: string });
  }

  async function openHeroEditor(win: any) {
    await win.openFieldEditor("hero");
    const inputs = win.document.querySelectorAll("#field-editor-content .field-input");
    expect(inputs).toHaveLength(HERO_FIELDS.length);
    return inputs as Array<{ value: string; dispatchEvent: (e: Event) => void }>;
  }

  function edit(win: any, input: { value: string; dispatchEvent: (e: Event) => void }, value: string) {
    input.value = value;
    input.dispatchEvent(new win.Event("change"));
  }

  it("edits to two different fields inside the debounce window both reach /api/field", async () => {
    const { win, fetchCalls } = bootUi();
    const [headline, subline] = await openHeroEditor(win);

    // The original data-loss bug: a shared debounce timer meant the second
    // edit cancelled the first field's save.
    edit(win, headline, "New headline");
    edit(win, subline, "New subline");
    await sleep(450);

    expect(fieldPosts(fetchCalls).sort((a, b) => a.fieldPath.localeCompare(b.fieldPath))).toEqual([
      { moduleName: "hero", fieldPath: "headline", value: "New headline" },
      { moduleName: "hero", fieldPath: "subline", value: "New subline" },
    ]);
  });

  it("rapid edits to the same field collapse to one POST with the latest value", async () => {
    const { win, fetchCalls } = bootUi();
    const [headline] = await openHeroEditor(win);

    edit(win, headline, "draft");
    edit(win, headline, "final");
    await sleep(450);

    expect(fieldPosts(fetchCalls)).toEqual([{ moduleName: "hero", fieldPath: "headline", value: "final" }]);
  });

  it("closing the editor flushes a pending debounced edit instead of dropping it", async () => {
    const { win, fetchCalls } = bootUi();
    const [headline] = await openHeroEditor(win);

    edit(win, headline, "typed then closed");
    win.closeFieldEditor(); // no 300ms wait — flushPendingFieldSaves fires now
    await sleep(50);

    expect(fieldPosts(fetchCalls)).toEqual([
      { moduleName: "hero", fieldPath: "headline", value: "typed then closed" },
    ]);
  });
});
