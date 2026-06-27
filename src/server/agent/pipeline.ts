/**
 * Agentic Pipeline Orchestrator
 *
 * Runs the 4-stage pipeline:
 * 1. Intent Analyzer — classify request, plan modules
 * 2. Page Architect — design system + module specs (new pages / design changes only)
 * 3. Module Developer — parallel per-module generation
 * 4. Validator — rule-based checks + auto-fix
 */

import type { ModuleFiles } from "../../ai/engine.js";
import type { SessionSnapshot } from "../session/types.js";
import type { AgentEngine } from "./engine-adapter.js";
import { isCLIEngine } from "./engine-adapter.js";
import type {
  PipelineEvent,
  PipelineResult,
  MultiPagePipelineResult,
  ModuleSpec,
  PageBlueprint,
  PipelinePlan,
  DesignSystemOutput,
  CheckpointResolution,
  CheckpointPreview,
  CheckpointKind,
} from "./types.js";
import { PipelineAbortError } from "./types.js";
import { runIntentAnalyzer } from "./stages/intent-analyzer.js";
import { runPageArchitect, runDesignSystem, runModulePlanner } from "./stages/page-architect.js";
import { runSiteModulePlanner } from "./stages/site-module-planner.js";
import { runModuleDeveloper } from "./stages/module-developer.js";
import { validateModules, validateNavLinks } from "./stages/validator.js";
import { buildDesignPreview, buildBrandIntakePreview } from "./design-preview.js";
import { routeBrandIntake } from "./brand-intake.js";
import { buildStructurePreview, applyStructureEdits } from "./structure-preview.js";
import { peekCurrentCost } from "../cost-tracker.js";
import { log } from "../log.js";
import { runWithSpan } from "../langfuse.js";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Checkpoint gate resume store (VIB-1877)
//
// When the pipeline parks at a gate it returns immediately (no dangling
// promise) and stashes the state needed to continue here, keyed by an opaque
// resume token. `resumeAgentPipeline` looks it up on the user's resolution.
// In-memory by design: an unresolved gate is dropped if the server restarts
// (the session's `pendingCheckpoint` is likewise treated as stale on reload).
// ---------------------------------------------------------------------------

/** Stage 3 (parallel module build) dominates total spend; design+intent are a
 * small fraction. Used to project the spend a user avoids by cancelling. */
const STAGE3_COST_MULTIPLIER = 6;

/**
 * Parked at the design gate (Stage 2a). `brand_intake` (VIB-1878) also uses
 * this shape and sits in front of `design` (VIB-1877): resolving brand intake
 * produces a design system and re-parks at the design gate, so `designSystem`
 * is absent at the brand-intake park and set by the time we reach `design`.
 */
interface DesignCheckpointState {
  kind: "design" | "brand_intake";
  /** Enriched user message used by this run. */
  userMessage: string;
  plan: PipelinePlan;
  /** Design system produced before the gate (Stage 2a). Absent at brand intake. */
  designSystem?: DesignSystemOutput;
  /** Finalized shared CSS/JS (with :root injected). */
  sharedCss: string;
  sharedJs: string;
  startTime: number;
  libraryModules: { name: string; usedIn: string[] }[];
}

/**
 * Parked at the structure gate (VIB-1879): the module planner (Stage 2b) has
 * run, so we carry the full blueprint plus the design system needed to re-plan
 * on steer. The user's edited outline (if any) is folded in on resume.
 */
interface StructureCheckpointState {
  kind: "structure";
  userMessage: string;
  plan: PipelinePlan;
  designSystem: DesignSystemOutput;
  blueprint: PageBlueprint;
  sharedCss: string;
  sharedJs: string;
  startTime: number;
  libraryModules: { name: string; usedIn: string[] }[];
}

type CheckpointResumeState = DesignCheckpointState | StructureCheckpointState;

const checkpointResumeStore = new Map<string, CheckpointResumeState>();

