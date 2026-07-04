/**
 * Regression coverage for the VIB-1895 agent-orchestration fixes:
 *  - CLI engine subprocesses honor the barge-in AbortSignal (killed immediately
 *    instead of burning tokens until the 10-minute timeout)
 *  - OpenAI/Gemini rate-limit (429) responses get the same backoff-retry the
 *    Anthropic path has, and an abort during the backoff stops the retry loop
 *  - the intent analyzer no longer clobbers contentType "blog" to "page"
 *    (the blog prompts/schema/validator were unreachable dead code)
 *  - module reuse materializes: the library entry's `module` payload is carried
 *    through the pipeline, so a planned "Reuse: hero" actually lands on the page
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import { spawnCLI } from "../src/server/ai-engines.js";
import { callAgentAPI } from "../src/server/agent/engine-adapter.js";
import { runAgentPipeline } from "../src/server/agent/pipeline.js";
import { isAbortError } from "../src/server/agent/types.js";
import type { SessionSnapshot } from "../src/server/session/types.js";

// ---------------------------------------------------------------------------
// CLI subprocess cancellation (engine-adapter → spawnCLI kill hook)
// ---------------------------------------------------------------------------

describe("spawnCLI abort signal", () => {
  it("kills the subprocess when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = spawnCLI("sleep", ["30"], "", undefined, undefined, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toSatisfy((err: unknown) => isAbortError(err));
    // Without the kill hook this would take 30s (or the 10-min default timeout).
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects up front when the signal is already aborted (never spawns)", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      spawnCLI("sleep", ["30"], "", undefined, undefined, controller.signal),
    ).rejects.toSatisfy((err: unknown) => isAbortError(err));
  });
});

// ---------------------------------------------------------------------------
// Rate-limit retry for OpenAI / Gemini (was Anthropic-only)
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

function openAIResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function geminiResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Stub fetch with a URL filter: `responses` are consumed (in order) only by
 * requests matching `apiUrlPart`; anything else (e.g. a Langfuse background
 * flush, which also goes through global fetch) gets a generic 200 and doesn't
 * pollute the call count.
 */
function stubApiFetch(apiUrlPart: string, responses: Response[]): () => number {
  let apiCalls = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(apiUrlPart)) {
      apiCalls++;
      return responses.length > 0 ? responses.shift()! : new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return () => apiCalls;
}

describe("rate-limit retry on non-Anthropic engines", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it("retries an OpenAI 429 with backoff instead of failing", async () => {
    vi.useFakeTimers();
    const apiCalls = stubApiFetch("api.openai.com", [
      new Response("rate limited", { status: 429 }),
      openAIResponse("hello after retry"),
    ]);

    const promise = callAgentAPI("openai-api", "test-key", "gpt-4o", {
      systemPrompt: "s",
      messages: [{ role: "user", content: "u" }],
    });
    // First backoff step is 10s.
    await vi.advanceTimersByTimeAsync(10_500);
    const result = await promise;
    expect(result).toMatchObject({ type: "text", text: "hello after retry" });
    expect(apiCalls()).toBe(2);
  });

  it("retries a Gemini 429 with backoff instead of failing", async () => {
    vi.useFakeTimers();
    const apiCalls = stubApiFetch("generativelanguage.googleapis.com", [
      new Response("rate limited", { status: 429 }),
      geminiResponse("gemini after retry"),
    ]);

    const promise = callAgentAPI("gemini-api", "test-key", "gemini-2.5-flash", {
      systemPrompt: "s",
      messages: [{ role: "user", content: "u" }],
    });
    await vi.advanceTimersByTimeAsync(10_500);
    const result = await promise;
    expect(result).toMatchObject({ type: "text", text: "gemini after retry" });
    expect(apiCalls()).toBe(2);
  });

  it("stops retrying when the run is aborted during the backoff wait", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const apiCalls = stubApiFetch("api.openai.com", [
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
    ]);

    const promise = callAgentAPI("openai-api", "test-key", "gpt-4o", {
      systemPrompt: "s",
      messages: [{ role: "user", content: "u" }],
      signal: controller.signal,
    });
    const rejection = expect(promise).rejects.toSatisfy((err: unknown) => isAbortError(err));
    // Abort mid-backoff (5s into the 10s wait) — the sleep wakes early and the
    // retry loop bails instead of issuing another request.
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(apiCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pipeline-level fixes, driven end-to-end through a stubbed OpenAI engine
// ---------------------------------------------------------------------------

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    modules: [],
    moduleOrder: [],
    sharedCss: "",
    sharedJs: "",
    messages: [],
    themeName: "test-theme",
    themePath: "/tmp/test-theme",
    ...overrides,
  } as SessionSnapshot;
}

/** Stub fetch so the intent-analyzer call returns the given plan. */
function stubIntentPlan(plan: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(openAIResponse(JSON.stringify(plan)));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("pipeline orchestration fixes", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('keeps contentType "blog" (previously clobbered to "page")', async () => {
    stubIntentPlan({
      intent: "question",
      contentType: "blog",
      affectedModules: [],
      unchangedModules: [],
      newModules: [],
      guidesNeeded: [],
      designSystemChanges: false,
      answer: "Blogs are supported.",
    });

    const { runIntentAnalyzer } = await import("../src/server/agent/stages/intent-analyzer.js");
    const plan = await runIntentAnalyzer(
      "make me a blog template",
      snapshot(),
      "openai-api",
      "test-key",
      "gpt-4o",
      () => {},
      [],
    );
    expect(plan.contentType).toBe("blog");
  });

  it("materializes a reused library module on the page", async () => {
    stubIntentPlan({
      intent: "add",
      contentType: "page",
      affectedModules: [],
      unchangedModules: [],
      newModules: [],
      reuseModules: [{ name: "library-hero", sourceTemplate: "Other page", position: 0 }],
      guidesNeeded: [],
      designSystemChanges: false,
    });

    const libraryHero = {
      moduleName: "library-hero",
      fieldsJson: "[]",
      metaJson: "{}",
      moduleHtml: "<h1>Reused hero</h1>",
      moduleCss: ".hero{}",
    };

    const result = await runAgentPipeline(
      "add the hero from my other page",
      snapshot(),
      "openai-api",
      "test-key",
      "gpt-4o",
      2,
      () => {},
      // The handler now passes the module payload along (the fix); previously
      // it sent {name, usedIn} only and the reuse silently vanished.
      [{ name: "library-hero", usedIn: ["Other page"], module: libraryHero }],
    );

    expect(result.modules.map((m) => m.moduleName)).toContain("library-hero");
    expect(result.moduleOrder).toContain("library-hero");
    const reused = result.modules.find((m) => m.moduleName === "library-hero");
    expect(reused?.moduleHtml).toBe("<h1>Reused hero</h1>");
  });
});
