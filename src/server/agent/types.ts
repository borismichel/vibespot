/**
 * Shared types for the agentic pipeline.
 */

import type { ModuleFiles } from "../../ai/engine.js";
import type { SessionSnapshot, PageType } from "../session/types.js";
import type { PageCost } from "../cost-tracker.js";

// ---------------------------------------------------------------------------
// Stage 1 output: Intent Analyzer
// ---------------------------------------------------------------------------

export type ContentType = "page" | "email" | "blog";

export interface PipelinePlan {
  intent:
    | "create"
    | "create_site"
    | "modify"
    | "add"
    | "remove"
    | "rearrange"
    | "style_change"
    | "question";
  contentType?: ContentType;
  affectedModules: string[];
  unchangedModules: string[];
  newModules: { name: string; description: string; position: number }[];
  reuseModules?: {
    name: string;
    sourceTemplate: string;
    position: number;
  }[];
  pages?: SitePagePlan[];
  sharedModules?: string[];
  guidesNeeded: (
    | "design"
    | "content"
    | "conversion"
    | "hubspot_rules"
    | "humanify"
  )[];
  designSystemChanges: boolean;
  answer?: string;
}

// ---------------------------------------------------------------------------
// Stage 2a output: Design System
// ---------------------------------------------------------------------------

export interface DesignSystemOutput {
  cssVariables: Record<string, string>;
  sharedCss: string;
  sharedJs?: string;
  aesthetic: string;
}

// ---------------------------------------------------------------------------
// Stage 2 combined output: Page Architect (Design System + Module Plan)
// ---------------------------------------------------------------------------

export interface PageBlueprint {
  designSystem: {
    cssVariables: Record<string, string>;
    sharedCss: string;
    sharedJs?: string;
  };
  modules: {
    name: string;
    description: string;
    contentBrief: string;
    layoutNotes: string;
  }[];
  moduleOrder: string[];
  narrative: string;
}

// ---------------------------------------------------------------------------
// Pipeline events (emitted to WebSocket)
// ---------------------------------------------------------------------------

export type PipelineStep =
  | "analyzing"
  | "designing"
  | "planning_site"
  | "developing"
  | "quality_check";

export type ModuleStatus =
  | "queued"
  | "generating"
  | "validating"
  | "retrying"
  | "complete"
  | "failed";

// ---------------------------------------------------------------------------
// Checkpoint gate (VIB-1877) — pauses the pipeline at a natural seam so the
// user can approve / steer / skip before the expensive module build. One
// primitive, reused at several seams (design, structure, brand-intake, plan).
// Plan mode (VIB-1880) is the heaviest variant: the whole deliberation phase
// is one "plan" checkpoint, resolved through the same `checkpoint_resolve`
// protocol instead of a separate plan_approve branch.
// ---------------------------------------------------------------------------

export type CheckpointKind = "design" | "structure" | "brand_intake" | "plan";

/** Action the user takes at a checkpoint. */
export type CheckpointAction =
  /** Continue the pipeline from the parked stage, unchanged. */
  | "approve"
  /** Re-run ONLY the stage that produced this checkpoint, with `note` appended. */
  | "steer"
  /** Approve and suppress all remaining checkpoints for this run. */
  | "skip"
  /** Discard the run; nothing is written to disk. */
  | "cancel";

/**
 * What the UI renders in a checkpoint card. Stage-specific shape is carried in
 * `data`; the renderer keys off `kind`. Kept small so it survives persistence.
 */
export interface CheckpointPreview {
  kind: CheckpointKind;
  /** Short headline for the card, e.g. "Here's the look" / "Here's the structure". */
  headline: string;
  /** Stage-specific payload (palette+type+hero for design, module outline for structure, …). */
  data: Record<string, unknown>;
}

/**
 * Persisted on the session while the pipeline is parked at a gate. Holding a
 * resume token (not a live promise) keeps the pause crash-safe and mirrors the
 * plan_approve re-entry pattern.
 */
export interface PendingCheckpoint {
  kind: CheckpointKind;
  /** Opaque id the parked pipeline run resumes from. */
  resumeToken: string;
  preview: CheckpointPreview;
  /** When the gate was raised (ISO-8601), for staleness/telemetry. */
  createdAt: string;
}