function newResumeToken(): string {
  return `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Discard a parked checkpoint's resume state (on cancel or after re-entry). */
export function discardCheckpoint(resumeToken: string): void {
  checkpointResumeStore.delete(resumeToken);
}

/** Project the USD spend the gate guards (Stage 3). Undefined for CLI engines
 * (no usage reported → no cost accumulated), per the event contract. */
function estimateGatedCost(): number | undefined {
  const spent = peekCurrentCost();
  if (!spent || spent.costUsd <= 0) return undefined;
  return Math.round(spent.costUsd * STAGE3_COST_MULTIPLIER * 100) / 100;
}

export { isAgenticCapable, isCLIEngine } from "./engine-adapter.js";

/**
 * Run the full agentic pipeline for a user message.
 *
 * @param userMessage  The user's chat message
 * @param snapshot     Immutable copy of session state at pipeline start
 * @param engine       Which API engine to use
 * @param apiKey       API key for the engine
 * @param model        Model ID
 * @param concurrency  Max parallel module generation calls
 * @param onEvent      Callback for pipeline progress events (WebSocket)
 * @param libraryModules  Modules available for reuse from other templates
 */
export async function runAgentPipeline(
  userMessage: string,
  snapshot: SessionSnapshot,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  concurrency: number,
  onEvent: (event: PipelineEvent) => void,
  libraryModules: { name: string; usedIn: string[] }[],
  checkpointsEnabled = false,
  signal?: AbortSignal,
): Promise<PipelineResult> {
  const startTime = Date.now();

  // All engines use the configured concurrency (default 20, cap in ai-handler)
  const effectiveConcurrency = concurrency;

  if (isCLIEngine(engine)) {
    const binMap: Record<string, string> = {
      "claude-code": "claude",
      "gemini-cli": "gemini",
      "codex-cli": "codex",
    };
    const bin = binMap[engine];
    if (bin) {
      try {
        execSync(`command -v ${bin}`, { stdio: "ignore" });
      } catch {
        throw new Error(
          `CLI engine "${engine}" requires "${bin}" to be installed and on your PATH.`,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Stage 1: Intent Analyzer
  // -----------------------------------------------------------------------

  const plan = await runIntentAnalyzer(
    userMessage,
    snapshot,
    engine,
    apiKey,
    model,
    onEvent,
    libraryModules,
  );

  // Barge-in (VIB-1880): a newer message may have aborted this run while the
  // intent call was in flight — bail before any expensive architect/build work.
  if (signal?.aborted) throw new PipelineAbortError();

  // Short-circuit for questions
  if (plan.intent === "question" && plan.answer) {
    const durationMs = Date.now() - startTime;
    onEvent({
      type: "pipeline_complete",
      modulesGenerated: 0,
      modulesUnchanged: snapshot.modules.length,
      durationMs,
      answer: plan.answer,
    });
    return {
      modules: [...snapshot.modules],
      moduleOrder: snapshot.moduleOrder as string[],
      sharedCss: snapshot.sharedCss,
      sharedJs: snapshot.sharedJs,
      assistantMessage: plan.answer,
      stats: {
        modulesGenerated: 0,
        modulesUnchanged: snapshot.modules.length,
        modulesFailed: 0,
        durationMs,
      },
    };
  }

  // Multi-page site creation uses a separate flow
  if (plan.intent === "create_site" && plan.pages && plan.pages.length > 0) {
    return runMultiPageFlow(
      userMessage,
      plan,
      snapshot,
      engine,
      apiKey,
      model,
      concurrency,
      onEvent,
      startTime,
      signal,
    );
  }

  // -----------------------------------------------------------------------
  // Stage 2: Page Architect (new pages or design system changes)
  // -----------------------------------------------------------------------

  let blueprint: PageBlueprint | null = null;
  let sharedCss = snapshot.sharedCss;
  let sharedJs = snapshot.sharedJs;

  const needsArchitect =
    plan.intent === "create" || plan.designSystemChanges;

  if (needsArchitect) {
    // -----------------------------------------------------------------------
    // Design checkpoint (VIB-1877): when checkpoints are on, split the
    // architect at the design seam. Run only Stage 2a (cheap design system),
    // then PARK — return at the gate with a palette/type/hero preview before
    // committing to the expensive parallel module build. The user's
    // approve/steer/skip/cancel re-enters via `resumeAgentPipeline`.
    // Email has no shared CSS to preview, so it never gates here.
    // -----------------------------------------------------------------------
    if (checkpointsEnabled && plan.contentType !== "email") {
      // ---------------------------------------------------------------------
      // Brand-intake gate (VIB-1878): the FRONT-of-flow ask-back. Fires only
      // when creating a page that has no style system yet — no styleguide and
      // no `:root` in the shared CSS. An imported theme or a prior session
      // already carries a style system, so we use it and skip the ask
      // (Boris-locked). The user picks "Surprise me" (AI invents — today's
      // behavior) or "Bring your brand" (intake → seed the design system).
      // ---------------------------------------------------------------------
      if (plan.intent === "create" && !hasStyleSystem(snapshot)) {
        return parkAtBrandIntakeCheckpoint(
          { kind: "brand_intake", userMessage, plan, sharedCss, sharedJs, startTime, libraryModules },
          snapshot,
          onEvent,
        );
      }

      const ds = await runDesignSystem(
        userMessage,
        plan,
        snapshot,
        engine,
        apiKey,
        model,
        onEvent,
      );
      return parkAtDesignCheckpoint(
        { kind: "design", userMessage, plan, designSystem: ds, sharedCss: ds.sharedCss, sharedJs: ds.sharedJs || sharedJs, startTime, libraryModules },
        snapshot,
        onEvent,
      );
    }

    // Stage 2 runs two sequential calls (one-shot path, no gate):
    // 2a: Design System (CSS vars + shared CSS/JS) — emits design_system_ready
    // 2b: Module Planner (module specs + order) — uses the finalized CSS
    blueprint = await runPageArchitect(
      userMessage,
      plan,
      snapshot,
      engine,
      apiKey,
      model,
      onEvent,
    );
    if (plan.contentType !== "email") {
      sharedCss = blueprint.designSystem.sharedCss || sharedCss;
      sharedJs = blueprint.designSystem.sharedJs || sharedJs;
    }

    // Notify client of module order for incremental preview placeholders
    onEvent({
      type: "blueprint_ready",
      moduleOrder: blueprint.moduleOrder,
      sharedCss,
      sharedJs,
    });
  }

  // Barge-in (VIB-1880): bail if aborted during the architect, before Stage 3.
  if (signal?.aborted) throw new PipelineAbortError();

  return runBuildPhase(
    userMessage,
    plan,
    snapshot,
    blueprint,
    sharedCss,
    sharedJs,
    engine,
    apiKey,
    model,
    effectiveConcurrency,
    onEvent,
    libraryModules,
    startTime,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Checkpoint park / resume (VIB-1877)
// ---------------------------------------------------------------------------

/**
 * Stash resume state and return a paused result carrying the gate's preview.
 * The handler persists `pendingCheckpoint` on the session and stops — no
 * modules are built, nothing is committed, until the user resolves the gate.
 * Shared by every seam (design, structure, …); the only per-seam difference is
 * which preview the caller hands in.
 */
function parkAtCheckpoint(
  kind: CheckpointKind,
  state: CheckpointResumeState,
  preview: CheckpointPreview,
  snapshot: SessionSnapshot,
  onEvent: (event: PipelineEvent) => void,
): PipelineResult {
  const resumeToken = newResumeToken();
  checkpointResumeStore.set(resumeToken, state);

  const estCostNext = estimateGatedCost();

  onEvent({
    type: "checkpoint_requested",
    kind,
    preview,
    ...(estCostNext != null ? { estCostNext } : {}),
  });

  return {
    modules: [...snapshot.modules],
    moduleOrder: snapshot.moduleOrder as string[],
    sharedCss: state.sharedCss,
    sharedJs: state.sharedJs,
    assistantMessage: "",
    contentType: state.plan.contentType,
    stats: { modulesGenerated: 0, modulesUnchanged: snapshot.modules.length, modulesFailed: 0, durationMs: Date.now() - state.startTime },
    pendingCheckpoint: {
      kind,
      resumeToken,
      preview,
      createdAt: new Date().toISOString(),
    },
  };
}

/** Park at the design seam (Stage 2a done) with the palette/type/hero preview. */
function parkAtDesignCheckpoint(
  state: DesignCheckpointState,
  snapshot: SessionSnapshot,
  onEvent: (event: PipelineEvent) => void,
): PipelineResult {
  // A design park always carries a design system (brand_intake re-parks here
  // with one set before this call); narrows the optional field for the preview.
  if (!state.designSystem) {
    throw new Error("Cannot park at the design checkpoint without a design system.");
  }
  return parkAtCheckpoint("design", state, buildDesignPreview(state.designSystem), snapshot, onEvent);
}

/** Park at the structure seam (Stage 2b done) with the editable module outline. */
function parkAtStructureCheckpoint(
  state: StructureCheckpointState,
  snapshot: SessionSnapshot,
  onEvent: (event: PipelineEvent) => void,
): PipelineResult {
  return parkAtCheckpoint("structure", state, buildStructurePreview(state.blueprint), snapshot, onEvent);
}

/**
 * True when the session already has a style system to build on (VIB-1878):
 * an extracted styleguide (imported-theme brand enrichment) or shared CSS that
 * already declares `:root` variables (a prior session / starter). When true,
 * the brand-intake ask-back is skipped and that style system is used.
 */
function hasStyleSystem(snapshot: SessionSnapshot): boolean {
  if (snapshot.brandAssets?.styleguide && snapshot.brandAssets.styleguide.trim()) return true;
  if (snapshot.sharedCss && snapshot.sharedCss.includes(":root")) return true;
  return false;
}

/**
 * Park at the brand-intake gate (VIB-1878). No design system has been built
 * yet — this is the cheapest possible seam. The card offers "Surprise me" vs
 * "Bring your brand"; the resolution re-enters via `resumeAgentPipeline`.
 */
function parkAtBrandIntakeCheckpoint(
  state: CheckpointResumeState,
  snapshot: SessionSnapshot,
  onEvent: (event: PipelineEvent) => void,
): PipelineResult {
  const resumeToken = newResumeToken();
  checkpointResumeStore.set(resumeToken, state);

  const preview = buildBrandIntakePreview();
  const estCostNext = estimateGatedCost();

  onEvent({
    type: "checkpoint_requested",
    kind: "brand_intake",
    preview,
    ...(estCostNext != null ? { estCostNext } : {}),
  });

  return {
    modules: [...snapshot.modules],
    moduleOrder: snapshot.moduleOrder as string[],
    sharedCss: state.sharedCss,
    sharedJs: state.sharedJs,
    assistantMessage: "",
    contentType: state.plan.contentType,
    stats: { modulesGenerated: 0, modulesUnchanged: snapshot.modules.length, modulesFailed: 0, durationMs: Date.now() - state.startTime },
    pendingCheckpoint: {
      kind: "brand_intake",
      resumeToken,
      preview,
      createdAt: new Date().toISOString(),
    },
  };
}

/**
 * Resolve the brand-intake gate (VIB-1878). Always advances to the design gate:
 * builds a design system (brand-seeded for "Bring your brand", plain for
 * "Surprise me"), then parks at the design checkpoint via the C1 primitive.
 */
async function resumeBrandIntake(
  resumeToken: string,
  state: CheckpointResumeState,
  resolution: CheckpointResolution,
  snapshot: SessionSnapshot,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  onEvent: (event: PipelineEvent) => void,
): Promise<PipelineResult> {
  discardCheckpoint(resumeToken);

  // "Bring your brand" = approve with channels. Anything else (skip / steer /
  // empty intake) is "Surprise me" — let the AI invent the design system.
  const intake = resolution.action === "approve" ? resolution.brandIntake : undefined;
  let brandSnapshot = snapshot;
  let brandAssetsUpdate: PipelineResult["brandAssetsUpdate"];
  let brand: Awaited<ReturnType<typeof routeBrandIntake>> | null = null;

  if (intake) {
    brand = await routeBrandIntake(intake);
    if (brand.channels.length > 0) {
      // Merge the brand brief into the styleguide the design prompt reads, and
      // seed the brand voice. Persisted by the handler via brandAssetsUpdate.
      const mergedStyleguide = [snapshot.brandAssets?.styleguide, brand.styleguide]
        .filter((s) => s && s.trim())
        .join("\n\n");
      brandAssetsUpdate = {
        ...(mergedStyleguide ? { styleguide: mergedStyleguide } : {}),
        ...(brand.brandvoice ? { brandvoice: brand.brandvoice } : {}),
      };
      brandSnapshot = {
        ...snapshot,
        brandAssets: {
          ...snapshot.brandAssets,
          ...(mergedStyleguide ? { styleguide: mergedStyleguide } : {}),
          ...(brand.brandvoice ? { brandvoice: brand.brandvoice } : {}),
        },
        sharedCss: brand.rootCss || snapshot.sharedCss,
      };
      onEvent({
        type: "agent_decision",
        step: "designing",
        decision: `Brand intake: using ${brand.channels.join(", ")} → ${Object.keys(brand.cssVariables).length} brand token(s)`,
      });
    } else {
      // User chose "Bring your brand" but no channel yielded usable tokens (e.g.
      // a JS-rendered site that ships no fetchable CSS). Tell them instead of
      // silently falling back to a generated palette (VIB-1876 follow-up).
      onEvent({
        type: "agent_decision",
        step: "designing",
        decision:
          "Brand intake: couldn't extract usable design tokens from what you provided — generating a design system instead. Try pasting your brand colors or CSS directly.",
      });
    }
  }

  const ds = await runDesignSystem(
    state.userMessage,
    state.plan,
    brandSnapshot,
    engine,
    apiKey,
    model,
    onEvent,
  );

  // Guarantee the brand `:root` is honored regardless of the model's output:
  // merge the brand tokens (brand wins) so the design checkpoint renders them,
  // and append a brand override block so they win the cascade in the built page.
  if (brand && Object.keys(brand.cssVariables).length > 0) {
    ds.cssVariables = { ...(ds.cssVariables || {}), ...brand.cssVariables };
    if (brand.rootCss && !ds.sharedCss.includes(brand.rootCss.trim())) {
      ds.sharedCss = `${ds.sharedCss}\n\n/* Brand intake overrides (VIB-1878) */\n${brand.rootCss}`;
    }
  }

  const parked = parkAtDesignCheckpoint(
    {
      kind: "design",
      userMessage: state.userMessage,
      plan: state.plan,
      designSystem: ds,
      sharedCss: ds.sharedCss,
      sharedJs: ds.sharedJs || state.sharedJs,
      startTime: state.startTime,
      libraryModules: state.libraryModules,
    },
    snapshot,
    onEvent,
  );
  if (brandAssetsUpdate) parked.brandAssetsUpdate = brandAssetsUpdate;
  return parked;
}

/**
 * Re-enter a parked pipeline at whichever seam it stopped at, with the user's
 * resolution. Three seams exist:
 *
 * Brand-intake gate (VIB-1878): resolves to a design system (brand-seeded for
 * "Bring your brand", plain for "Surprise me") and re-parks at the design gate.
 *
 * Design gate (VIB-1877): approve → run the Module Planner, then PARK at the
 * structure gate; skip → run the planner and build straight through (suppress
 * the next gate); steer → re-run ONLY the design system and re-park; cancel →
 * drop.
 *
 * Structure gate (VIB-1879): approve/skip → fold the user's edited outline into
 * the blueprint and build; steer → re-run ONLY the module planner with the note
 * and re-park; cancel → drop.
 */
export async function resumeAgentPipeline(
  resumeToken: string,
  resolution: CheckpointResolution,
  snapshot: SessionSnapshot,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  concurrency: number,
  onEvent: (event: PipelineEvent) => void,
  signal?: AbortSignal,
): Promise<PipelineResult> {
  const state = checkpointResumeStore.get(resumeToken);
  if (!state) {
    throw new Error("This checkpoint has expired (the server may have restarted). Send your request again to start over.");
  }

  // Cancel: discard the parked run. Nothing is built. (Same for every seam.)
  if (resolution.action === "cancel") {
    discardCheckpoint(resumeToken);
    return {
      modules: [...snapshot.modules],
      moduleOrder: snapshot.moduleOrder as string[],
      sharedCss: snapshot.sharedCss,
      sharedJs: snapshot.sharedJs,
      assistantMessage: "Cancelled — nothing was built.",
      canceled: true,
      stats: { modulesGenerated: 0, modulesUnchanged: snapshot.modules.length, modulesFailed: 0, durationMs: 0 },
    };
  }

  // -------------------------------------------------------------------------
  // Brand-intake gate resolution (VIB-1878). Resolving it produces a design
  // system and re-parks at the design gate (the next seam). "Surprise me"
  // (skip) runs the design system with no brand; "Bring your brand" (approve)
  // routes the intake channels, seeds the design system, and merges the brand
  // `:root` so the design checkpoint renders it.
  // -------------------------------------------------------------------------
  if (state.kind === "brand_intake") {
    return resumeBrandIntake(resumeToken, state, resolution, snapshot, engine, apiKey, model, onEvent);
  }

  // -------------------------------------------------------------------------
  // Structure gate (VIB-1879) — the blueprint already exists.
  // -------------------------------------------------------------------------
  if (state.kind === "structure") {
    discardCheckpoint(resumeToken);

    // Steer: re-plan ONLY the module structure with the note, then re-park.
    if (resolution.action === "steer") {
      const note = (resolution.note || "").trim();
      const steeredMessage = note
        ? `${state.userMessage}\n\n## Structure steer (revise the module plan to honor this)\n${note}`
        : state.userMessage;
      const blueprint = await runModulePlanner(
        steeredMessage,
        state.plan,
        snapshot,
        state.designSystem,
        state.sharedCss,
        engine,
        apiKey,
        model,
        onEvent,
      );
      return parkAtStructureCheckpoint(
        { ...state, userMessage: steeredMessage, blueprint },
        snapshot,
        onEvent,
      );
    }

    // approve / skip: build exactly the (possibly edited) outline the user kept.
    const blueprint = applyStructureEdits(state.blueprint, resolution.outline);
    onEvent({
      type: "blueprint_ready",
      moduleOrder: blueprint.moduleOrder,
      sharedCss: state.sharedCss,
      sharedJs: state.sharedJs,
    });
    return runBuildPhase(
      state.userMessage,
      state.plan,
      snapshot,
      blueprint,
      state.sharedCss,
      state.sharedJs ?? "",
      engine,
      apiKey,
      model,
      concurrency,
      onEvent,
      state.libraryModules,
      state.startTime,
      signal,
    );
  }

  // -------------------------------------------------------------------------
  // Design gate (VIB-1877) — only Stage 2a has run.
  // -------------------------------------------------------------------------

  // Steer: re-run ONLY the design system with the note appended, then re-park.
  if (resolution.action === "steer") {
    discardCheckpoint(resumeToken);
    const note = (resolution.note || "").trim();
    const steeredMessage = note
      ? `${state.userMessage}\n\n## Design steer (revise the design system to honor this)\n${note}`
      : state.userMessage;
    const ds = await runDesignSystem(
      steeredMessage,
      state.plan,
      snapshot,
      engine,
      apiKey,
      model,
      onEvent,
    );
    return parkAtDesignCheckpoint(
      { ...state, userMessage: steeredMessage, designSystem: ds, sharedCss: ds.sharedCss, sharedJs: ds.sharedJs || state.sharedJs },
      snapshot,
      onEvent,
    );
  }

  // approve / skip: run the Module Planner against the parked design.
  discardCheckpoint(resumeToken);

  // A design-kind gate always carries a design system (brand_intake is handled
  // above and re-parks here with one set).
  if (!state.designSystem) {
    throw new Error("Checkpoint resume state is missing its design system. Send your request again to start over.");
  }

  const blueprint = await runModulePlanner(
    state.userMessage,
    state.plan,
    snapshot,
    state.designSystem,
    state.sharedCss,
    engine,
    apiKey,
    model,
    onEvent,
  );

  const sharedCss = state.plan.contentType !== "email" ? (blueprint.designSystem.sharedCss || state.sharedCss) : state.sharedCss;
  const sharedJs = state.plan.contentType !== "email" ? (blueprint.designSystem.sharedJs || state.sharedJs) : state.sharedJs;

  // approve → stop again at the structure gate so the user can shape the module
  // skeleton before the build. skip → suppress it and build straight through.
  if (resolution.action !== "skip") {
    return parkAtStructureCheckpoint(
      {
        kind: "structure",
        userMessage: state.userMessage,
        plan: state.plan,
        designSystem: state.designSystem,
        blueprint,
        sharedCss,
        sharedJs: sharedJs ?? "",
        startTime: state.startTime,
        libraryModules: state.libraryModules,
      },
      snapshot,
      onEvent,
    );
  }

  onEvent({
    type: "blueprint_ready",
    moduleOrder: blueprint.moduleOrder,
    sharedCss,
    sharedJs,
  });

  return runBuildPhase(
    state.userMessage,
    state.plan,
    snapshot,
    blueprint,
    sharedCss,
    sharedJs ?? "",
    engine,
    apiKey,
    model,
    concurrency,
    onEvent,
    state.libraryModules,
    state.startTime,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Build phase — Stage 3 (module dev) + Stage 4 (validate) + assemble.
// Shared by the one-shot path and the checkpoint-resume path.
// ---------------------------------------------------------------------------

async function runBuildPhase(
  userMessage: string,
  plan: PipelinePlan,
  snapshot: SessionSnapshot,
  blueprint: PageBlueprint | null,
  sharedCss: string,
  sharedJs: string,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  effectiveConcurrency: number,
  onEvent: (event: PipelineEvent) => void,
  libraryModules: { name: string; usedIn: string[] }[],
  startTime: number,
  signal?: AbortSignal,
): Promise<PipelineResult> {

  // -----------------------------------------------------------------------
  // Build module specs for Stage 3
  // -----------------------------------------------------------------------

  const moduleSpecs: ModuleSpec[] = [];

  // New modules from the plan
  if (blueprint) {
    for (const bpMod of blueprint.modules) {
      moduleSpecs.push({
        name: bpMod.name,
        description: bpMod.description,
        contentBrief: bpMod.contentBrief,
        layoutNotes: bpMod.layoutNotes,
      });
    }
  } else {
    // No blueprint — build specs from plan
    for (const newMod of plan.newModules) {
      moduleSpecs.push({
        name: newMod.name,
        description: newMod.description,
        contentBrief: "Generate appropriate content based on the user request",
        layoutNotes: "Use responsive layout matching the existing design system",
      });
    }

    // Affected existing modules (modifications)
    for (const modName of plan.affectedModules) {
      const existing = snapshot.modules.find(
        (m) => m.moduleName === modName,
      );
      if (existing) {
        moduleSpecs.push({
          name: modName,
          description: `Modify existing module: ${modName}`,
          contentBrief: "Apply the user's requested changes",
          layoutNotes: "Preserve existing layout unless changes are requested",
          existingCode: existing,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Stage 3: Module Developer (parallel)
  // -----------------------------------------------------------------------

  let generatedModules: ModuleFiles[] = [];
  let failedModules: string[] = [];

  if (moduleSpecs.length > 0) {
    const devResults = await runWithSpan(
      "module-development",
      () =>
        runModuleDeveloper(
          userMessage,
          moduleSpecs,
          sharedCss,
          snapshot.themeName,
          engine,
          apiKey,
          model,
          effectiveConcurrency,
          onEvent,
          plan.guidesNeeded,
          snapshot.brandAssets,
          plan.contentType,
          signal,
        ),
      { metadata: { moduleCount: moduleSpecs.length } },
    );

    for (const r of devResults) {
      if (r.module) {
        generatedModules.push(r.module);
      } else {
        failedModules.push(r.moduleName);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Stage 4: Quality Check
  // -----------------------------------------------------------------------

  let validationResults: import("./stages/validator.js").ValidationResult[] | null = null;

  if (generatedModules.length > 0) {
    validationResults = validateModules(
      generatedModules,
      snapshot.themeName,
      onEvent,
      plan.contentType,
      snapshot.brandAssets?.brandKit,
    );

    // Retry modules whose fieldsJson was reset due to invalid JSON
    const modulesNeedingRetry = validationResults
      .filter((r) => r.issues.some((i) => i.field === "fieldsJson" && i.message.includes("reset to empty")))
      .map((r) => r.module.moduleName);

    if (modulesNeedingRetry.length > 0) {
      const retrySpecs = modulesNeedingRetry
        .map((name) => moduleSpecs.find((s) => s.name === name))
        .filter((s): s is ModuleSpec => s != null);

      if (retrySpecs.length > 0) {
        log.info("pipeline", `Retrying ${retrySpecs.length} module(s) with broken fieldsJson: ${retrySpecs.map((s) => s.name).join(", ")}`);
        onEvent({
          type: "agent_decision",
          step: "quality_check",
          decision: `Regenerating ${retrySpecs.length} module(s) with invalid fields JSON...`,
        });

        const retryResults = await runWithSpan(
          "module-development-retry",
          () =>
            runModuleDeveloper(
              userMessage,
              retrySpecs,
              sharedCss,
              snapshot.themeName,
              engine,
              apiKey,
              model,
              effectiveConcurrency,
              onEvent,
              plan.guidesNeeded,
              snapshot.brandAssets,
              plan.contentType,
              signal,
            ),
          { metadata: { moduleCount: retrySpecs.length } },
        );

        for (const r of retryResults) {
          if (r.module) {
            const idx = generatedModules.findIndex((m) => m.moduleName === r.moduleName);
            if (idx >= 0) generatedModules[idx] = r.module;
          }
        }

        // Re-validate after retry
        validationResults = validateModules(
          generatedModules,
          snapshot.themeName,
          onEvent,
          plan.contentType,
          snapshot.brandAssets?.brandKit,
        );
      }
    }

    // Replace generated modules with validated/auto-fixed versions
    generatedModules = validationResults.map((r) => r.module);

    // Log quality check summary with details
    const totalIssues = validationResults.reduce(
      (sum, r) => sum + r.issues.length,
      0,
    );
    if (totalIssues > 0) {
      const autoFixed = validationResults.reduce(
        (sum, r) => sum + r.issues.filter((i) => i.autoFixed).length,
        0,
      );
      log.info("pipeline", `Quality check: ${totalIssues} issues, ${autoFixed} auto-fixed`);

      // Build detailed issue list for the user
      const issueDetails = validationResults
        .flatMap((r) => r.issues)
        .map((i) => `${i.autoFixed ? "✓" : "⚠"} ${i.module}: ${i.message}`)
        .join("\n");

      onEvent({
        type: "agent_decision",
        step: "quality_check",
        decision: `${totalIssues} issues found, ${autoFixed} auto-fixed\n${issueDetails}`,
      });
    } else {
      onEvent({
        type: "agent_decision",
        step: "quality_check",
        decision: "All modules passed quality checks",
      });
    }
  }

  // -----------------------------------------------------------------------
  // Assemble final module list
  // -----------------------------------------------------------------------

  const finalModules = assembleModuleList(
    snapshot,
    plan,
    generatedModules,
    blueprint,
    libraryModules,
  );

  // Build module order (reconciles any missing modules automatically)
  const moduleOrder = buildModuleOrder(
    snapshot,
    plan,
    blueprint,
    finalModules,
  );

  // Warn if moduleOrder was missing modules (reconciled in buildModuleOrder)
  if (blueprint?.moduleOrder?.length) {
    const blueprintSet = new Set(blueprint.moduleOrder);
    const missing = finalModules
      .filter((m) => !blueprintSet.has(m.moduleName))
      .map((m) => m.moduleName);
    if (missing.length > 0) {
      onEvent({
        type: "agent_decision",
        step: "quality_check",
        decision: `⚠ ${missing.length} module${missing.length === 1 ? "" : "s"} missing from page order — auto-inserted: ${missing.join(", ")}`,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Build assistant message
  // -----------------------------------------------------------------------

  const durationMs = Date.now() - startTime;
  const modulesGenerated = generatedModules.length;
  const modulesUnchanged = plan.unchangedModules.length;

  const validationIssues = validationResults
    ? validationResults.flatMap((r) => r.issues)
    : [];

  const assistantMessage = buildAssistantMessage(
    plan,
    modulesGenerated,
    modulesUnchanged,
    failedModules,
    durationMs,
    blueprint,
    validationIssues,
  );

  // -----------------------------------------------------------------------
  // Emit completion event
  // -----------------------------------------------------------------------

  if (failedModules.length > 0) {
    onEvent({
      type: "pipeline_partial",
      succeeded: generatedModules.map((m) => m.moduleName),
      failed: failedModules,
      durationMs,
    });
  } else {
    onEvent({
      type: "pipeline_complete",
      modulesGenerated,
      modulesUnchanged,
      durationMs,
      assistantMessage,
    });
  }

  return {
    modules: finalModules,
    moduleOrder,
    sharedCss,
    sharedJs,
    assistantMessage,
    contentType: plan.contentType,
    stats: {
      modulesGenerated,
      modulesUnchanged,
      modulesFailed: failedModules.length,
      durationMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Multi-page pipeline flow
// ---------------------------------------------------------------------------

async function runMultiPageFlow(
  userMessage: string,
  plan: import("./types.js").PipelinePlan,
  snapshot: SessionSnapshot,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  concurrency: number,
  onEvent: (event: PipelineEvent) => void,
  startTime: number,
  signal?: AbortSignal,
): Promise<PipelineResult> {
  const pages = plan.pages!;
  const sharedModuleNames = plan.sharedModules || ["site-header", "site-footer"];

  // Stage 2a: Design System only (skip single-page module planner)
  const designSystem = await runDesignSystem(
    userMessage,
    plan,
    snapshot,
    engine,
    apiKey,
    model,
    onEvent,
  );

  const sharedCss = designSystem.sharedCss || snapshot.sharedCss;
  const sharedJs = designSystem.sharedJs || snapshot.sharedJs;

  onEvent({
    type: "blueprint_ready",
    moduleOrder: sharedModuleNames,
    sharedCss,
    sharedJs,
  });

  // Stage 2b: Site Module Planner (replaces single-page module planner)
  const siteBlueprint = await runSiteModulePlanner(
    userMessage,
    plan,
    snapshot,
    sharedCss,
    engine,
    apiKey,
    model,
    onEvent,
  );

  // Stage 3: Module Developer (parallel across all pages + shared)
  onEvent({
    type: "agent_step",
    step: "developing",
    label: `Generating modules for ${pages.length} pages...`,
  });

  const allSpecs: ModuleSpec[] = [];

  for (const shared of siteBlueprint.sharedModules) {
    allSpecs.push({ ...shared });
  }

  for (const page of siteBlueprint.pages) {
    for (const mod of page.modules) {
      allSpecs.push({
        name: mod.name,
        description: mod.description,
        contentBrief: mod.contentBrief,
        layoutNotes: mod.layoutNotes,
      });
    }
  }

  // Add navigation context for header/nav modules
  const navContext = pages
    .map((p) => `- "${p.label}" → /${p.slug}`)
    .join("\n");

  for (const spec of allSpecs) {
    if (spec.name.includes("header") || spec.name.includes("nav")) {
      spec.layoutNotes += `\n\n## Site Navigation\nThis is a multi-page site. Include navigation links to all pages:\n${navContext}\nUse relative href paths. Add CSS class "${snapshot.themeName}-nav__link--active" on the current page's link.`;
    }
  }

  const devResults = await runWithSpan(
    "module-development",
    () =>
      runModuleDeveloper(
        userMessage,
        allSpecs,
        sharedCss,
        snapshot.themeName,
        engine,
        apiKey,
        model,
        concurrency,
        onEvent,
        plan.guidesNeeded,
        snapshot.brandAssets,
        plan.contentType,
        signal,
      ),
    { metadata: { moduleCount: allSpecs.length } },
  );

  const generatedModules: ModuleFiles[] = [];
  const failedModules: string[] = [];

  for (const r of devResults) {
    if (r.module) {
      generatedModules.push(r.module);
    } else {
      failedModules.push(r.moduleName);
    }
  }

  // Stage 4: Quality Check
  let validatedModules = generatedModules;
  let validationIssues: { module: string; message: string; autoFixed: boolean }[] = [];

  if (generatedModules.length > 0) {
    let validationResults = validateModules(
      generatedModules,
      snapshot.themeName,
      onEvent,
      plan.contentType,
      snapshot.brandAssets?.brandKit,
    );

    // Retry modules whose fieldsJson was reset due to invalid JSON
    const modulesNeedingRetry = validationResults
      .filter((r) => r.issues.some((i) => i.field === "fieldsJson" && i.message.includes("reset to empty")))
      .map((r) => r.module.moduleName);

    if (modulesNeedingRetry.length > 0) {
      const retrySpecs = modulesNeedingRetry
        .map((name) => allSpecs.find((s) => s.name === name))
        .filter((s): s is ModuleSpec => s != null);

      if (retrySpecs.length > 0) {
        log.info("pipeline", `Retrying ${retrySpecs.length} module(s) with broken fieldsJson`);
        onEvent({
          type: "agent_decision",
          step: "quality_check",
          decision: `Regenerating ${retrySpecs.length} module(s) with invalid fields JSON...`,
        });

        const retryResults = await runWithSpan(
          "module-development-retry",
          () =>
            runModuleDeveloper(
              userMessage,
              retrySpecs,
              sharedCss,
              snapshot.themeName,
              engine,
              apiKey,
              model,
              concurrency,
              onEvent,
              plan.guidesNeeded,
              snapshot.brandAssets,
              plan.contentType,
              signal,
            ),
          { metadata: { moduleCount: retrySpecs.length } },
        );

        for (const r of retryResults) {
          if (r.module) {
            const idx = generatedModules.findIndex((m) => m.moduleName === r.moduleName);
            if (idx >= 0) generatedModules[idx] = r.module;
          }
        }

        validationResults = validateModules(
          generatedModules,
          snapshot.themeName,
          onEvent,
          plan.contentType,
          snapshot.brandAssets?.brandKit,
        );
      }
    }

    validatedModules = validationResults.map((r) => r.module);
    validationIssues = validationResults.flatMap((r) => r.issues);

    // Cross-page navigation validation
    const navIssues = validateNavLinks(
      validatedModules,
      pages.map((p) => p.slug),
    );
    validationIssues.push(...navIssues);

    const totalIssues = validationIssues.length;
    if (totalIssues > 0) {
      const autoFixed = validationIssues.filter((i) => i.autoFixed).length;
      onEvent({
        type: "agent_decision",
        step: "quality_check",
        decision: `${totalIssues} issues found, ${autoFixed} auto-fixed`,
      });
    } else {
      onEvent({
        type: "agent_decision",
        step: "quality_check",
        decision: "All modules passed quality checks",
      });
    }
  }

  // Partition modules by page for multi-page result
  const modulesByName = new Map(validatedModules.map((m) => [m.moduleName, m]));
  const sharedModules = siteBlueprint.sharedModules
    .map((s) => modulesByName.get(s.name))
    .filter((m): m is ModuleFiles => !!m);

  const planPageMap = new Map(pages.map((p) => [p.id, p]));

  const multiPagePages = siteBlueprint.pages.map((page) => {
    const pageModules = page.modules
      .map((m) => modulesByName.get(m.name))
      .filter((m): m is ModuleFiles => !!m);

    const headerModules = sharedModuleNames.filter((n) =>
      n.includes("header") || n.includes("nav"),
    );
    const footerModules = sharedModuleNames.filter((n) =>
      n.includes("footer"),
    );
    const fullOrder = [...headerModules, ...page.moduleOrder, ...footerModules];

    const planPage = planPageMap.get(page.pageId);

    return {
      pageId: page.pageId,
      templateId: page.pageId,
      label: planPage?.label || page.pageId,
      pageType: planPage?.pageType || ("website_page" as const),
      modules: [...sharedModules, ...pageModules],
      moduleOrder: fullOrder,
    };
  });

  const durationMs = Date.now() - startTime;

  const assistantMessage = buildMultiPageAssistantMessage(
    pages,
    generatedModules.length,
    failedModules,
    durationMs,
    siteBlueprint.narrative,
    validationIssues,
  );

  if (failedModules.length > 0) {
    onEvent({
      type: "pipeline_partial",
      succeeded: generatedModules.map((m) => m.moduleName),
      failed: failedModules,
      durationMs,
    });
  } else {
    onEvent({
      type: "pipeline_complete",
      modulesGenerated: generatedModules.length,
      modulesUnchanged: 0,
      durationMs,
      assistantMessage,
    });
  }

  // Return PipelineResult with multiPage data attached for the handler
  const result: PipelineResult & { multiPage?: MultiPagePipelineResult } = {
    modules: validatedModules,
    moduleOrder: validatedModules.map((m) => m.moduleName),
    sharedCss,
    sharedJs: sharedJs || "",
    assistantMessage,
    stats: {
      modulesGenerated: generatedModules.length,
      modulesUnchanged: 0,
      modulesFailed: failedModules.length,
      durationMs,
    },
    multiPage: {
      pages: multiPagePages,
      sharedModules,
      sharedCss,
      sharedJs: sharedJs || "",
      assistantMessage,
      stats: {
        pagesGenerated: pages.length,
        modulesGenerated: generatedModules.length,
        modulesFailed: failedModules.length,
        durationMs,
      },
    },
  };

  return result;
}

function buildMultiPageAssistantMessage(
  pages: import("./types.js").SitePagePlan[],
  modulesGenerated: number,
  failedModules: string[],
  durationMs: number,
  narrative: string,
  validationIssues: { module: string; message: string; autoFixed: boolean }[],
): string {
  const seconds = Math.round(durationMs / 1000);
  const parts: string[] = [];

  parts.push(
    `Created ${pages.length}-page site with ${modulesGenerated} modules in ${seconds}s.`,
  );
  parts.push(`\n\n**Pages:** ${pages.map((p) => p.label).join(", ")}`);

  if (narrative) {
    parts.push(`\n\n${narrative}`);
  }

  if (failedModules.length > 0) {
    parts.push(
      `\n\n**Failed:** ${failedModules.join(", ")}. You can retry these individually.`,
    );
  }

  const unfixed = validationIssues.filter((i) => !i.autoFixed);
  const fixed = validationIssues.filter((i) => i.autoFixed);
  if (fixed.length > 0 || unfixed.length > 0) {
    const valParts: string[] = [];
    if (fixed.length > 0) {
      valParts.push(`**Auto-fixed:** ${fixed.map((i) => `${i.module}: ${i.message}`).join(", ")}`);
    }
    if (unfixed.length > 0) {
      valParts.push(`**Warnings:** ${unfixed.map((i) => `${i.module}: ${i.message}`).join(", ")}`);
    }
    parts.push(`\n\n${valParts.join("\n")}`);
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assemble the final module list by combining generated, unchanged, and reused modules.
 */
function assembleModuleList(
  snapshot: SessionSnapshot,
  plan: { unchangedModules: string[]; reuseModules?: { name: string; sourceTemplate: string; position: number }[] },
  generatedModules: ModuleFiles[],
  blueprint: PageBlueprint | null,
  libraryModules: { name: string; usedIn: string[]; module?: ModuleFiles }[],
): ModuleFiles[] {
  const result: ModuleFiles[] = [];
  const added = new Set<string>();

  // Add generated modules
  for (const mod of generatedModules) {
    result.push(mod);
    added.add(mod.moduleName);
  }

  // Add unchanged modules from snapshot
  for (const name of plan.unchangedModules) {
    if (added.has(name)) continue;
    const existing = snapshot.modules.find((m) => m.moduleName === name);
    if (existing) {
      result.push(existing as ModuleFiles);
      added.add(name);
    }
  }

  // Add reused modules from library
  if (plan.reuseModules) {
    for (const reuse of plan.reuseModules) {
      if (added.has(reuse.name)) continue;
      const libEntry = libraryModules.find(
        (l) => l.name === reuse.name && (l as { module?: ModuleFiles }).module,
      );
      if (libEntry && (libEntry as { module?: ModuleFiles }).module) {
        result.push((libEntry as { module: ModuleFiles }).module);
        added.add(reuse.name);
      }
    }
  }

  return result;
}

/**
 * Build the final module order.
 */
function buildModuleOrder(
  snapshot: SessionSnapshot,
  plan: { intent: string; newModules: { name: string; position: number }[]; reuseModules?: { name: string; position: number }[] },
  blueprint: PageBlueprint | null,
  finalModules: ModuleFiles[],
): string[] {
  // If blueprint provides order, use it — but reconcile with actual modules
  if (blueprint?.moduleOrder?.length) {
    const order = [...blueprint.moduleOrder];
    // Append any generated modules missing from the blueprint order
    // (AI sometimes drops modules from moduleOrder while still generating them)
    const orderSet = new Set(order);
    for (const mod of finalModules) {
      if (!orderSet.has(mod.moduleName)) {
        // Insert before footer if present, otherwise append
        const footerIdx = order.findIndex(
          (n) => n.toLowerCase().includes("footer"),
        );
        if (footerIdx !== -1) {
          order.splice(footerIdx, 0, mod.moduleName);
        } else {
          order.push(mod.moduleName);
        }
        orderSet.add(mod.moduleName);
        log.warn(
          "pipeline",
          `Module "${mod.moduleName}" missing from blueprint order — inserted`,
        );
      }
    }
    return order;
  }

  // For create intent, use the order from finalModules
  if (plan.intent === "create") {
    return finalModules.map((m) => m.moduleName);
  }

  // Start with existing order
  const order = [...(snapshot.moduleOrder as string[])];

  // Insert new modules at their specified positions
  const insertions = [
    ...plan.newModules.map((m) => ({ name: m.name, position: m.position })),
    ...(plan.reuseModules || []).map((m) => ({
      name: m.name,
      position: m.position,
    })),
  ].sort((a, b) => a.position - b.position);

  for (const ins of insertions) {
    const pos = Math.min(ins.position, order.length);
    order.splice(pos, 0, ins.name);
  }

  // Filter to only modules that exist in finalModules
  const moduleNames = new Set(finalModules.map((m) => m.moduleName));
  return order.filter((name) => moduleNames.has(name));
}

function buildAssistantMessage(
  plan: { intent: string; affectedModules: string[]; newModules: { name: string }[] },
  modulesGenerated: number,
  modulesUnchanged: number,
  failedModules: string[],
  durationMs: number,
  blueprint: PageBlueprint | null,
  validationIssues: { module: string; message: string; autoFixed: boolean }[],
): string {
  const seconds = Math.round(durationMs / 1000);
  const parts: string[] = [];

  if (plan.intent === "create") {
    parts.push(
      `Created ${modulesGenerated} module${modulesGenerated === 1 ? "" : "s"} in ${seconds}s.`,
    );
  } else if (plan.intent === "modify" || plan.intent === "style_change") {
    parts.push(
      `Updated ${modulesGenerated} module${modulesGenerated === 1 ? "" : "s"} in ${seconds}s.`,
    );
    if (modulesUnchanged > 0) {
      parts.push(`${modulesUnchanged} module${modulesUnchanged === 1 ? "" : "s"} unchanged.`);
    }
  } else if (plan.intent === "add") {
    const newNames = plan.newModules.map((m) => m.name).join(", ");
    parts.push(`Added ${newNames} in ${seconds}s.`);
  } else if (plan.intent === "remove") {
    parts.push(`Removed modules in ${seconds}s.`);
  } else if (plan.intent === "rearrange") {
    parts.push(`Rearranged modules in ${seconds}s.`);
  }

  // Add narrative summary from blueprint
  if (blueprint?.narrative) {
    parts.push(`\n\n${blueprint.narrative}`);
  }

  if (failedModules.length > 0) {
    parts.push(
      `\n\n**Failed:** ${failedModules.join(", ")}. You can retry these individually.`,
    );
  }

  // Add validation details
  const unfixed = validationIssues.filter((i) => !i.autoFixed);
  const fixed = validationIssues.filter((i) => i.autoFixed);
  if (fixed.length > 0 || unfixed.length > 0) {
    const valParts: string[] = [];
    if (fixed.length > 0) {
      valParts.push(`**Auto-fixed:** ${fixed.map((i) => `${i.module}: ${i.message}`).join(", ")}`);
    }
    if (unfixed.length > 0) {
      valParts.push(`**Warnings:** ${unfixed.map((i) => `${i.module}: ${i.message}`).join(", ")}`);
    }
    parts.push(`\n\n${valParts.join("\n")}`);
  }

  return parts.join("");
}
