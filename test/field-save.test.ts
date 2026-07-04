/**
 * Unified field-save module (VIB-1898): ui/field-save.js is a plain classic
 * script, so it is evaluated in a function scope with fetch/refreshPreview/
 * timer stubs injected. Locks the semantics the three save surfaces rely on:
 * per-field debounce (editing field B never cancels field A's save), flush on
 * editor close, per-field POST ordering, and the refresh option.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "..", "ui", "field-save.js"), "utf-8");

type SaveApi = {
  saveField: (m: string, f: string, v: unknown, o?: Record<string, unknown>) => Promise<void>;
  saveFieldDebounced: (m: string, f: string, v: unknown, o?: Record<string, unknown>) => void;
  flushPendingFieldSaves: () => void;
};

function loadFieldSave(fetchImpl: typeof fetch, refreshPreview: () => void): SaveApi {
  const factory = new Function(
    "fetch",
    "refreshPreview",
    "setTimeout",
    "clearTimeout",
    `${src}\nreturn { saveField, saveFieldDebounced, flushPendingFieldSaves };`
  );
  return factory(
    fetchImpl,
    refreshPreview,
    (fn: () => void, ms: number) => setTimeout(fn, ms),
    (id: unknown) => clearTimeout(id as never)
  ) as SaveApi;
}

describe("ui/field-save.js — unified /api/field save path", () => {
  let posts: Array<{ moduleName: string; fieldPath: string; value: unknown }>;
  let refreshes: number;
  let api: SaveApi;

  beforeEach(() => {
    vi.useFakeTimers();
    posts = [];
    refreshes = 0;
    const fetchStub = ((_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true });
    }) as unknown as typeof fetch;
    api = loadFieldSave(fetchStub, () => { refreshes += 1; });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces per field — a second field's edit does not cancel the first", async () => {
    api.saveFieldDebounced("hero", "headline", "A");
    api.saveFieldDebounced("hero", "subline", "B"); // within the 300ms window
    await vi.advanceTimersByTimeAsync(300);
    expect(posts.map((p) => p.fieldPath).sort()).toEqual(["headline", "subline"]);
  });

  it("coalesces rapid edits to the SAME field to the latest value", async () => {
    api.saveFieldDebounced("hero", "headline", "first");
    api.saveFieldDebounced("hero", "headline", "second");
    await vi.advanceTimersByTimeAsync(300);
    expect(posts).toHaveLength(1);
    expect(posts[0].value).toBe("second");
  });

  it("flushPendingFieldSaves fires pending edits immediately (editor close)", async () => {
    api.saveFieldDebounced("hero", "headline", "typed-then-closed");
    api.flushPendingFieldSaves();
    await vi.runAllTimersAsync();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ moduleName: "hero", fieldPath: "headline" });
    // The debounce timer must not fire it a second time.
    await vi.advanceTimersByTimeAsync(300);
    expect(posts).toHaveLength(1);
  });

  it("an immediate save supersedes an older debounced value for the field", async () => {
    api.saveFieldDebounced("hero", "headline", "stale");
    await api.saveField("hero", "headline", "fresh");
    await vi.advanceTimersByTimeAsync(300);
    expect(posts).toHaveLength(1);
    expect(posts[0].value).toBe("fresh");
  });

  it("serializes POSTs to the same field so an older save can't land last", async () => {
    let releaseFirst!: () => void;
    const order: string[] = [];
    let call = 0;
    const gatedFetch = ((_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      call += 1;
      if (call === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => { order.push(body.value); resolve({ ok: true }); };
        });
      }
      order.push(body.value);
      return Promise.resolve({ ok: true });
    }) as unknown as typeof fetch;
    const gated = loadFieldSave(gatedFetch, () => {});

    const p1 = gated.saveField("hero", "headline", "v1", { refresh: false });
    const p2 = gated.saveField("hero", "headline", "v2", { refresh: false });
    // v2 must not POST while v1 is in flight.
    await Promise.resolve();
    expect(call).toBe(1);
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["v1", "v2"]);
  });

  it("refreshes the preview after a save unless refresh:false", async () => {
    await api.saveField("hero", "headline", "x");
    expect(refreshes).toBe(1);
    await api.saveField("hero", "headline", "y", { refresh: false });
    expect(refreshes).toBe(1);
  });

  it("a failed POST is swallowed and does not break later saves", async () => {
    let fail = true;
    const flaky = ((_url: string, init: { body: string }) => {
      if (fail) { fail = false; return Promise.reject(new Error("offline")); }
      posts.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true });
    }) as unknown as typeof fetch;
    const flakyApi = loadFieldSave(flaky, () => {});
    await flakyApi.saveField("hero", "headline", "lost", { refresh: false });
    await flakyApi.saveField("hero", "headline", "retry", { refresh: false });
    expect(posts.map((p) => p.value)).toEqual(["retry"]);
  });
});