/**
 * Brand-intake payload (VIB-1878). Carried on a `brand_intake` checkpoint
 * resolution when the user chose "Bring your brand". Every field is optional;
 * each populated channel is routed to its matching extractor and contributes a
 * `:root` / brand context that seeds the design system. All channels are
 * deterministic (no model call) so the gate stays cheap.
 */
export interface BrandIntakeInput {
  /** Free-form colors (hex / rgb / "Name #hex" lines) → parsed into `:root`. */
  colors?: string;
  /** Pasted CSS or HTML → token extraction (`:root` vars, colors, fonts). */
  code?: string;
  /** Tone-of-voice description → brandvoice asset (steers copy in build). */
  voice?: string;
  /** Local HubSpot theme path → inverse-analyzer token extraction. */
  themePath?: string;
  /** Public site URL → fetch + CSS token extraction (best-effort). */
  siteUrl?: string;
}

/**
 * One module in a structure-checkpoint outline as edited by the user (VIB-1879).
 * `sourceIndex` ties a row back to the planned module it came from so the build
 * keeps that module's contentBrief/layoutNotes across rename/reorder; rows with
 * no `sourceIndex` are sections the user added by hand.
 */
export interface StructureOutlineItem {
  name: string;
  description?: string;
  sourceIndex?: number;
}

/** Inbound resolution of a pending checkpoint (UI → server). */
export interface CheckpointResolution {
  kind: CheckpointKind;
  action: CheckpointAction;
  /** Free-text steer instruction; only meaningful when action === "steer". */
  note?: string;
  /**
   * Brand-intake channels; only meaningful when kind === "brand_intake" and the
   * user chose "Bring your brand" (action === "approve"). Absent for
   * "Surprise me" (action === "skip").
   */
  brandIntake?: BrandIntakeInput;
  /**
   * Edited module outline from a structure checkpoint (VIB-1879). Honored on
   * approve/skip — the build uses exactly these modules, in this order.
   */
  outline?: StructureOutlineItem[];
}

export type PipelineEvent =
  | { type: "agent_step"; step: PipelineStep; label: string }
  | {
      type: "checkpoint_requested";
      kind: CheckpointKind;
      preview: CheckpointPreview;
      /**
       * Estimated USD cost of the work this checkpoint gates (i.e. the spend
       * the user avoids by cancelling here). Reuses per-page cost (VIB-1770).
       * Omitted when no estimate is available (e.g. CLI engines report no usage).
       */
      estCostNext?: number;
    }
  | { type: "agent_decision"; step: string; decision: string }
  | {
      type: "module_progress";
      module: string;
      status: ModuleStatus;
      current: number;
      total: number;
      moduleFiles?: ModuleFiles;
    }
  | {
      type: "design_system_ready";
      sharedCss: string;
      sharedJs: string;
      aesthetic: string;
    }
  | {
      type: "blueprint_ready";
      moduleOrder: string[];
      sharedCss: string;
      sharedJs?: string;
    }
  | { type: "module_stream"; module: string; content: string }
  | {
      type: "site_blueprint_ready";
      pages: { pageId: string; label: string; moduleCount: number }[];
      sharedModuleCount: number;
    }
  | {
      type: "page_progress";
      pageId: string;
      label: string;
      status: "generating" | "complete" | "failed";
      modulesComplete: number;
      modulesTotal: number;
    }
  | {
      type: "pipeline_complete";
      modulesGenerated: number;
      modulesUnchanged: number;
      durationMs: number;
      answer?: string;
      assistantMessage?: string;
    }
  | {
      type: "pipeline_partial";
      succeeded: string[];
      failed: string[];
      durationMs: number;
    };

// ---------------------------------------------------------------------------
// Pipeline result (returned by orchestrator)
// ---------------------------------------------------------------------------

