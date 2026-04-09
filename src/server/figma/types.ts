/**
 * Types for Figma design import.
 */

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

export interface FigmaUrlParts {
  fileKey: string;
  nodeId?: string; // colon-separated format for API (e.g., "0:1")
  fileName?: string;
}

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

export interface FigmaColorToken {
  /** Hex value, e.g., "#00dd97" */
  hex: string;
  /** Opacity 0–1 */
  opacity: number;
  /** How many times this color appears in the file */
  occurrences: number;
  /** Inferred usage: "background", "text", "accent", "border", "fill" */
  usage: string;
  /** Figma variable name if defined */
  variableName?: string;
}

export interface FigmaTypographyToken {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number; // as multiplier, e.g., 1.5
  letterSpacing: number; // in px
  /** Inferred role: "heading", "subheading", "body", "label", "caption" */
  role: string;
  /** How many TEXT nodes use this style */
  occurrences: number;
}

export interface FigmaSpacingToken {
  /** Where this spacing was found, e.g., "Hero frame padding" */
  context: string;
  /** Spacing value in px */
  value: number;
  /** Type: "padding", "gap", "margin" */
  type: "padding" | "gap" | "margin";
}

export interface FigmaEffectToken {
  type: "shadow" | "radius" | "blur";
  /** CSS-ready value, e.g., "0 4px 12px rgba(0,0,0,0.1)" or "8px" */
  cssValue: string;
  /** Where this was found */
  context: string;
}

export interface FigmaDesignTokens {
  colors: FigmaColorToken[];
  typography: FigmaTypographyToken[];
  spacing: FigmaSpacingToken[];
  effects: FigmaEffectToken[];
}

// ---------------------------------------------------------------------------
// Text content
// ---------------------------------------------------------------------------

export interface FigmaTextBlock {
  /** The actual text content */
  text: string;
  /** Font size in px */
  fontSize: number;
  /** Font weight */
  fontWeight: number;
  /** Inferred role: "headline", "subheadline", "body", "label", "cta", "caption" */
  role: string;
  /** Parent section name for grouping */
  sectionName: string;
}

// ---------------------------------------------------------------------------
// Node summary (lightweight representation of Figma tree)
// ---------------------------------------------------------------------------

export interface FigmaNodeSummary {
  name: string;
  type: string; // "FRAME", "TEXT", "RECTANGLE", "GROUP", "COMPONENT", "INSTANCE", etc.
  nodeId: string;
  width: number;
  height: number;
  /** Auto-layout direction if present */
  layoutMode?: "HORIZONTAL" | "VERTICAL";
  /** Child count (not full children — keeps it lightweight) */
  childCount: number;
  /** Only for TEXT nodes */
  characters?: string;
}

// ---------------------------------------------------------------------------
// Sections (top-level frames → page sections)
// ---------------------------------------------------------------------------

export interface FigmaSection {
  name: string;
  nodeId: string;
  width: number;
  height: number;
  /** All text blocks found within this section */
  textContent: FigmaTextBlock[];
  /** Immediate children summary */
  children: FigmaNodeSummary[];
  /** Local path to the exported PNG screenshot */
  frameImagePath: string;
  /** Background color if detectable */
  backgroundColor?: string;
  /** Auto-layout info */
  layoutMode?: "HORIZONTAL" | "VERTICAL";
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
}

// ---------------------------------------------------------------------------
// Assets (images extracted from the design)
// ---------------------------------------------------------------------------

export interface FigmaAsset {
  /** Display name */
  name: string;
  /** Local file path (saved to theme/assets/) */
  localPath: string;
  /** Original Figma node ID */
  nodeId: string;
  /** Export format */
  format: "png" | "svg";
}

// ---------------------------------------------------------------------------
// Top-level extraction result
// ---------------------------------------------------------------------------

export interface FigmaExtraction {
  fileName: string;
  fileUrl: string;
  designTokens: FigmaDesignTokens;
  sections: FigmaSection[];
  assets: FigmaAsset[];
}

// ---------------------------------------------------------------------------
// Lightweight summary for the UI (no large payloads)
// ---------------------------------------------------------------------------

export interface FigmaExtractionSummary {
  fileName: string;
  fileUrl: string;
  /** Section names in order */
  sectionNames: string[];
  sectionCount: number;
  /** Top colors as hex strings for swatch display */
  colorPalette: string[];
  /** Typography families found */
  fontFamilies: string[];
  /** Total text blocks extracted */
  textBlockCount: number;
  /** Total image assets downloaded */
  assetCount: number;
  /** Suggested theme name (kebab-cased from file name) */
  suggestedThemeName: string;
}
