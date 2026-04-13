/**
 * HTTP routes for Figma design import.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";
import { jsonResponse, readJsonBody } from "../route-helpers.js";
import { loadConfig } from "../../utils/config.js";
import { log } from "../log.js";
import { parseFigmaUrl, extractFigmaDesign, buildExtractionSummary, testFigmaToken } from "../figma/extractor.js";
import type { FigmaExtraction } from "../figma/types.js";
import { getSession, getOrderedModules, saveSession } from "../session.js";
import { updateModules, reorderModules } from "../session/state.js";
import { writeModulesToDisk } from "../session/disk.js";
import { commitThemeState } from "../project-git.js";
import { handleFigmaImport, applyPipelineResult } from "../ai-handler.js";
import { addTemplate } from "../session/templates.js";

// ---------------------------------------------------------------------------
// In-memory extraction cache (avoids sending large data through WebSocket)
// ---------------------------------------------------------------------------

const extractionCache = new Map<string, { extraction: FigmaExtraction; expires: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function cleanCache(): void {
  const now = Date.now();
  for (const [id, entry] of extractionCache) {
    if (entry.expires < now) extractionCache.delete(id);
  }
}

export function getCachedExtraction(id: string): FigmaExtraction | null {
  cleanCache();
  const entry = extractionCache.get(id);
  if (!entry) return null;
  extractionCache.delete(id); // one-time use
  return entry.extraction;
}

// ---------------------------------------------------------------------------
// POST /api/figma/test-token
// ---------------------------------------------------------------------------

export function handleFigmaTestTokenRoute(req: IncomingMessage, res: ServerResponse): void {
  readJsonBody<{ token?: string }>(req, res, async (body) => {
    const token = body.token || loadConfig().figmaToken;
    if (!token) {
      jsonResponse(res, 400, { ok: false, error: "No Figma token provided" });
      return;
    }

    try {
      const user = await testFigmaToken(token);
      jsonResponse(res, 200, { ok: true, user });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("figma", `Token test failed: ${msg}`);
      jsonResponse(res, 200, { ok: false, error: "Invalid or expired Figma token" });
    }
  });
}

// ---------------------------------------------------------------------------
// POST /api/figma/extract
// ---------------------------------------------------------------------------

export function handleFigmaExtractRoute(req: IncomingMessage, res: ServerResponse): void {
  readJsonBody<{ url?: string; token?: string }>(req, res, async (body) => {
    const url = body.url;
    if (!url) {
      jsonResponse(res, 400, { error: "Missing 'url' field" });
      return;
    }

    const token = body.token || loadConfig().figmaToken;
    if (!token) {
      jsonResponse(res, 400, { error: "No Figma token configured. Add one in Settings." });
      return;
    }

    // Parse the URL
    const parsed = parseFigmaUrl(url);
    if (!parsed) {
      jsonResponse(res, 400, { error: "Not a valid Figma URL. Expected: figma.com/design/<key>/..." });
      return;
    }

    // Determine a temp theme path for frame screenshots
    const session = getSession();
    const themePath = session?.themePath || `/tmp/vibespot-figma-${randomUUID().slice(0, 8)}`;

    // Stream progress via SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendEvent = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const extraction = await extractFigmaDesign(
        parsed.fileKey,
        parsed.nodeId,
        token,
        themePath,
        (status) => sendEvent({ type: "progress", message: status }),
      );

      // Cache the full extraction for later retrieval via WebSocket
      const extractionId = randomUUID();
      cleanCache();
      extractionCache.set(extractionId, {
        extraction,
        expires: Date.now() + CACHE_TTL,
      });

      const summary = buildExtractionSummary(extraction);

      sendEvent({ type: "complete", ok: true, extractionId, summary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("figma", `Extraction failed: ${msg}`);

      let error = msg;
      if (msg.includes("403")) error = "Cannot access this file. Check sharing permissions and your token.";
      else if (msg.includes("404")) error = "Figma file not found. Check the URL.";
      else if (msg.includes("429")) error = "Figma rate limited. Try again in a minute.";

      sendEvent({ type: "complete", ok: false, error });
    }

    res.end();
  });
}

// ---------------------------------------------------------------------------
// Styleguide generation from Figma design tokens
// ---------------------------------------------------------------------------

function generateStyleguide(extraction: FigmaExtraction): string {
  const { designTokens, fileName } = extraction;
  const lines: string[] = [`# Styleguide — ${fileName}`, ""];

  // Colors
  if (designTokens.colors.length > 0) {
    lines.push("## Colors", "");
    const sorted = [...designTokens.colors].sort((a, b) => b.count - a.count);
    const primary = sorted[0];
    const secondary = sorted[1];
    if (primary) lines.push(`- **Primary:** \`${primary.hex}\` (${primary.name || "dominant color"})`);
    if (secondary) lines.push(`- **Secondary:** \`${secondary.hex}\` (${secondary.name || "accent color"})`);
    lines.push("");
    lines.push("### Full palette", "");
    for (const c of sorted.slice(0, 15)) {
      const label = c.name ? `${c.name}` : `${c.count}× used`;
      lines.push(`- \`${c.hex}\` — ${label}`);
    }
    lines.push("");
  }

  // Typography
  if (designTokens.typography.length > 0) {
    lines.push("## Typography", "");
    const families = [...new Set(designTokens.typography.map((t) => t.fontFamily))];
    lines.push(`**Font families:** ${families.join(", ")}`, "");
    lines.push("| Role | Family | Size | Weight |");
    lines.push("|------|--------|------|--------|");
    const seen = new Set<string>();
    for (const t of designTokens.typography) {
      const key = `${t.role}-${t.fontSize}-${t.fontWeight}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`| ${t.role} | ${t.fontFamily} | ${t.fontSize}px | ${t.fontWeight} |`);
    }
    lines.push("");
  }

  // Spacing
  if (designTokens.spacing.length > 0) {
    lines.push("## Spacing", "");
    const spacingValues = [...new Set(designTokens.spacing.map((s) => s.value))].sort((a, b) => a - b);
    lines.push(`**Scale:** ${spacingValues.join("px, ")}px`, "");
    for (const s of designTokens.spacing) {
      lines.push(`- **${s.property}** (${s.context}): ${s.value}px`);
    }
    lines.push("");
  }

  // Effects
  if (designTokens.effects.length > 0) {
    lines.push("## Effects", "");
    for (const e of designTokens.effects) {
      if (e.boxShadow) lines.push(`- **Box shadow:** \`${e.boxShadow}\``);
      if (e.borderRadius) lines.push(`- **Border radius:** ${e.borderRadius}px`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// POST /api/figma/generate — runs pipeline, streams SSE progress
// ---------------------------------------------------------------------------

export function handleFigmaGenerateRoute(req: IncomingMessage, res: ServerResponse): void {
  readJsonBody<{ extractionId?: string; themeName?: string; useAssets?: boolean }>(req, res, async (body) => {
    const extractionId = body.extractionId;
    const themeName = body.themeName;
    const useAssets = body.useAssets !== false; // default true
    if (!extractionId || !themeName) {
      jsonResponse(res, 400, { error: "Missing extractionId or themeName" });
      return;
    }

    const extraction = getCachedExtraction(extractionId);
    if (!extraction) {
      jsonResponse(res, 400, { error: "Extraction expired or not found. Please re-extract." });
      return;
    }

    const session = getSession();
    if (!session) {
      jsonResponse(res, 400, { error: "No active session. Create a theme first." });
      return;
    }

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendEvent = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // 1. Generate and save styleguide from design tokens
      sendEvent({ type: "progress", message: "Generating styleguide from design tokens..." });
      const styleguide = generateStyleguide(extraction);
      const assetDir = join(session.themePath, ".vibespot");
      if (!existsSync(assetDir)) mkdirSync(assetDir, { recursive: true });
      writeFileSync(join(assetDir, "styleguide.md"), styleguide);
      if (!session.brandAssets) session.brandAssets = {};
      session.brandAssets.styleguide = styleguide;
      saveSession();
      sendEvent({ type: "progress", message: "Styleguide saved." });

      // 2. Create (or reset) a template for the Figma import
      //    Figma import replaces all modules — clear existing ones first
      if (session.templates.length === 0) {
        addTemplate("landing_page", "Landing Page");
      } else {
        // Clear existing modules from the active template so the import starts fresh
        session.modules = [];
        session.moduleOrder = [];
        session.sharedCss = "";
        session.sharedJs = "";
        const tpl = session.templates.find((t) => t.id === session.activeTemplateId);
        if (tpl) {
          tpl.modules = [];
          tpl.moduleOrder = [];
          tpl.sharedCss = "";
          tpl.sharedJs = "";
        }
      }
      saveSession();

      // 3. Copy extracted assets into the theme's assets directory
      if (useAssets && extraction.assets.length > 0) {
        const themeAssetsDir = join(session.themePath, "assets");
        mkdirSync(themeAssetsDir, { recursive: true });
        let copied = 0;
        for (const asset of extraction.assets) {
          if (existsSync(asset.localPath)) {
            const dest = join(themeAssetsDir, basename(asset.localPath));
            try {
              copyFileSync(asset.localPath, dest);
              asset.localPath = dest; // update path so pipeline references the theme copy
              copied++;
            } catch { /* non-critical */ }
          }
        }
        if (copied > 0) {
          sendEvent({ type: "progress", message: `Copied ${copied} image assets to theme.` });
        }
      }

      // 4. Run the conversion pipeline
      sendEvent({ type: "progress", message: "Starting AI conversion..." });

      const pipelineSteps: { step: string; label: string; decisions?: string[] }[] = [];
      const pipelineModules: { name: string; status: "complete" | "failed" }[] = [];

      const result = await handleFigmaImport(
        extraction,
        themeName,
        (event) => {
          // Forward pipeline events as SSE progress
          if (event.type === "agent_step") {
            pipelineSteps.push({ step: event.step, label: event.label });
            sendEvent({ type: "progress", message: `${event.label}...` });
          } else if (event.type === "agent_decision") {
            const last = pipelineSteps[pipelineSteps.length - 1];
            if (last) {
              if (!last.decisions) last.decisions = [];
              last.decisions.push(event.decision);
            }
            sendEvent({ type: "progress", message: `  ${event.decision}` });
          } else if (event.type === "design_system_ready") {
            updateModules({ sharedCss: event.sharedCss, sharedJs: event.sharedJs });
          } else if (event.type === "blueprint_ready") {
            updateModules({ sharedCss: event.sharedCss, sharedJs: event.sharedJs });
            reorderModules(event.moduleOrder);
            sendEvent({ type: "progress", message: `Planned ${event.moduleOrder.length} modules` });
          } else if (event.type === "module_progress") {
            if (event.status === "generating") {
              sendEvent({ type: "progress", message: `Generating module: ${event.module}` });
            } else if (event.status === "complete" && event.moduleFiles) {
              updateModules({ modules: [{
                moduleName: event.module,
                fieldsJson: event.moduleFiles.fieldsJson,
                metaJson: event.moduleFiles.metaJson,
                moduleHtml: event.moduleFiles.moduleHtml,
                moduleCss: event.moduleFiles.moduleCss,
                moduleJs: event.moduleFiles.moduleJs,
              }] });
              pipelineModules.push({ name: event.module, status: "complete" });
              sendEvent({ type: "progress", message: `Module complete: ${event.module}` });
            } else if (event.status === "failed") {
              pipelineModules.push({ name: event.module, status: "failed" });
              sendEvent({ type: "progress", message: `Module failed: ${event.module}` });
            }
          }
        },
        { useAssets },
      );

      // 5. Apply result and write to disk
      applyPipelineResult(result, {
        steps: pipelineSteps,
        modules: pipelineModules,
        stats: result.stats,
      });
      writeModulesToDisk();
      commitThemeState(session.themePath, `Figma import: ${extraction.fileName}`);

      const moduleNames = getOrderedModules().map((m) => m.moduleName);
      sendEvent({ type: "progress", message: `Conversion complete — ${moduleNames.length} modules generated` });
      sendEvent({ type: "complete", ok: true, modules: moduleNames });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("figma", `Generate failed: ${msg}`);
      sendEvent({ type: "complete", ok: false, error: msg });
    }

    res.end();
  });
}
