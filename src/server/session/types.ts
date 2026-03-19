/**
 * Type definitions for the vibe coding session system.
 */

import type { ModuleFiles } from "../../ai/engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineMetadata {
  steps: { step: string; label: string; decisions?: string[] }[];
  modules: { name: string; status: "complete" | "failed" }[];
  stats: { modulesGenerated: number; modulesUnchanged: number; modulesFailed: number; durationMs: number };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  pipeline?: PipelineMetadata;
}

export type PageType = "landing_page" | "blog_post" | "website_page" | "module_only";

export interface TemplateEntry {
  id: string;                    // e.g. "lp-main", "blog-post"
  label: string;                 // "Main Landing Page"
  pageType: PageType;
  templateFile: string;          // "templates/lp-main.html"
  modules: ModuleFiles[];
  moduleOrder: string[];
  sharedCss: string;
  sharedJs: string;
  template: string;              // HubL template content
  messages: ChatMessage[];       // per-template chat history
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

  // Multi-template support
  templates: TemplateEntry[];
  activeTemplateId: string;
  brandAssets?: {
    styleguide?: string;
    brandvoice?: string;
    humanify?: boolean;
    themeContext?: string;
  };
  assets?: SessionAsset[];

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
}

export interface SessionSnapshot {
  modules: ReadonlyArray<Readonly<ModuleFiles>>;
  moduleOrder: ReadonlyArray<string>;
  sharedCss: string;
  sharedJs: string;
  messages: ReadonlyArray<Readonly<ChatMessage>>;
  themeName: string;
  themePath: string;
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean; themeContext?: string };
}

export interface FieldDef {
  name: string;
  default?: unknown;
  children?: FieldDef[];
}
