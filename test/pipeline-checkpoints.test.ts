/**
 * Pipeline checkpoint seam coverage (VIB-1916, child of VIB-1913).
 *
 * `src/server/agent/pipeline.ts` was previously only exercised through the
 * cancel path (test/checkpoint-resume-durable.test.ts). These tests drive the
 * full park/resume state machine with every stage mocked — no model calls:
 *
 *  - gating in `runAgentPipeline`: brand-intake vs design park, the
 *    `hasStyleSystem` skip, the email/no-checkpoint one-shot paths, the
 *    question short-circuit, the CLI-binary guard, and `estCostNext`
 *  - `resumeAgentPipeline`: approve/steer/skip/cancel at the design,
 *    structure, and brand-intake gates; resume-token lifecycle (consumed on
 *    re-entry); fallbackState rehydration beyond cancel (VIB-1883)
 *  - abort seams: `PipelineAbortError` between stages (VIB-1880) and the
 *    AbortSignal threading into Stage 3
 *  - `applyStructureEdits` edge cases beyond test/structure-preview.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/server/agent/stages/intent-analyzer.js", () => ({
  runIntentAnalyzer: vi.fn(),
}));
vi.mock("../src/server/agent/stages/page-architect.js", () => ({
  runPageArchitect: vi.fn(),
  runDesignSystem: vi.fn(),
  runModulePlanner: vi.fn(),
}));
vi.mock("../src/server/agent/stages/site-module-planner.js", () => ({
  runSiteModulePlanner: vi.fn(),
}));
vi.mock("../src/server/agent/stages/module-developer.js", () => ({
  runModuleDeveloper: vi.fn(),
}));
vi.mock("../src/server/agent/stages/validator.js", () => ({
  validateModules: vi.fn(),
  validateNavLinks: vi.fn(() => []),
}));
vi.mock("../src/server/agent/brand-intake.js", () => ({
  routeBrandIntake: vi.fn(),
}));
vi.mock("../src/server/cost-tracker.js", () => ({
  peekCurrentCost: vi.fn(() => null),
}));
vi.mock("../src/server/langfuse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/langfuse.js")>();
  return {
    ...actual,
    runWithSpan: vi.fn((_name: string, fn: () => unknown) => fn()),
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execSync: vi.fn(actual.execSync) };
});

import { execSync } from "node:child_process";
import {
  runAgentPipeline,
  resumeAgentPipeline,
  discardCheckpoint,
} from "../src/server/agent/pipeline.js";
import { applyStructureEdits } from "../src/server/agent/structure-preview.js";
import { runIntentAnalyzer } from "../src/server/agent/stages/intent-analyzer.js";
import {
  runPageArchitect,
  runDesignSystem,
  runModulePlanner,
} from "../src/server/agent/stages/page-architect.js";
import { runModuleDeveloper } from "../src/server/agent/stages/module-developer.js";
import { validateModules } from "../src/server/agent/stages/validator.js";
import { routeBrandIntake } from "../src/server/agent/brand-intake.js";
import { peekCurrentCost } from "../src/server/cost-tracker.js";
import { PipelineAbortError } from "../src/server/agent/types.js";
import type {
  PipelinePlan,
  PageBlueprint,
  DesignSystemOutput,
  PipelineEvent,
  PipelineResult,
  CheckpointResolution,
} from "../src/server/agent/types.js";
import type { SessionSnapshot } from "../src/server/session/types.js";
import type { ModuleFiles } from "../src/ai/engine.js";
import type { AgentEngine } from "../src/server/agent/engine-adapter.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    modules: [],
    moduleOrder: [],
    sharedCss: "",
    sharedJs: "",
    messages: [],
    themeName: "test-theme",
    themePath: "/tmp/test-theme",
    ...over,
  };
}

function makePlan(over: Partial<PipelinePlan> = {}): PipelinePlan {
  return {
    intent: "create",
    contentType: "page",
    affectedModules: [],
    unchangedModules: [],
    newModules: [],
    guidesNeeded: ["design"],
    designSystemChanges: true,
    ...over,
  };
}

function makeDS(over: Partial<DesignSystemOutput> = {}): DesignSystemOutput {
  return {
    cssVariables: { "--accent": "#111111" },
    sharedCss: ":root{--accent:#111111}",
    sharedJs: "",
    aesthetic: "clean",
    ...over,
  };
}

function makeBlueprint(over: Partial<PageBlueprint> = {}): PageBlueprint {
  return {
    designSystem: { cssVariables: { "--accent": "#111111" }, sharedCss: ":root{--accent:#111111}", sharedJs: "" },
    modules: [
      { name: "hero", description: "Hero", contentBrief: "Big headline", layoutNotes: "Full-bleed" },
      { name: "features", description: "Features", contentBrief: "Three cards", layoutNotes: "Grid" },
      { name: "footer", description: "Footer", contentBrief: "Links", layoutNotes: "Slim" },
    ],
    moduleOrder: ["hero", "features", "footer"],
    narrative: "A landing page.",
    ...over,
  };
}

function makeModule(name: string): ModuleFiles {
  return {
    moduleName: name,
    fieldsJson: "[]",
    metaJson: "{}",
    moduleHtml: `<div>${name}</div>`,
    moduleCss: "",
  };
}

const ENGINE: AgentEngine = "anthropic";

function runPipeline(opts: {
  snapshot?: SessionSnapshot;
  checkpoints?: boolean;
  signal?: AbortSignal;
  events?: PipelineEvent[];
  message?: string;
  engine?: AgentEngine;
} = {}): Promise<PipelineResult> {
  const events = opts.events ?? [];
  return runAgentPipeline(
    opts.message ?? "build me a landing page",
    opts.snapshot ?? makeSnapshot(),
    opts.engine ?? ENGINE,
    "test-key",
    "test-model",
    4,
    (e) => events.push(e),
    [],
    opts.checkpoints ?? true,
    opts.signal,
  );
}

function resume(
  token: string,
  resolution: CheckpointResolution,
  opts: {
    snapshot?: SessionSnapshot;
    signal?: AbortSignal;
    events?: PipelineEvent[];
    fallbackState?: Parameters<typeof resumeAgentPipeline>[9];
  } = {},
): Promise<PipelineResult> {
  const events = opts.events ?? [];
  return resumeAgentPipeline(
    token,
    resolution,
    opts.snapshot ?? makeSnapshot(),
    ENGINE,
    "test-key",
    "test-model",
    4,
    (e) => events.push(e),
    opts.signal,
    opts.fallbackState,
  );
}

/** Park a run at the design gate and return its resume token. */
async function parkAtDesign(): Promise<{ token: string; result: PipelineResult }> {
  const result = await runPipeline({ snapshot: makeSnapshot({ sharedCss: ":root{--x:1}" }) });
  expect(result.pendingCheckpoint?.kind).toBe("design");
  return { token: result.pendingCheckpoint!.resumeToken, result };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runIntentAnalyzer).mockResolvedValue(makePlan());
  vi.mocked(runDesignSystem).mockResolvedValue(makeDS());
  vi.mocked(runModulePlanner).mockResolvedValue(makeBlueprint());
  vi.mocked(runPageArchitect).mockResolvedValue(makeBlueprint());
  vi.mocked(runModuleDeveloper).mockImplementation(async (_msg, specs) =>
    specs.map((s) => ({ moduleName: s.name, module: makeModule(s.name) })),
  );
  vi.mocked(validateModules).mockImplementation((mods) =>
    mods.map((m) => ({ module: m, issues: [], valid: true })),
  );
  vi.mocked(peekCurrentCost).mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// runAgentPipeline gating
