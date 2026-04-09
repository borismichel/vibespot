/**
 * Figma REST API client and design extraction.
 *
 * Fetches a Figma file, walks its node tree, and extracts:
 * - Design tokens (colors, typography, spacing, effects)
 * - Text content grouped by section
 * - Section structure (top-level frames)
 * - Frame screenshots and embedded images
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "../log.js";
import type {
  FigmaUrlParts,
  FigmaExtraction,
  FigmaExtractionSummary,
  FigmaSection,
  FigmaNodeSummary,
  FigmaTextBlock,
  FigmaColorToken,
  FigmaTypographyToken,
  FigmaSpacingToken,
  FigmaEffectToken,
  FigmaAsset,
} from "./types.js";

// ---------------------------------------------------------------------------
// URL Parsing
// ---------------------------------------------------------------------------

const FIGMA_URL_RE =
  /figma\.com\/(?:design|file|proto)\/([a-zA-Z0-9]+)(?:\/([^?]*))?/;

export function parseFigmaUrl(url: string): FigmaUrlParts | null {
  const match = url.match(FIGMA_URL_RE);
  if (!match) return null;

  const fileKey = match[1];
  const fileName = match[2] ? decodeURIComponent(match[2].replace(/-/g, " ")) : undefined;

  // Extract node-id from query params (format: 123-456 in URL, 123:456 for API)
  let nodeId: string | undefined;
  try {
    const parsed = new URL(url);
    const rawNodeId = parsed.searchParams.get("node-id");
    if (rawNodeId) {
      nodeId = rawNodeId.replace(/-/g, ":");
    }
  } catch { /* invalid URL — nodeId stays undefined */ }

  return { fileKey, nodeId, fileName };
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

const FIGMA_API = "https://api.figma.com";
const RATE_LIMIT_DELAYS = [10, 20, 40, 60, 120]; // seconds

