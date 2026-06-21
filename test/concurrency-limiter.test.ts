/**
 * Cancellation-aware concurrency limiter tests (VIB-1880, barge-in).
 *
 * The limiter is the seam through which a barged-in run stops spawning new
 * module-generation calls. These guard that:
 *  1. With no signal it behaves exactly as before (bounded concurrency, FIFO).
 *  2. Once the signal aborts, queued-but-not-started tasks reject with a
 *     PipelineAbortError and never run.
 *  3. A task entering after the abort is rejected up front.
 *  4. isAbortError recognises our error, DOMException AbortError, and the
 *     Anthropic SDK's APIUserAbortError by name.
 */

import { describe, expect, it } from "vitest";
import {
  createConcurrencyLimiter,
  PipelineAbortError,
  isAbortError,
} from "../src/server/agent/types.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("createConcurrencyLimiter — concurrency", () => {
  it("never runs more than maxConcurrent tasks at once", async () => {
    const limit = createConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
      });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("createConcurrencyLimiter — cancellation (VIB-1880)", () => {
  it("rejects queued tasks that have not started once aborted", async () => {
    const controller = new AbortController();
    const limit = createConcurrencyLimiter(1, controller.signal);

    const started: number[] = [];
    const results: ("ok" | "aborted" | "other")[] = [];

    const run = (i: number) =>
      limit(async () => {
        started.push(i);
        await tick();
        return i;
      }).then(
        () => results.push("ok"),
        (err) => results.push(isAbortError(err) ? "aborted" : "other"),
      );

    // Fire 4 tasks at concurrency 1: #0 starts, #1–#3 queue.
    const all = [run(0), run(1), run(2), run(3)];
    // Abort while #0 is still in flight and the rest are queued.
    controller.abort();
    await Promise.all(all);

    // Only the first ever started; the queued ones were rejected as aborted.
    expect(started).toEqual([0]);
    expect(results.filter((r) => r === "aborted").length).toBe(3);
    expect(results).not.toContain("other");
  });

  it("rejects a task entering after the abort", async () => {
    const controller = new AbortController();
    const limit = createConcurrencyLimiter(4, controller.signal);
    controller.abort();
    await expect(limit(async () => 42)).rejects.toBeInstanceOf(PipelineAbortError);
  });

  it("runs normally when the signal never aborts", async () => {
    const controller = new AbortController();
    const limit = createConcurrencyLimiter(2, controller.signal);
    const out = await Promise.all([limit(async () => 1), limit(async () => 2)]);
    expect(out).toEqual([1, 2]);
  });
});

describe("isAbortError", () => {
  it("recognises PipelineAbortError", () => {
    expect(isAbortError(new PipelineAbortError())).toBe(true);
  });
  it("recognises a DOMException-style AbortError", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });
  it("recognises the Anthropic SDK APIUserAbortError by name", () => {
    const err = new Error("Request was aborted.");
    err.name = "APIUserAbortError";
    expect(isAbortError(err)).toBe(true);
  });
  it("does not flag an ordinary error", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