// ---------------------------------------------------------------------------

describe("runAgentPipeline — checkpoint gating", () => {
  it("parks at brand_intake when creating with no style system (VIB-1878)", async () => {
    const events: PipelineEvent[] = [];
    const result = await runPipeline({ events });

    const pending = result.pendingCheckpoint;
    expect(pending?.kind).toBe("brand_intake");
    expect(pending?.resumeToken).toMatch(/^cp_/);
    // Cheapest seam: no design system has been built yet.
    expect(runDesignSystem).not.toHaveBeenCalled();
    expect(runModuleDeveloper).not.toHaveBeenCalled();
    expect(pending?.resumeState?.kind).toBe("brand_intake");
    expect(pending?.resumeState && "designSystem" in pending.resumeState && pending.resumeState.designSystem).toBeFalsy();

    const gate = events.find((e) => e.type === "checkpoint_requested");
    expect(gate).toMatchObject({ kind: "brand_intake" });
    expect(result.stats.modulesGenerated).toBe(0);
    expect(result.modules).toEqual([]);
  });

  it("skips brand intake when sharedCss already declares :root and parks at design", async () => {
    const events: PipelineEvent[] = [];
    const result = await runPipeline({
      snapshot: makeSnapshot({ sharedCss: ":root{--old:1}" }),
      events,
    });

    expect(runDesignSystem).toHaveBeenCalledTimes(1);
    const pending = result.pendingCheckpoint;
    expect(pending?.kind).toBe("design");
    expect(pending?.preview.kind).toBe("design");
    expect(pending?.resumeState?.kind).toBe("design");
    expect(pending?.resumeState && "designSystem" in pending.resumeState ? pending.resumeState.designSystem : undefined).toEqual(makeDS());
    // Parked shared CSS is the freshly designed one, not the snapshot's.
    expect(result.sharedCss).toBe(makeDS().sharedCss);
    // No estimate available (peekCurrentCost → null) ⇒ estCostNext omitted.
    const gate = events.find((e) => e.type === "checkpoint_requested");
    expect(gate && "estCostNext" in gate ? gate.estCostNext : undefined).toBeUndefined();
  });

  it("skips brand intake when a styleguide brand asset exists", async () => {
    const result = await runPipeline({
      snapshot: makeSnapshot({ brandAssets: { styleguide: "# Brand" } }),
    });
    expect(result.pendingCheckpoint?.kind).toBe("design");
  });

  it("raises the brand-intake gate only for create — a modify run parks at design", async () => {
    vi.mocked(runIntentAnalyzer).mockResolvedValue(
      makePlan({ intent: "modify", designSystemChanges: true }),
    );
    // No style system, but intent !== create ⇒ straight to the design gate.
    const result = await runPipeline({});
    expect(result.pendingCheckpoint?.kind).toBe("design");
  });

  it("never gates email runs even with checkpoints enabled", async () => {
    vi.mocked(runIntentAnalyzer).mockResolvedValue(makePlan({ contentType: "email" }));
    const result = await runPipeline({});
    expect(result.pendingCheckpoint).toBeUndefined();
    expect(runPageArchitect).toHaveBeenCalledTimes(1);
    expect(runModuleDeveloper).toHaveBeenCalledTimes(1);
    expect(result.modules.map((m) => m.moduleName)).toEqual(["hero", "features", "footer"]);
  });

  it("builds straight through when checkpoints are disabled (one-shot)", async () => {
    const events: PipelineEvent[] = [];
    const result = await runPipeline({ checkpoints: false, events });

    expect(result.pendingCheckpoint).toBeUndefined();
    expect(runDesignSystem).not.toHaveBeenCalled(); // one-shot uses the combined architect
    expect(runPageArchitect).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "blueprint_ready")).toBe(true);
    expect(events.some((e) => e.type === "pipeline_complete")).toBe(true);
    expect(result.moduleOrder).toEqual(["hero", "features", "footer"]);
  });

  it("short-circuits question intents without touching architect or build", async () => {
    vi.mocked(runIntentAnalyzer).mockResolvedValue(
      makePlan({ intent: "question", answer: "It already does that." }),
    );
    const events: PipelineEvent[] = [];
    const result = await runPipeline({ events });

    expect(result.assistantMessage).toBe("It already does that.");
    expect(runPageArchitect).not.toHaveBeenCalled();
    expect(runDesignSystem).not.toHaveBeenCalled();
    expect(runModuleDeveloper).not.toHaveBeenCalled();
    const done = events.find((e) => e.type === "pipeline_complete");
    expect(done && "answer" in done ? done.answer : undefined).toBe("It already does that.");
  });

  it("rejects a CLI engine whose binary is missing, before any stage runs", async () => {
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw new Error("not found");
    });
    await expect(runPipeline({ engine: "claude-code" })).rejects.toThrow(
      /requires "claude"/,
    );
    expect(runIntentAnalyzer).not.toHaveBeenCalled();
  });

  it("projects estCostNext from spend-so-far × stage-3 multiplier", async () => {
    vi.mocked(peekCurrentCost).mockReturnValue({
      costUsd: 0.5,
    } as ReturnType<typeof peekCurrentCost>);
    const events: PipelineEvent[] = [];
    await runPipeline({ snapshot: makeSnapshot({ sharedCss: ":root{--x:1}" }), events });

    const gate = events.find((e) => e.type === "checkpoint_requested");
    expect(gate && "estCostNext" in gate ? gate.estCostNext : undefined).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Design gate resume
// ---------------------------------------------------------------------------

describe("resumeAgentPipeline — design gate", () => {
  it("approve runs the module planner and re-parks at the structure gate", async () => {
    const { token } = await parkAtDesign();

    const result = await resume(token, { kind: "design", action: "approve" });

    expect(runModulePlanner).toHaveBeenCalledTimes(1);
    // Planner receives the parked design system, not a fresh one.
    expect(vi.mocked(runModulePlanner).mock.calls[0][3]).toEqual(makeDS());
    expect(runModuleDeveloper).not.toHaveBeenCalled();

    const pending = result.pendingCheckpoint;
    expect(pending?.kind).toBe("structure");
    expect(pending?.resumeState?.kind).toBe("structure");
    expect(
      pending?.resumeState && "blueprint" in pending.resumeState
        ? pending.resumeState.blueprint.moduleOrder
        : undefined,
    ).toEqual(["hero", "features", "footer"]);
  });

  it("consumes the resume token on re-entry — a second resume is expired", async () => {
    const { token } = await parkAtDesign();
    await resume(token, { kind: "design", action: "approve" });

    await expect(resume(token, { kind: "design", action: "approve" })).rejects.toThrow(
      /expired/,
    );
  });

  it("skip suppresses the structure gate and builds straight through", async () => {
    const { token } = await parkAtDesign();
    const events: PipelineEvent[] = [];

    const result = await resume(token, { kind: "design", action: "skip" }, { events });

    expect(runModulePlanner).toHaveBeenCalledTimes(1);
    expect(runModuleDeveloper).toHaveBeenCalledTimes(1);
    expect(result.pendingCheckpoint).toBeUndefined();
    expect(result.modules.map((m) => m.moduleName)).toEqual(["hero", "features", "footer"]);
    expect(events.some((e) => e.type === "blueprint_ready")).toBe(true);
    expect(events.some((e) => e.type === "pipeline_complete")).toBe(true);
  });

  it("steer re-runs ONLY the design system with the note and re-parks", async () => {
    const { token } = await parkAtDesign();
    const steered = makeDS({ cssVariables: { "--accent": "#222222" }, sharedCss: ":root{--accent:#222222}" });
    vi.mocked(runDesignSystem).mockResolvedValue(steered);

    const result = await resume(token, { kind: "design", action: "steer", note: "darker, more contrast" });

    // The park itself called runDesignSystem once; steer calls it again.
    expect(runDesignSystem).toHaveBeenCalledTimes(2);
    const steeredMessage = vi.mocked(runDesignSystem).mock.calls[1][0];
    expect(steeredMessage).toContain("build me a landing page");
    expect(steeredMessage).toContain("## Design steer");
    expect(steeredMessage).toContain("darker, more contrast");
    expect(runModulePlanner).not.toHaveBeenCalled();

    const pending = result.pendingCheckpoint;
    expect(pending?.kind).toBe("design");
    expect(pending?.resumeToken).not.toBe(token); // old token discarded, new park
    expect(result.sharedCss).toBe(steered.sharedCss);
  });

  it("steer with an empty note re-runs with the original message unchanged", async () => {
    const { token } = await parkAtDesign();
    await resume(token, { kind: "design", action: "steer", note: "   " });
    expect(vi.mocked(runDesignSystem).mock.calls[1][0]).toBe("build me a landing page");
  });

  it("cancel discards the parked run and its token", async () => {
    const { token } = await parkAtDesign();
    const result = await resume(token, { kind: "design", action: "cancel" });

    expect(result.canceled).toBe(true);
    expect(result.assistantMessage).toContain("Cancelled");
    expect(runModulePlanner).not.toHaveBeenCalled();
    await expect(resume(token, { kind: "design", action: "approve" })).rejects.toThrow(/expired/);
  });

  it("discardCheckpoint drops a parked token so a later resume is expired", async () => {
    const { token } = await parkAtDesign();
    discardCheckpoint(token);
    await expect(resume(token, { kind: "design", action: "approve" })).rejects.toThrow(/expired/);
  });

  it("rehydrates from fallbackState for a real (non-cancel) resume after restart (VIB-1883)", async () => {
    // Token the in-memory store has never seen — simulates a fresh process; the
    // state persisted on the session is handed back as fallbackState.
    const result = await resume(
      "cp_restarted_process",
      { kind: "design", action: "approve" },
      {
        fallbackState: {
          kind: "design",
          userMessage: "build me a landing page",
          plan: makePlan(),
          designSystem: makeDS(),
          sharedCss: makeDS().sharedCss,
          sharedJs: "",
          startTime: 1_700_000_000_000,
          libraryModules: [],
        },
      },
    );
    expect(runModulePlanner).toHaveBeenCalledTimes(1);
    expect(result.pendingCheckpoint?.kind).toBe("structure");
  });

  it("errors clearly when a design-kind state is missing its design system", async () => {
    await expect(
      resume(
        "cp_corrupt_state",
        { kind: "design", action: "approve" },
        {
          fallbackState: {
            kind: "design",
            userMessage: "build me a landing page",
            plan: makePlan(),
            // designSystem absent — corrupted / hand-rolled state
            sharedCss: "",
            sharedJs: "",
            startTime: 1_700_000_000_000,
            libraryModules: [],
          },
        },
      ),
    ).rejects.toThrow(/missing its design system/);
  });
});

// ---------------------------------------------------------------------------
// Structure gate resume
// ---------------------------------------------------------------------------

/** Park at design, approve, and return the structure gate's token. */
async function parkAtStructure(): Promise<string> {
  const { token } = await parkAtDesign();
  const result = await resume(token, { kind: "design", action: "approve" });
  expect(result.pendingCheckpoint?.kind).toBe("structure");
  return result.pendingCheckpoint!.resumeToken;
}

describe("resumeAgentPipeline — structure gate", () => {
  it("approve with an edited outline builds exactly the kept rows, in order", async () => {
    const token = await parkAtStructure();

    const result = await resume(token, {
      kind: "structure",
      action: "approve",
      // Reorder features first, rename hero, cut footer.
      outline: [
        { name: "features", sourceIndex: 1 },
        { name: "main-hero", sourceIndex: 0 },
      ],
    });

    expect(runModuleDeveloper).toHaveBeenCalledTimes(1);
    const specs = vi.mocked(runModuleDeveloper).mock.calls[0][1];
    expect(specs.map((s) => s.name)).toEqual(["features", "main-hero"]);
    // Rename keeps the planned brief (sourceIndex mapping).
    expect(specs[1].contentBrief).toBe("Big headline");
    expect(result.moduleOrder).toEqual(["features", "main-hero"]);
    expect(result.pendingCheckpoint).toBeUndefined();
  });

  it("approve without an outline builds the planned blueprint as-is", async () => {
    const token = await parkAtStructure();
    const result = await resume(token, { kind: "structure", action: "approve" });

    expect(result.moduleOrder).toEqual(["hero", "features", "footer"]);
    expect(result.stats.modulesGenerated).toBe(3);
  });

  it("steer re-plans ONLY the structure with the note and re-parks", async () => {
    const token = await parkAtStructure();
    const replanned = makeBlueprint({
      modules: [
        { name: "hero", description: "Hero", contentBrief: "Big headline", layoutNotes: "Full-bleed" },
        { name: "pricing", description: "Pricing", contentBrief: "Tiers", layoutNotes: "Cards" },
      ],
      moduleOrder: ["hero", "pricing"],
    });
    vi.mocked(runModulePlanner).mockResolvedValue(replanned);

    const result = await resume(token, { kind: "structure", action: "steer", note: "add a pricing section" });

    // Once for the design-approve park, once for the steer re-plan.
    expect(runModulePlanner).toHaveBeenCalledTimes(2);
    const steeredMessage = vi.mocked(runModulePlanner).mock.calls[1][0];
    expect(steeredMessage).toContain("## Structure steer");
    expect(steeredMessage).toContain("add a pricing section");
    expect(runModuleDeveloper).not.toHaveBeenCalled();

    const pending = result.pendingCheckpoint;
    expect(pending?.kind).toBe("structure");
    expect(pending?.resumeToken).not.toBe(token);
    expect(
      pending?.resumeState && "blueprint" in pending.resumeState
        ? pending.resumeState.blueprint.moduleOrder
        : undefined,
    ).toEqual(["hero", "pricing"]);
  });

  it("cancel at the structure gate drops the run without building", async () => {
    const token = await parkAtStructure();
    const result = await resume(token, { kind: "structure", action: "cancel" });
    expect(result.canceled).toBe(true);
    expect(runModuleDeveloper).not.toHaveBeenCalled();
  });

  it("threads the barge-in AbortSignal into the Stage-3 build (VIB-1880)", async () => {
    const token = await parkAtStructure();
    const ac = new AbortController();

    await resume(token, { kind: "structure", action: "approve" }, { signal: ac.signal });

    // Signal is the last runModuleDeveloper parameter — the limiter and the
    // provider requests hang off it.
    expect(vi.mocked(runModuleDeveloper).mock.calls[0][12]).toBe(ac.signal);
  });
});

// ---------------------------------------------------------------------------
// Brand-intake gate resume (VIB-1878)
// ---------------------------------------------------------------------------

/** Park a create-run with no style system at the brand-intake gate. */
async function parkAtBrandIntake(): Promise<string> {
  const result = await runPipeline({});
  expect(result.pendingCheckpoint?.kind).toBe("brand_intake");
  return result.pendingCheckpoint!.resumeToken;
}

describe("resumeAgentPipeline — brand-intake gate", () => {
  it("skip (Surprise me) builds a plain design system and re-parks at design", async () => {
    const token = await parkAtBrandIntake();
    const snapshot = makeSnapshot();

    const result = await resume(token, { kind: "brand_intake", action: "skip" }, { snapshot });

    expect(routeBrandIntake).not.toHaveBeenCalled();
    expect(runDesignSystem).toHaveBeenCalledTimes(1);
    // Un-seeded: the design system sees the original snapshot.
    expect(vi.mocked(runDesignSystem).mock.calls[0][2]).toBe(snapshot);

    const pending = result.pendingCheckpoint;
    expect(pending?.kind).toBe("design");
    expect(pending?.resumeState?.kind).toBe("design");
    expect(result.brandAssetsUpdate).toBeUndefined();
  });

  it("approve (Bring your brand) seeds the design system and merges brand tokens, brand wins", async () => {
    const token = await parkAtBrandIntake();
    vi.mocked(routeBrandIntake).mockResolvedValue({
      cssVariables: { "--accent": "#ff0000", "--brand-x": "#00ff00" },
      rootCss: ":root{--accent:#ff0000;--brand-x:#00ff00}",
      styleguide: "## Brand brief",
      brandvoice: "friendly",
      channels: ["colors"],
    });
    const events: PipelineEvent[] = [];
    const intake = { colors: "#ff0000 #00ff00" };

    const result = await resume(
      token,
      { kind: "brand_intake", action: "approve", brandIntake: intake },
      { events },
    );

    expect(routeBrandIntake).toHaveBeenCalledWith(intake);

    // The design system runs against a brand-seeded snapshot copy.
    const seeded = vi.mocked(runDesignSystem).mock.calls[0][2];
    expect(seeded.sharedCss).toBe(":root{--accent:#ff0000;--brand-x:#00ff00}");
    expect(seeded.brandAssets?.styleguide).toContain("## Brand brief");
    expect(seeded.brandAssets?.brandvoice).toBe("friendly");

    // Re-parked at design with the brand tokens merged in — brand wins over
    // the model's "--accent", and the override :root block is appended.
    const pending = result.pendingCheckpoint;
    expect(pending?.kind).toBe("design");
    const ds =
      pending?.resumeState && "designSystem" in pending.resumeState
        ? pending.resumeState.designSystem
        : undefined;
    expect(ds?.cssVariables["--accent"]).toBe("#ff0000");
    expect(ds?.cssVariables["--brand-x"]).toBe("#00ff00");
    expect(ds?.sharedCss).toContain("Brand intake overrides");

    // Derived brand assets ride back for the handler to persist.
    expect(result.brandAssetsUpdate).toEqual({
      styleguide: "## Brand brief",
      brandvoice: "friendly",
    });
    expect(
      events.some(
        (e) => e.type === "agent_decision" && e.decision.includes("Brand intake: using colors"),
      ),
    ).toBe(true);
  });

  it("approve with no usable channels tells the user and falls back to a generated design", async () => {
    const token = await parkAtBrandIntake();
    vi.mocked(routeBrandIntake).mockResolvedValue({
      cssVariables: {},
      rootCss: "",
      channels: [],
    });
    const events: PipelineEvent[] = [];
    const snapshot = makeSnapshot();

    const result = await resume(
      token,
      { kind: "brand_intake", action: "approve", brandIntake: { siteUrl: "https://js-only.example" } },
      { events, snapshot },
    );

    expect(
      events.some(
        (e) =>
          e.type === "agent_decision" &&
          e.decision.includes("couldn't extract usable design tokens"),
      ),
    ).toBe(true);
    // No seeding happened — the design system sees the original snapshot.
    expect(vi.mocked(runDesignSystem).mock.calls[0][2]).toBe(snapshot);
    expect(result.brandAssetsUpdate).toBeUndefined();
    expect(result.pendingCheckpoint?.kind).toBe("design");
  });

  it("cancel at the brand-intake gate drops the run before any design work", async () => {
    const token = await parkAtBrandIntake();
    const result = await resume(token, { kind: "brand_intake", action: "cancel" });
    expect(result.canceled).toBe(true);
    expect(runDesignSystem).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Abort seams (VIB-1880)
// ---------------------------------------------------------------------------

describe("PipelineAbortError seam checks", () => {
  it("bails with PipelineAbortError right after intent when the signal aborted mid-flight", async () => {
    const ac = new AbortController();
    vi.mocked(runIntentAnalyzer).mockImplementation(async () => {
      ac.abort(); // barge-in lands while the intent call is in flight
      return makePlan();
    });

    await expect(runPipeline({ signal: ac.signal, checkpoints: false })).rejects.toBeInstanceOf(
      PipelineAbortError,
    );
    expect(runPageArchitect).not.toHaveBeenCalled();
    expect(runModuleDeveloper).not.toHaveBeenCalled();
  });

  it("bails after the architect, before Stage 3, when aborted during planning", async () => {
    const ac = new AbortController();
    vi.mocked(runPageArchitect).mockImplementation(async () => {
      ac.abort();
      return makeBlueprint();
    });

    await expect(runPipeline({ signal: ac.signal, checkpoints: false })).rejects.toBeInstanceOf(
      PipelineAbortError,
    );
    expect(runPageArchitect).toHaveBeenCalledTimes(1);
    expect(runModuleDeveloper).not.toHaveBeenCalled();
  });

  it("does not abort when no signal is provided", async () => {
    const result = await runPipeline({ checkpoints: false });
    expect(result.stats.modulesGenerated).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// applyStructureEdits edge cases (beyond test/structure-preview.test.ts)
// ---------------------------------------------------------------------------

describe("applyStructureEdits — edge cases", () => {
  it("treats a stale out-of-range sourceIndex as a hand-added row", () => {
    const bp = makeBlueprint();
    const edited = applyStructureEdits(bp, [
      { name: "hero", sourceIndex: 0 },
      { name: "mystery-section", sourceIndex: 99 }, // stale index from an old preview
    ]);
    expect(edited.modules.map((m) => m.name)).toEqual(["hero", "mystery-section"]);
    // No planned brief to recover — seeded with the generic one.
    expect(edited.modules[1].contentBrief).toContain("Generate appropriate content");
  });

  it("drops a stale-index row whose name sanitizes to nothing, falling back to the original blueprint when all rows drop", () => {
    const bp = makeBlueprint();
    // Not resolvable to a planned module AND no usable name → incomplete add.
    const edited = applyStructureEdits(bp, [{ name: "???", sourceIndex: 42 }]);
    expect(edited).toBe(bp);
  });

  it("keeps the planned name and brief when a sourced row is renamed to nothing", () => {
    const bp = makeBlueprint();
    const edited = applyStructureEdits(bp, [{ name: "", sourceIndex: 1 }]);
    expect(edited.modules).toHaveLength(1);
    expect(edited.modules[0].name).toBe("features");
    expect(edited.modules[0].contentBrief).toBe("Three cards");
  });

  it("falls back to the planned description only when the row's is nullish (?? semantics)", () => {
    const bp = makeBlueprint();
    const edited = applyStructureEdits(bp, [
      { name: "hero", sourceIndex: 0 }, // description undefined → planned one
      { name: "features", sourceIndex: 1, description: "" }, // explicit "" is kept
    ]);
    expect(edited.modules[0].description).toBe("Hero");
    expect(edited.modules[1].description).toBe("");
  });

  it("keeps two rows mapping to the same planned module when renamed apart", () => {
    const bp = makeBlueprint();
    const edited = applyStructureEdits(bp, [
      { name: "hero-top", sourceIndex: 0 },
      { name: "hero-bottom", sourceIndex: 0 },
    ]);
    expect(edited.modules.map((m) => m.name)).toEqual(["hero-top", "hero-bottom"]);
    // Both clones inherit the planned brief.
    expect(edited.modules[0].contentBrief).toBe("Big headline");
    expect(edited.modules[1].contentBrief).toBe("Big headline");
  });

  it("rebuilds moduleOrder from the outline, ignoring the original order entirely", () => {
    const bp = makeBlueprint({ moduleOrder: ["footer", "hero", "features"] });
    const edited = applyStructureEdits(bp, [
      { name: "features", sourceIndex: 1 },
      { name: "hero", sourceIndex: 0 },
    ]);
    expect(edited.moduleOrder).toEqual(["features", "hero"]);
    expect(edited.moduleOrder).not.toContain("footer");
  });
});