async function figmaFetch<T>(endpoint: string, token: string): Promise<T> {
  const res = await fetch(`${FIGMA_API}${endpoint}`, {
    headers: { "X-Figma-Token": token },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Figma API ${res.status}: ${body.slice(0, 200)}`);
    (err as any).status = res.status;
    throw err;
  }

  return res.json() as Promise<T>;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  onStatus?: (status: string) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const is429 = status === 429;
      if (!is429 || attempt >= RATE_LIMIT_DELAYS.length) throw err;

      const wait = RATE_LIMIT_DELAYS[attempt];
      log.warn("figma", `Rate limited (429), attempt ${attempt + 1} — waiting ${wait}s`);
      if (onStatus) onStatus(`Figma rate limited — retrying in ${wait}s...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

// ---------------------------------------------------------------------------
// Figma API response types (minimal — we only type what we use)
// ---------------------------------------------------------------------------

interface FigmaColor {
  r: number; g: number; b: number; a: number;
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  // Text properties
  characters?: string;
  style?: {
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number;
    lineHeightPx?: number;
    letterSpacing?: number;
  };
  // Layout properties
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  layoutMode?: "HORIZONTAL" | "VERTICAL" | "NONE";
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  // Visual properties
  fills?: { type: string; color?: FigmaColor; opacity?: number; imageRef?: string }[];
  strokes?: { type: string; color?: FigmaColor }[];
  effects?: { type: string; color?: FigmaColor; offset?: { x: number; y: number }; radius?: number }[];
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  backgroundColor?: FigmaColor;
}

interface FigmaFileResponse {
  name: string;
  document: FigmaNode;
}

interface FigmaImagesResponse {
  images: Record<string, string>; // nodeId → download URL
}

// ---------------------------------------------------------------------------
// Node tree walking
// ---------------------------------------------------------------------------

function walkNodes(node: FigmaNode, callback: (node: FigmaNode, depth: number) => void, depth = 0): void {
  callback(node, depth);
  if (node.children) {
    for (const child of node.children) {
      walkNodes(child, callback, depth + 1);
    }
  }
}

/** Get top-level frames from the first page (CANVAS) of the document. */
function getTopLevelFrames(document: FigmaNode): FigmaNode[] {
  const canvas = document.children?.[0]; // first page
  if (!canvas?.children) return [];
  return canvas.children.filter(
    (n) => n.type === "FRAME" || n.type === "COMPONENT" || n.type === "COMPONENT_SET",
  );
}

// ---------------------------------------------------------------------------
// Color extraction
// ---------------------------------------------------------------------------

function rgbaToHex(c: FigmaColor): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function extractColors(frames: FigmaNode[]): FigmaColorToken[] {
  const colorMap = new Map<string, FigmaColorToken>();

  for (const frame of frames) {
    walkNodes(frame, (node) => {
      // Background fills
      if (node.fills) {
        for (const fill of node.fills) {
          if (fill.type === "SOLID" && fill.color) {
            const hex = rgbaToHex(fill.color);
            const existing = colorMap.get(hex);
            const isText = node.type === "TEXT";
            const usage = isText ? "text" : "fill";
            if (existing) {
              existing.occurrences++;
              if (isText && existing.usage !== "text") existing.usage = "text";
            } else {
              colorMap.set(hex, {
                hex,
                opacity: fill.opacity ?? fill.color.a,
                occurrences: 1,
                usage,
              });
            }
          }
        }
      }
      // Strokes
      if (node.strokes) {
        for (const stroke of node.strokes) {
          if (stroke.type === "SOLID" && stroke.color) {
            const hex = rgbaToHex(stroke.color);
            const existing = colorMap.get(hex);
            if (existing) {
              existing.occurrences++;
            } else {
              colorMap.set(hex, { hex, opacity: 1, occurrences: 1, usage: "border" });
            }
          }
        }
      }
    });
  }

  // Sort by occurrence count (most used first)
  return [...colorMap.values()].sort((a, b) => b.occurrences - a.occurrences);
}

// ---------------------------------------------------------------------------
// Typography extraction
// ---------------------------------------------------------------------------

function extractTypography(frames: FigmaNode[]): FigmaTypographyToken[] {
  const styleMap = new Map<string, FigmaTypographyToken>();

  for (const frame of frames) {
    walkNodes(frame, (node) => {
      if (node.type !== "TEXT" || !node.style) return;
      const s = node.style;
      const fontSize = s.fontSize || 16;
      const fontWeight = s.fontWeight || 400;
      const lineHeight = s.lineHeightPx ? Math.round((s.lineHeightPx / fontSize) * 100) / 100 : 1.5;
      const letterSpacing = s.letterSpacing || 0;
      const fontFamily = s.fontFamily || "sans-serif";

      // Infer role from font size
      let role = "body";
      if (fontSize >= 32) role = "heading";
      else if (fontSize >= 20) role = "subheading";
      else if (fontSize <= 12) role = "caption";
      else if (fontWeight >= 600 && fontSize <= 14) role = "label";

      const key = `${fontFamily}-${fontSize}-${fontWeight}`;
      const existing = styleMap.get(key);
      if (existing) {
        existing.occurrences++;
      } else {
        styleMap.set(key, { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, role, occurrences: 1 });
      }
    });
  }

  return [...styleMap.values()].sort((a, b) => b.fontSize - a.fontSize);
}

// ---------------------------------------------------------------------------
// Spacing extraction
// ---------------------------------------------------------------------------

function extractSpacing(frames: FigmaNode[]): FigmaSpacingToken[] {
  const tokens: FigmaSpacingToken[] = [];
  const seen = new Set<string>();

  for (const frame of frames) {
    walkNodes(frame, (node) => {
      if (!node.layoutMode || node.layoutMode === "NONE") return;

      if (node.itemSpacing && node.itemSpacing > 0) {
        const key = `gap-${node.itemSpacing}-${node.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          tokens.push({ context: `${node.name} gap`, value: node.itemSpacing, type: "gap" });
        }
      }

      const pt = node.paddingTop || 0;
      const pr = node.paddingRight || 0;
      const pb = node.paddingBottom || 0;
      const pl = node.paddingLeft || 0;
      if (pt > 0 || pr > 0 || pb > 0 || pl > 0) {
        const padKey = `pad-${pt}-${pr}-${pb}-${pl}-${node.name}`;
        if (!seen.has(padKey)) {
          seen.add(padKey);
          const padValue = pt === pb && pl === pr && pt === pl ? pt : Math.max(pt, pr, pb, pl);
          tokens.push({ context: `${node.name} padding`, value: padValue, type: "padding" });
        }
      }
    });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Effects extraction
// ---------------------------------------------------------------------------

function extractEffects(frames: FigmaNode[]): FigmaEffectToken[] {
  const tokens: FigmaEffectToken[] = [];
  const seen = new Set<string>();

  for (const frame of frames) {
    walkNodes(frame, (node) => {
      // Shadows
      if (node.effects) {
        for (const effect of node.effects) {
          if (effect.type === "DROP_SHADOW" && effect.color && effect.offset) {
            const { r, g, b, a } = effect.color;
            const css = `${effect.offset.x}px ${effect.offset.y}px ${effect.radius || 0}px rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${Math.round(a * 100) / 100})`;
            if (!seen.has(css)) {
              seen.add(css);
              tokens.push({ type: "shadow", cssValue: css, context: node.name });
            }
          }
        }
      }
      // Border radius
      if (node.cornerRadius && node.cornerRadius > 0) {
        const css = `${node.cornerRadius}px`;
        if (!seen.has(`radius-${css}`)) {
          seen.add(`radius-${css}`);
          tokens.push({ type: "radius", cssValue: css, context: node.name });
        }
      }
    });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Text content extraction
// ---------------------------------------------------------------------------

function extractTextContent(frame: FigmaNode, sectionName: string): FigmaTextBlock[] {
  const blocks: FigmaTextBlock[] = [];

  walkNodes(frame, (node) => {
    if (node.type !== "TEXT" || !node.characters?.trim()) return;

    const fontSize = node.style?.fontSize || 16;
    const fontWeight = node.style?.fontWeight || 400;

    let role: FigmaTextBlock["role"] = "body";
    if (fontSize >= 32) role = "headline";
    else if (fontSize >= 20) role = "subheadline";
    else if (fontSize <= 12) role = "caption";
    else if (fontWeight >= 600 && fontSize <= 16) role = "label";
    // Short bold text is likely a CTA
    if (fontWeight >= 600 && node.characters.length < 40 && fontSize >= 14 && fontSize < 32) {
      role = "cta";
    }

    blocks.push({ text: node.characters, fontSize, fontWeight, role, sectionName });
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Section structure mapping
// ---------------------------------------------------------------------------

function mapNodeSummary(node: FigmaNode): FigmaNodeSummary {
  const bb = node.absoluteBoundingBox;
  return {
    name: node.name,
    type: node.type,
    nodeId: node.id,
    width: bb?.width || 0,
    height: bb?.height || 0,
    layoutMode: node.layoutMode === "NONE" ? undefined : node.layoutMode,
    childCount: node.children?.length || 0,
    characters: node.type === "TEXT" ? node.characters : undefined,
  };
}

function getBackgroundColor(node: FigmaNode): string | undefined {
  // Check fills for background color
  if (node.fills) {
    for (const fill of node.fills) {
      if (fill.type === "SOLID" && fill.color) {
        return rgbaToHex(fill.color);
      }
    }
  }
  // Check backgroundColor property
  if (node.backgroundColor) {
    return rgbaToHex(node.backgroundColor);
  }
  return undefined;
}

function mapSections(frames: FigmaNode[]): Omit<FigmaSection, "frameImagePath">[] {
  return frames.map((frame) => {
    const bb = frame.absoluteBoundingBox;
    return {
      name: frame.name,
      nodeId: frame.id,
      width: bb?.width || 0,
      height: bb?.height || 0,
      textContent: extractTextContent(frame, frame.name),
      children: (frame.children || []).slice(0, 20).map(mapNodeSummary), // limit children for size
      backgroundColor: getBackgroundColor(frame),
      layoutMode: frame.layoutMode === "NONE" ? undefined : frame.layoutMode,
      itemSpacing: frame.itemSpacing,
      paddingTop: frame.paddingTop,
      paddingRight: frame.paddingRight,
      paddingBottom: frame.paddingBottom,
      paddingLeft: frame.paddingLeft,
    };
  });
}

// ---------------------------------------------------------------------------
// Image node detection (for embedded images like photos, logos)
// ---------------------------------------------------------------------------

function findImageNodes(frames: FigmaNode[]): { nodeId: string; name: string }[] {
  const images: { nodeId: string; name: string }[] = [];

  for (const frame of frames) {
    walkNodes(frame, (node) => {
      if (!node.fills) return;
      for (const fill of node.fills) {
        if (fill.type === "IMAGE" && fill.imageRef) {
          images.push({ nodeId: node.id, name: node.name || "image" });
          break; // one per node
        }
      }
    });
  }

  return images;
}

// ---------------------------------------------------------------------------
// Image downloading
// ---------------------------------------------------------------------------

async function downloadImage(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buffer);
}

async function exportFrameImages(
  fileKey: string,
  frames: FigmaNode[],
  token: string,
  targetDir: string,
  onStatus?: (status: string) => void,
): Promise<Map<string, string>> {
  if (frames.length === 0) return new Map();

  mkdirSync(targetDir, { recursive: true });

  const nodeIds = frames.map((f) => f.id);
  const idParam = nodeIds.join(",");

  if (onStatus) onStatus("Exporting frame screenshots...");

  const response = await withRetry(
    () => figmaFetch<FigmaImagesResponse>(`/v1/images/${fileKey}?ids=${idParam}&format=png&scale=2`, token),
    onStatus,
  );

  const result = new Map<string, string>();

  for (const [nodeId, imageUrl] of Object.entries(response.images)) {
    if (!imageUrl) continue;
    const safeName = nodeId.replace(/:/g, "-");
    const destPath = join(targetDir, `frame-${safeName}.png`);
    try {
      await downloadImage(imageUrl, destPath);
      result.set(nodeId, destPath);
      log.info("figma", `Downloaded frame screenshot: ${destPath}`);
    } catch (err) {
      log.warn("figma", `Failed to download frame ${nodeId}: ${err}`);
    }
  }

  return result;
}

async function exportEmbeddedImages(
  fileKey: string,
  imageNodes: { nodeId: string; name: string }[],
  token: string,
  assetsDir: string,
  onStatus?: (status: string) => void,
): Promise<FigmaAsset[]> {
  if (imageNodes.length === 0) return [];

  mkdirSync(assetsDir, { recursive: true });

  // Batch export — Figma supports up to ~100 IDs per request
  const batchSize = 50;
  const assets: FigmaAsset[] = [];

  for (let i = 0; i < imageNodes.length; i += batchSize) {
    const batch = imageNodes.slice(i, i + batchSize);
    const idParam = batch.map((n) => n.nodeId).join(",");

    if (onStatus) onStatus(`Exporting images (${i + 1}-${Math.min(i + batchSize, imageNodes.length)} of ${imageNodes.length})...`);

    const response = await withRetry(
      () => figmaFetch<FigmaImagesResponse>(`/v1/images/${fileKey}?ids=${idParam}&format=png&scale=2`, token),
      onStatus,
    );

    for (const node of batch) {
      const imageUrl = response.images[node.nodeId];
      if (!imageUrl) continue;

      const safeName = node.name.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
      const fileName = `${safeName}-${randomUUID().slice(0, 6)}.png`;
      const destPath = join(assetsDir, fileName);

      try {
        await downloadImage(imageUrl, destPath);
        assets.push({ name: node.name, localPath: destPath, nodeId: node.nodeId, format: "png" });
        log.info("figma", `Downloaded asset: ${fileName}`);
      } catch (err) {
        log.warn("figma", `Failed to download image ${node.name}: ${err}`);
      }
    }
  }

  return assets;
}

// ---------------------------------------------------------------------------
// Main extraction entry point
// ---------------------------------------------------------------------------

export async function extractFigmaDesign(
  fileKey: string,
  nodeId: string | undefined,
  token: string,
  themePath: string,
  onStatus?: (status: string) => void,
): Promise<FigmaExtraction> {
  // 1. Fetch the file tree
  if (onStatus) onStatus("Fetching Figma file...");
  const endpoint = nodeId
    ? `/v1/files/${fileKey}?ids=${nodeId}&geometry=paths`
    : `/v1/files/${fileKey}?geometry=paths`;

  const fileData = await withRetry(
    () => figmaFetch<FigmaFileResponse>(endpoint, token),
    onStatus,
  );

  log.info("figma", `Fetched file: ${fileData.name}`);

  // 2. Get top-level frames
  const topFrames = getTopLevelFrames(fileData.document);
  if (topFrames.length === 0) {
    throw new Error("No frames found in the Figma file. The file may be empty or structured differently.");
  }

  log.info("figma", `Found ${topFrames.length} top-level frames`);
  if (onStatus) onStatus(`Found ${topFrames.length} sections. Extracting design tokens...`);

  // 3. Extract design tokens
  const designTokens = {
    colors: extractColors(topFrames),
    typography: extractTypography(topFrames),
    spacing: extractSpacing(topFrames),
    effects: extractEffects(topFrames),
  };

  log.info("figma", "Design tokens extracted", {
    colors: designTokens.colors.length,
    typography: designTokens.typography.length,
    spacing: designTokens.spacing.length,
    effects: designTokens.effects.length,
  });

  // 4. Map sections
  if (onStatus) onStatus("Mapping page structure...");
  const sectionsPartial = mapSections(topFrames);

  // 5. Export frame screenshots
  const tempDir = join(themePath, ".vibespot", "figma-frames");
  const frameImages = await exportFrameImages(fileKey, topFrames, token, tempDir, onStatus);

  const sections: FigmaSection[] = sectionsPartial.map((s) => ({
    ...s,
    frameImagePath: frameImages.get(s.nodeId) || "",
  }));

  // 6. Find and export embedded images
  if (onStatus) onStatus("Extracting image assets...");
  const imageNodes = findImageNodes(topFrames);
  const assetsDir = join(themePath, "assets");
  const assets = await exportEmbeddedImages(fileKey, imageNodes, token, assetsDir, onStatus);

  log.info("figma", `Extraction complete: ${sections.length} sections, ${assets.length} assets`);

  return {
    fileName: fileData.name,
    fileUrl: `https://www.figma.com/design/${fileKey}`,
    designTokens,
    sections,
    assets,
  };
}

// ---------------------------------------------------------------------------
// Summary builder (for UI display — lightweight)
// ---------------------------------------------------------------------------

export function buildExtractionSummary(extraction: FigmaExtraction): FigmaExtractionSummary {
  // Kebab-case the file name for theme suggestion
  const suggestedThemeName = extraction.fileName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);

  return {
    fileName: extraction.fileName,
    fileUrl: extraction.fileUrl,
    sectionNames: extraction.sections.map((s) => s.name),
    sectionCount: extraction.sections.length,
    colorPalette: extraction.designTokens.colors.slice(0, 10).map((c) => c.hex),
    fontFamilies: [...new Set(extraction.designTokens.typography.map((t) => t.fontFamily))],
    textBlockCount: extraction.sections.reduce((sum, s) => sum + s.textContent.length, 0),
    assetCount: extraction.assets.length,
    suggestedThemeName,
  };
}

// ---------------------------------------------------------------------------
// Token test
// ---------------------------------------------------------------------------

export async function testFigmaToken(token: string): Promise<{ handle: string; email: string }> {
  const res = await figmaFetch<{ handle: string; email: string }>("/v1/me", token);
  return res;
}
