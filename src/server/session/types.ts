/**
 * Type definitions for the vibe coding session system.
 */

import type { ModuleFiles } from "../../ai/engine.js";
import type { PageCost } from "../cost-tracker.js";

export type { PageCost } from "../cost-tracker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrandKit {
  colors?: {
    primary?: string;
    secondary?: string;
    accent?: string;
  };
  fonts?: {
    heading?: string;
    body?: string;
  };
  logoUrl?: string;
}

export interface PipelineMetadata {
  steps: { step: string; label: string; decisions?: string[] }[];
  modules: { name: string; status: "complete" | "failed" }[];
  stats: { modulesGenerated: number; modulesUnchanged: number; modulesFailed: number; durationMs: number };
  /** Estimated token + USD cost of this generation (VIB-1770). */
  cost?: PageCost;
}

/** Running per-project (per-theme) generation cost total (VIB-1770). */
export interface ProjectCostTotal {
  costUsd: number;
  totalTokens: number;
  /** Number of generations that contributed (with known usage). */
  generations: number;
  /** False once any contributing generation had an unpriced model call. */
  costComplete: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  pipeline?: PipelineMetadata;
}

export type PageType = "landing_page" | "blog_post" | "website_page" | "module_only";

export type ContentMode = "page" | "email" | "blog";
export type ContentType = "page" | "email" | "blog";

export interface TemplateEntry {
  id: string;                    // e.g. "lp-main", "blog-post"
  label: string;                 // "Main Landing Page"
  pageType: PageType;
  contentMode?: ContentMode;     // "page" (default) or "email" — persisted so modify requests use email prompts
  templateFile: string;          // "templates/lp-main.html"
  modules: ModuleFiles[];
  moduleOrder: string[];
  sharedCss: string;
  sharedJs: string;
  template: string;              // HubL template content
  messages: ChatMessage[];       // per-template chat history
  plan?: string;                 // per-template plan markdown
}

export interface SessionAsset {
  id: string;
  filename: string;
  originalName: string;
  type: "image" | "document";
  usage: "asset" | "context";
  mimeType: string;
  size: number;
  addedAt: string;
  extractedText?: string;
}

export interface VibeSession {
  id: string;
  themePath: string;
  themeName: string;
  isImported?: boolean;

  // Multi-template support
  templates: TemplateEntry[];
  activeTemplateId: string;
  brandAssets?: {
    styleguide?: string;
    brandvoice?: string;
    humanify?: boolean;
    themeContext?: string;
    plan?: string;
    brandKit?: BrandKit;
  };
  assets?: SessionAsset[];

  /**
   * Running estimated generation cost for this project/theme (VIB-1770).
   * Accumulated across generations and persisted with the session. Absent on
   * sessions created before this field existed (treated as zero).
   */
  costTotal?: ProjectCostTotal;

  /**
   * Set while an agentic run is parked at a checkpoint gate (VIB-1877), awaiting
   * the user's approve/steer/skip/cancel. Holds a resume token (not a live
   * promise) so the pause is crash-safe, mirroring the plan_approve re-entry
   * pattern. Cleared when the checkpoint is resolved. Not persisted long-term —
   * an unresolved gate is dropped on reload.
   */
  pendingCheckpoint?: import("../agent/types.js").PendingCheckpoint;

  // Legacy flat fields — kept for backward compat, redirected to active template
  messages: ChatMessage[];
  modules: ModuleFiles[];
  sharedCss: string;
  sharedJs: string;
  template: string;
  moduleOrder: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionIndexEntry {
  id: string;
  themeName: string;
  updatedAt: number;
  moduleCount: number;
  templateCount: number;
  pageCount: number;
  emailCount: number;
  hasBrandAssets: boolean;
  isImported?: boolean;
}

export interface SessionSnapshot {
  modules: ReadonlyArray<Readonly<ModuleFiles>>;
  moduleOrder: ReadonlyArray<string>;
  sharedCss: string;
  sharedJs: string;
  messages: ReadonlyArray<Readonly<ChatMessage>>;
  themeName: string;
  themePath: string;
  contentMode?: ContentMode;
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string; plan?: string; brandKit?: BrandKit };
  activePageLabel?: string;
  sitePages?: ReadonlyArray<{ id: string; label: string; pageType: PageType; moduleCount: number }>;
}

export interface FieldDef {
  name: string;
  default?: unknown;
  children?: FieldDef[];
}
