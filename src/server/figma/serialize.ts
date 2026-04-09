/**
 * Serializes a FigmaExtraction into a structured text document
 * suitable for AI context in the agentic pipeline.
 */

import type { FigmaExtraction, FigmaSection, FigmaAsset } from "./types.js";

// ---------------------------------------------------------------------------
// Main serializer
// ---------------------------------------------------------------------------

export function serializeFigmaExtraction(extraction: FigmaExtraction): string {
  const parts: string[] = [];

  parts.push(`# Figma Design: ${extraction.fileName}`);
  parts.push(`Source: ${extraction.fileUrl}`);

  // Design tokens
  parts.push(serializeDesignTokens(extraction));

  // Sections
  for (let i = 0; i < extraction.sections.length; i++) {
    parts.push(serializeSection(extraction.sections[i], i + 1));
  }

  // Assets
  if (extraction.assets.length > 0) {
    parts.push(serializeAssets(extraction.assets));
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Prompt prefix for AI conversion
// ---------------------------------------------------------------------------

export function buildFigmaPromptPrefix(extraction: FigmaExtraction, themeName: string): string {
  return `Convert this Figma design into HubSpot CMS modules for the theme "${themeName}".

CRITICAL REQUIREMENTS:
- Match the visual design as closely as possible within HubL and CSS constraints
- Every text block must become an editable HubSpot field (text, richtext, or link)
- Use the design tokens below to create CSS custom properties (--${themeName}-*)
- Colors that differ between sections should become color fields for per-module customization
- Repeated elements (cards, features, stats) must use group fields with repeaters
- Images must become image fields pointing to uploaded assets in theme/assets/
- Maintain the exact section order from the Figma design
- Ensure responsive behavior (the Figma design shows desktop — you must add mobile styles)

The user's Figma design has ${extraction.sections.length} sections and uses ${extraction.designTokens.colors.length} colors, ${[...new Set(extraction.designTokens.typography.map((t) => t.fontFamily))].length} font families.

`;
}

// ---------------------------------------------------------------------------
// Token serialization
// ---------------------------------------------------------------------------

function serializeDesignTokens(extraction: FigmaExtraction): string {
  const { colors, typography, spacing, effects } = extraction.designTokens;
  const parts: string[] = ["## Design Tokens"];

  // Colors
  if (colors.length > 0) {
    parts.push("### Colors");
    for (const c of colors.slice(0, 20)) {
      const opacity = c.opacity < 1 ? ` (opacity: ${Math.round(c.opacity * 100)}%)` : "";
      parts.push(`- ${c.hex}${opacity} — ${c.usage} (${c.occurrences} uses)`);
    }
  }

  // Typography
  if (typography.length > 0) {
    parts.push("### Typography");
    for (const t of typography) {
      parts.push(`- ${t.role}: ${t.fontFamily}, ${t.fontSize}px/${t.lineHeight} weight ${t.fontWeight}${t.letterSpacing ? `, letter-spacing ${t.letterSpacing}px` : ""} (${t.occurrences} uses)`);
    }
  }

  // Spacing
  if (spacing.length > 0) {
    parts.push("### Spacing");
    const unique = spacing.slice(0, 15);
    for (const s of unique) {
      parts.push(`- ${s.context}: ${s.value}px (${s.type})`);
    }
  }

  // Effects
  if (effects.length > 0) {
    parts.push("### Effects");
    for (const e of effects) {
      parts.push(`- ${e.type}: ${e.cssValue} (from ${e.context})`);
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Section serialization
// ---------------------------------------------------------------------------

function serializeSection(section: FigmaSection, index: number): string {
  const parts: string[] = [];

  parts.push(`## Section ${index}: "${section.name}" (${section.width}×${section.height})`);

  // Background
  if (section.backgroundColor) {
    parts.push(`Background: ${section.backgroundColor}`);
  }

  // Layout info
  if (section.layoutMode) {
    const layoutParts: string[] = [`Layout: ${section.layoutMode}`];
    if (section.itemSpacing) layoutParts.push(`gap ${section.itemSpacing}px`);
    if (section.paddingTop || section.paddingRight || section.paddingBottom || section.paddingLeft) {
      layoutParts.push(`padding ${section.paddingTop || 0}/${section.paddingRight || 0}/${section.paddingBottom || 0}/${section.paddingLeft || 0}px`);
    }
    parts.push(layoutParts.join(", "));
  }

  // Text content
  if (section.textContent.length > 0) {
    parts.push("### Text Content");
    for (const block of section.textContent) {
      const style = `${block.fontSize}px, weight ${block.fontWeight}`;
      // Truncate very long text blocks
      const text = block.text.length > 500 ? block.text.slice(0, 500) + "..." : block.text;
      parts.push(`- **${block.role}** (${style}): "${text}"`);
    }
  }

  // Children structure
  if (section.children.length > 0) {
    parts.push("### Structure");
    for (const child of section.children) {
      const size = child.width && child.height ? ` (${Math.round(child.width)}×${Math.round(child.height)})` : "";
      const layout = child.layoutMode ? `, ${child.layoutMode}` : "";
      const text = child.characters ? `: "${child.characters.slice(0, 80)}"` : "";
      parts.push(`- ${child.type} "${child.name}"${size}${layout}${text}${child.childCount > 0 ? ` [${child.childCount} children]` : ""}`);
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Asset serialization
// ---------------------------------------------------------------------------

function serializeAssets(assets: FigmaAsset[]): string {
  const parts: string[] = ["## Image Assets"];
  for (const asset of assets) {
    const fileName = asset.localPath.split("/").pop() || asset.name;
    parts.push(`- ${asset.name} → theme/assets/${fileName} (${asset.format})`);
  }
  return parts.join("\n");
}