export interface PipelineResult {
  modules: ModuleFiles[];
  moduleOrder: string[];
  sharedCss: string;
  sharedJs: string;
  assistantMessage: string;
  /** Content type the pipeline produced (page/email/blog); set from the plan. */
  contentType?: ContentType;
  stats: {
    modulesGenerated: number;
    modulesUnchanged: number;
    modulesFailed: number;
    durationMs: number;
  };
  /**
   * Aggregated token + USD cost of every model call this generation made
   * (VIB-1770). Attached by the handler that wraps the pipeline in
   * `runWithCostTracking`. Absent for CLI engines (no usage reported).
   */
  cost?: PageCost;
  /**
   * Set when the run parked at a checkpoint gate (VIB-1877) instead of
   * finishing. No modules were built; the handler persists this on the session
   * and waits for the user's resolution. `modules` carries the pre-run state.
   */
  pendingCheckpoint?: PendingCheckpoint;
  /** Set when a parked run was cancelled at the gate — nothing was built. */
  canceled?: boolean;
  /**
   * Brand assets derived at the brand-intake gate (VIB-1878) that the handler
   * should persist to the live session before continuing. Set when the user
   * brought their brand; the design system is built from them. Persisting here
   * (rather than mutating the session from inside the pipeline) keeps the
   * pipeline pure and lets future edits inherit the brand.
   */
  brandAssetsUpdate?: {
    styleguide?: string;
    brandvoice?: string;
  };
}

// ---------------------------------------------------------------------------
// Multi-page pipeline types (VIB-159)
// ---------------------------------------------------------------------------

export interface SitePagePlan {
  id: string;
  label: string;
  pageType: PageType;
  purpose: string;
  slug: string;
}

export interface SitePageBlueprint {
  pageId: string;
  modules: { name: string; description: string; contentBrief: string; layoutNotes: string }[];
  moduleOrder: string[];
}

export interface SiteBlueprint {
  designSystem: {
    cssVariables: Record<string, string>;
    sharedCss: string;
    sharedJs?: string;
  };
  pages: SitePageBlueprint[];
  sharedModules: { name: string; description: string; contentBrief: string; layoutNotes: string }[];
  narrative: string;
}

export interface MultiPagePipelineResult {
  pages: {
    pageId: string;
    templateId: string;
    label: string;
    pageType: PageType;
    modules: ModuleFiles[];
    moduleOrder: string[];
  }[];
  sharedModules: ModuleFiles[];
  sharedCss: string;
  sharedJs: string;
  assistantMessage: string;
  stats: {
    pagesGenerated: number;
    modulesGenerated: number;
    modulesFailed: number;
    durationMs: number;
  };
}

// ---------------------------------------------------------------------------
// Module spec (passed to Stage 3 Module Developer)
// ---------------------------------------------------------------------------

export interface ModuleSpec {
  name: string;
  description: string;
  contentBrief: string;
  layoutNotes: string;
  existingCode?: ModuleFiles; // Present when modifying an existing module
}

// ---------------------------------------------------------------------------
// Concurrency limiter helper
// ---------------------------------------------------------------------------

/**
 * Error thrown when a limited task is skipped/cancelled because the run was
 * aborted (barge-in, VIB-1880). Distinct so callers can tell a deliberate
 * cancellation apart from a genuine module-generation failure.
 */
export class PipelineAbortError extends Error {
  readonly aborted = true;
  constructor(message = "Pipeline aborted") {
    super(message);
    this.name = "PipelineAbortError";
  }
}

/** True for any abort-flavoured error (our own, DOMException AbortError, or the
 * Anthropic SDK's APIUserAbortError) so seam checks can treat them uniformly. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof PipelineAbortError) return true;
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "APIUserAbortError") return true;
  const msg = err instanceof Error ? err.message : "";
  return /\baborted\b/i.test(msg);
}

/**
 * Concurrency limiter with optional cancellation (VIB-1880).
 *
 * When `signal` aborts, queued tasks that have not yet started reject with a
 * `PipelineAbortError` (so the build stops spawning new module calls), and any
 * task entering `limit()` after the abort is rejected up front. In-flight calls
 * are cancelled separately by threading the same `signal` into the provider
 * request (see engine-adapter); the limiter only governs not-yet-started work.
 */
export function createConcurrencyLimiter(
  maxConcurrent: number,
  signal?: AbortSignal,
) {
  let running = 0;
  const queue: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];

  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        // Drain everything still waiting for a slot — none of it should run.
        while (queue.length > 0) {
          queue.shift()!.reject(new PipelineAbortError());
        }
      },
      { once: true },
    );
  }

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new PipelineAbortError();
    if (running >= maxConcurrent) {
      await new Promise<void>((resolve, reject) => queue.push({ resolve, reject }));
      // Re-check: the abort may have fired while we were queued.
      if (signal?.aborted) throw new PipelineAbortError();
    }
    running++;
    try {
      return await fn();
    } finally {
      running--;
      if (queue.length > 0) {
        queue.shift()!.resolve();
      }
    }
  };
}
