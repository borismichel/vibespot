/**
 * Shared types for the agentic pipeline.
 */

import type { ModuleFiles } from "../../ai/engine.js";
import type { SessionSnapshot, PageType } from "../session/types.js";

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
  guidesNeeded: (
    | "design"
    | "content"
    | "conversion"
    | "hubspot_rules"
    | "humanify"
  )[];
  designSystemChanges: boolean;
  answer?: string;
  pages?: SitePagePlan[];
  sharedModules?: string[];
}

// ---------------------------------------------------------------------------
// Multi-page site planning (create_site intent)
// ---------------------------------------------------------------------------

export interface SitePagePlan {
  id: string;
  label: string;
  pageType: PageType;
  purpose: string;
  slug: string;
}

export interface SiteBlueprint {
  designSystem: {
    cssVariables: Record<string, string>;
    sharedCss: string;
    sharedJs?: string;
  };
  pages: SitePageBlueprint[];
  sharedModules: ModuleSpec[];
  narrative: string;
}

export interface SitePageBlueprint {
  pageId: string;
  modules: {
    name: string;
    description: string;
    contentBrief: string;
    layoutNotes: string;
  }[];
  moduleOrder: string[];
}

export interface MultiPagePipelineResult {
  pages: {
    pageId: string;
    templateId: string;
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

export type PipelineEvent =
  | { type: "agent_step"; step: PipelineStep; label: string }
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
  stats: {
    modulesGenerated: number;
    modulesUnchanged: number;
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

export function createConcurrencyLimiter(maxConcurrent: number) {
  let running = 0;
  const queue: Array<() => void> = [];

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= maxConcurrent) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running++;
    try {
      return await fn();
    } finally {
      running--;
      if (queue.length > 0) {
        queue.shift()!();
      }
    }
  };
}
