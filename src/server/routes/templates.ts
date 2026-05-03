/**
 * Dashboard & template routes — CRUD, activate, rename, module library, brand assets, download.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";

const _shellOpt: ExecFileSyncOptions = process.platform === "win32" ? { shell: true } : {};
import { jsonResponse, readBody } from "../route-helpers.js";
import { log } from "../log.js";
import { getHubSpotPak } from "../../utils/config.js";
import { addEmailTemplateToTheme } from "../../hubspot/theme-scaffold.js";
import {
  getSession,
  saveSession,
  getOrderedModules,
  getActiveTemplate,
  setActiveTemplate,
  addTemplate,
  removeTemplate,
  cloneTemplate,
  getModuleLibrary,
  renameTemplate,
  reorderTemplates,
  type PageType,
} from "../session.js";
import { ensureDir, writeFile } from "../../utils/fs.js";

export function handleDashboardRoute(res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  const library = getModuleLibrary();
  jsonResponse(res, 200, {
    themeName: session.themeName,
    themePath: session.themePath,
    templates: session.templates.map((t) => ({
      id: t.id,
      label: t.label,
      pageType: t.contentMode === "email" ? "email" : t.pageType,
      moduleCount: t.modules.length,
      messageCount: t.messages.length,
    })),
    activeTemplateId: session.activeTemplateId,
    moduleLibrary: library.map((entry) => ({
      moduleName: entry.module.moduleName,
      usedIn: entry.usedIn,
    })),
    brandAssets: {
      hasStyleguide: !!session.brandAssets?.styleguide,
      hasBrandvoice: !!session.brandAssets?.brandvoice,
      hasThemeContext: !!session.brandAssets?.themeContext,
      humanify: session.brandAssets?.humanify !== false,
      hasBrandKit: !!session.brandAssets?.brandKit && Object.keys(session.brandAssets.brandKit).length > 0,
      brandKit: session.brandAssets?.brandKit || null,
    },
  });
}

export function handleDownloadZipRoute(res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  const themePath = session.themePath;
  if (!existsSync(themePath)) {
    jsonResponse(res, 404, { error: "Theme directory not found" });
    return;
  }

  const themeName = session.themeName || "theme";
  const parentDir = join(themePath, "..");
  const folderName = basename(themePath);

  try {
    const zipFileName = `${themeName}.zip`;
    const tmpZip = join(parentDir, zipFileName);

    if (existsSync(tmpZip)) rmSync(tmpZip);

    execFileSync("zip", [
      "-r", zipFileName, folderName,
      "-x", `${folderName}/.git/*`, `${folderName}/.vibespot/*`, `${folderName}/node_modules/*`,
    ], { cwd: parentDir, timeout: 30_000, ..._shellOpt });

    const zipData = readFileSync(tmpZip);
    rmSync(tmpZip);

    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipFileName}"`,
      "Content-Length": zipData.length,
    });
    res.end(zipData);
  } catch (err: any) {
    log.error("download-zip", "Failed to create zip archive", err);
    jsonResponse(res, 500, { error: "Failed to create zip archive" });
  }
}

export function handleTemplatesRoute(method: string, req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  if (method === "GET") {
    jsonResponse(res, 200, {
      templates: session.templates.map((t) => ({
        id: t.id,
        label: t.label,
        pageType: t.contentMode === "email" ? "email" : t.pageType,
        moduleCount: t.modules.length,
      })),
      activeTemplateId: session.activeTemplateId,
    });
    return;
  }

  if (method === "POST") {
    readBody(req, (body) => {
      try {
        const { pageType, label } = JSON.parse(body);
        if (!pageType || !label) {
          jsonResponse(res, 400, { error: "pageType and label are required" });
          return;
        }
        const validTypes = ["landing_page", "blog_post", "website_page", "module_only", "email"];
        if (!validTypes.includes(pageType)) {
          jsonResponse(res, 400, { error: `Invalid pageType: ${pageType}` });
          return;
        }

        const isEmail = pageType === "email";
        const resolvedPageType: PageType = isEmail ? "module_only" : pageType;
        const entry = addTemplate(resolvedPageType, label, isEmail ? "email" : undefined);

        if (isEmail && session.themePath) {
          addEmailTemplateToTheme(session.themePath, session.themeName);
        }

        saveSession();

        jsonResponse(res, 200, {
          ok: true,
          template: {
            id: entry.id,
            label: entry.label,
            pageType: entry.pageType,
          },
        });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  if (method === "DELETE") {
    readBody(req, (body) => {
      try {
        const { templateId, deleteModules } = JSON.parse(body);
        if (!templateId) {
          jsonResponse(res, 400, { error: "templateId is required" });
          return;
        }
        const removed = removeTemplate(templateId, !!deleteModules);
        if (!removed) {
          jsonResponse(res, 404, { error: "Template not found" });
          return;
        }
        saveSession();
        jsonResponse(res, 200, { ok: true });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  jsonResponse(res, 405, { error: "Method not allowed" });
}

export function handleTemplateActivateRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { templateId } = JSON.parse(body);
      if (!templateId) {
        jsonResponse(res, 400, { error: "templateId is required" });
        return;
      }
      const success = setActiveTemplate(templateId);
      if (!success) {
        jsonResponse(res, 404, { error: "Template not found" });
        return;
      }
      saveSession();
      const session = getSession();
      jsonResponse(res, 200, {
        ok: true,
        modules: getOrderedModules().map((m) => m.moduleName),
        messageCount: session?.messages.length || 0,
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleTemplateRenameRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { templateId, newLabel } = JSON.parse(body);
      if (!templateId || !newLabel || typeof newLabel !== "string") {
        jsonResponse(res, 400, { error: "templateId and newLabel are required" });
        return;
      }
      const success = renameTemplate(templateId, newLabel.trim());
      if (!success) {
        jsonResponse(res, 404, { error: "Template not found" });
        return;
      }
      saveSession();
      jsonResponse(res, 200, { ok: true, newLabel: newLabel.trim() });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleTemplateReorderRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { templateIds } = JSON.parse(body);
      if (!Array.isArray(templateIds) || templateIds.some((id) => typeof id !== "string")) {
        jsonResponse(res, 400, { error: "templateIds must be an array of strings" });
        return;
      }
      const ok = reorderTemplates(templateIds);
      if (!ok) {
        jsonResponse(res, 400, { error: "Reorder rejected (length mismatch or no session)" });
        return;
      }
      saveSession();
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleTemplateCloneRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { templateId, label } = JSON.parse(body);
      if (!templateId) {
        jsonResponse(res, 400, { error: "templateId is required" });
        return;
      }
      const entry = cloneTemplate(templateId, label);
      if (!entry) {
        jsonResponse(res, 404, { error: "Template not found" });
        return;
      }
      saveSession();
      jsonResponse(res, 200, {
        ok: true,
        template: {
          id: entry.id,
          label: entry.label,
          pageType: entry.pageType,
          moduleCount: entry.modules.length,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleModuleLibraryRoute(res: ServerResponse): void {
  const library = getModuleLibrary();
  jsonResponse(res, 200, {
    modules: library.map((entry) => ({
      moduleName: entry.module.moduleName,
      usedIn: entry.usedIn,
      fieldsJson: entry.module.fieldsJson,
    })),
  });
}

export function handleAddModuleToTemplateRoute(path: string, req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  readBody(req, (body) => {
    try {
      const { moduleName } = JSON.parse(body);
      if (!moduleName) {
        jsonResponse(res, 400, { error: "moduleName is required" });
        return;
      }

      const library = getModuleLibrary();
      const entry = library.find((e) => e.module.moduleName === moduleName);
      if (!entry) {
        jsonResponse(res, 404, { error: `Module "${moduleName}" not found in library` });
        return;
      }

      const modCopy = { ...entry.module };
      const existing = session.modules.find((m) => m.moduleName === modCopy.moduleName);
      if (!existing) {
        session.modules.push(modCopy);
        session.moduleOrder.push(modCopy.moduleName);
        session.updatedAt = Date.now();
      }

      saveSession();
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function handleBrandAssetsRoute(method: string, req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  if (method === "GET") {
    jsonResponse(res, 200, {
      styleguide: session.brandAssets?.styleguide || null,
      brandvoice: session.brandAssets?.brandvoice || null,
      themeContext: session.brandAssets?.themeContext || null,
    });
    return;
  }

  if (method === "POST") {
    readBody(req, (body) => {
      try {
        const { type, content } = JSON.parse(body);
        if (!type) {
          jsonResponse(res, 400, { error: "type is required" });
          return;
        }

        if (!session.brandAssets) session.brandAssets = {};

        if (type === "humanify") {
          session.brandAssets.humanify = content === "on";
          session.updatedAt = Date.now();
          saveSession();
          jsonResponse(res, 200, { ok: true });
          return;
        }

        if (!content) {
          jsonResponse(res, 400, { error: "content is required" });
          return;
        }
        if (type !== "styleguide" && type !== "brandvoice" && type !== "themeContext") {
          jsonResponse(res, 400, { error: `Invalid type: ${type}. Must be "styleguide", "brandvoice", or "themeContext"` });
          return;
        }
        const assetKey = type as "styleguide" | "brandvoice" | "themeContext";

        const filename = assetKey === "themeContext" ? "theme-context.md" : `${assetKey}.md`;
        session.brandAssets[assetKey] = content;
        session.updatedAt = Date.now();

        const assetDir = join(session.themePath, ".vibespot");
        ensureDir(assetDir);
        writeFile(join(assetDir, filename), content);

        let syncedKit: import("../session/types.js").BrandKit | null = null;
        if (assetKey === "styleguide") {
          syncedKit = syncBrandKitFromStyleguide(session, content);
        }

        saveSession();
        jsonResponse(res, 200, { ok: true, brandKit: syncedKit });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  if (method === "DELETE") {
    readBody(req, (body) => {
      try {
        const { type } = JSON.parse(body);
        if (type !== "styleguide" && type !== "brandvoice" && type !== "themeContext") {
          jsonResponse(res, 400, { error: `Invalid type: ${type}` });
          return;
        }
        const delKey = type as "styleguide" | "brandvoice" | "themeContext";

        if (session.brandAssets) {
          delete session.brandAssets[delKey];
        }
        session.updatedAt = Date.now();

        const delFilename = delKey === "themeContext" ? "theme-context.md" : `${delKey}.md`;
        const filePath = join(session.themePath, ".vibespot", delFilename);
        if (existsSync(filePath)) rmSync(filePath);

        saveSession();
        jsonResponse(res, 200, { ok: true });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  jsonResponse(res, 405, { error: "Method not allowed" });
}

// ---------------------------------------------------------------------------
// Curated font list — system-safe + popular web fonts grouped by category
// ---------------------------------------------------------------------------

const FONT_LIST: { name: string; stack: string; category: string }[] = [
  // System
  { name: "System Default", stack: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", category: "system" },
  // Sans-serif
  { name: "Inter", stack: "Inter, system-ui, sans-serif", category: "sans-serif" },
  { name: "DM Sans", stack: "'DM Sans', system-ui, sans-serif", category: "sans-serif" },
  { name: "Open Sans", stack: "'Open Sans', system-ui, sans-serif", category: "sans-serif" },
  { name: "Roboto", stack: "Roboto, system-ui, sans-serif", category: "sans-serif" },
  { name: "Lato", stack: "Lato, system-ui, sans-serif", category: "sans-serif" },
  { name: "Montserrat", stack: "Montserrat, system-ui, sans-serif", category: "sans-serif" },
  { name: "Poppins", stack: "Poppins, system-ui, sans-serif", category: "sans-serif" },
  { name: "Nunito", stack: "Nunito, system-ui, sans-serif", category: "sans-serif" },
  { name: "Raleway", stack: "Raleway, system-ui, sans-serif", category: "sans-serif" },
  { name: "Work Sans", stack: "'Work Sans', system-ui, sans-serif", category: "sans-serif" },
  { name: "Source Sans 3", stack: "'Source Sans 3', system-ui, sans-serif", category: "sans-serif" },
  { name: "Manrope", stack: "Manrope, system-ui, sans-serif", category: "sans-serif" },
  { name: "Plus Jakarta Sans", stack: "'Plus Jakarta Sans', system-ui, sans-serif", category: "sans-serif" },
  { name: "Outfit", stack: "Outfit, system-ui, sans-serif", category: "sans-serif" },
  { name: "Space Grotesk", stack: "'Space Grotesk', system-ui, sans-serif", category: "sans-serif" },
  { name: "Albert Sans", stack: "'Albert Sans', system-ui, sans-serif", category: "sans-serif" },
  { name: "Figtree", stack: "Figtree, system-ui, sans-serif", category: "sans-serif" },
  { name: "Helvetica", stack: "Helvetica, Arial, sans-serif", category: "sans-serif" },
  { name: "Arial", stack: "Arial, Helvetica, sans-serif", category: "sans-serif" },
  { name: "Verdana", stack: "Verdana, Geneva, sans-serif", category: "sans-serif" },
  // Serif
  { name: "Georgia", stack: "Georgia, 'Times New Roman', serif", category: "serif" },
  { name: "Playfair Display", stack: "'Playfair Display', Georgia, serif", category: "serif" },
  { name: "Merriweather", stack: "Merriweather, Georgia, serif", category: "serif" },
  { name: "Lora", stack: "Lora, Georgia, serif", category: "serif" },
  { name: "PT Serif", stack: "'PT Serif', Georgia, serif", category: "serif" },
  { name: "Libre Baskerville", stack: "'Libre Baskerville', Georgia, serif", category: "serif" },
  { name: "Source Serif 4", stack: "'Source Serif 4', Georgia, serif", category: "serif" },
  { name: "Cormorant Garamond", stack: "'Cormorant Garamond', Garamond, serif", category: "serif" },
  { name: "Times New Roman", stack: "'Times New Roman', Times, serif", category: "serif" },
  // Display
  { name: "Sora", stack: "Sora, system-ui, sans-serif", category: "display" },
  { name: "Clash Display", stack: "'Clash Display', system-ui, sans-serif", category: "display" },
  { name: "Cabinet Grotesk", stack: "'Cabinet Grotesk', system-ui, sans-serif", category: "display" },
  { name: "Satoshi", stack: "Satoshi, system-ui, sans-serif", category: "display" },
  { name: "General Sans", stack: "'General Sans', system-ui, sans-serif", category: "display" },
  // Monospace
  { name: "JetBrains Mono", stack: "'JetBrains Mono', 'Fira Code', monospace", category: "monospace" },
  { name: "Fira Code", stack: "'Fira Code', 'Courier New', monospace", category: "monospace" },
  { name: "Source Code Pro", stack: "'Source Code Pro', monospace", category: "monospace" },
  { name: "Courier New", stack: "'Courier New', Courier, monospace", category: "monospace" },
];

export function handleFontsRoute(_req: IncomingMessage, res: ServerResponse): void {
  jsonResponse(res, 200, FONT_LIST);
}

// ---------------------------------------------------------------------------
// Parse brand tokens from styleguide markdown
// ---------------------------------------------------------------------------

const HEX_RE = /#[0-9a-fA-F]{6}\b/g;
const FONT_FAMILY_RE = /font[- ]?famil(?:y|ies)\s*[:=]\s*([^\n]+)/gi;

function parseStyleguideTokens(markdown: string): { colors: string[]; fonts: string[] } {
  const colors: string[] = [];
  const fonts: string[] = [];

  const lines = markdown.split("\n");
  let inColorSection = false;
  let inTypographySection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^##\s+color/i.test(trimmed)) { inColorSection = true; inTypographySection = false; continue; }
    if (/^##\s+typography/i.test(trimmed)) { inTypographySection = true; inColorSection = false; continue; }
    if (/^##\s+/.test(trimmed) && !(/color/i.test(trimmed) || /typography/i.test(trimmed))) {
      inColorSection = false; inTypographySection = false; continue;
    }

    if (inColorSection) {
      const hexMatches = trimmed.match(HEX_RE);
      if (hexMatches) {
        for (const h of hexMatches) {
          if (!colors.includes(h.toLowerCase())) colors.push(h.toLowerCase());
        }
      }
    }

    if (inTypographySection) {
      const fontMatch = FONT_FAMILY_RE.exec(trimmed);
      FONT_FAMILY_RE.lastIndex = 0;
      if (fontMatch) {
        const raw = fontMatch[1].trim().replace(/['"`]/g, "").split(",")[0].trim();
        if (raw && !fonts.includes(raw)) fonts.push(raw);
      }

      if (/\bheading|body|display|monospace\b/i.test(trimmed) && !fontMatch) {
        const colonPart = trimmed.split(":").slice(1).join(":").trim();
        if (colonPart) {
          const raw = colonPart.replace(/['"`*]/g, "").split(",")[0].trim().split("(")[0].trim();
          if (raw && raw.length < 60 && !/^\d/.test(raw) && !fonts.includes(raw)) fonts.push(raw);
        }
      }
    }
  }

  return { colors: colors.slice(0, 6), fonts: fonts.slice(0, 4) };
}

function syncBrandKitFromStyleguide(
  session: NonNullable<ReturnType<typeof getSession>>,
  styleguide: string,
): import("../session/types.js").BrandKit | null {
  const { colors, fonts } = parseStyleguideTokens(styleguide);
  if (colors.length === 0 && fonts.length === 0) return null;

  if (!session.brandAssets) session.brandAssets = {};
  const kit: import("../session/types.js").BrandKit = session.brandAssets.brandKit || {};

  if (colors.length > 0) {
    if (!kit.colors) kit.colors = {};
    if (colors[0]) kit.colors.primary = colors[0];
    if (colors[1]) kit.colors.secondary = colors[1];
    if (colors[2]) kit.colors.accent = colors[2];
  }

  if (fonts.length > 0) {
    if (!kit.fonts) kit.fonts = {};
    const matchFont = (name: string) => {
      const lower = name.toLowerCase();
      const match = FONT_LIST.find((f) => f.name.toLowerCase() === lower);
      return match ? match.stack : name;
    };
    if (fonts[0]) kit.fonts.heading = matchFont(fonts[0]);
    if (fonts[1]) kit.fonts.body = matchFont(fonts[1]);
    else if (fonts[0]) kit.fonts.body = matchFont(fonts[0]);
  }

  session.brandAssets.brandKit = kit;

  const assetDir = join(session.themePath, ".vibespot");
  ensureDir(assetDir);
  writeFile(join(assetDir, "brand-kit.json"), JSON.stringify(kit, null, 2));

  return kit;
}

// ---------------------------------------------------------------------------
// Brand kit CRUD
// ---------------------------------------------------------------------------

const VALID_HEX = /^#[0-9a-fA-F]{6}$/;

export function handleBrandKitRoute(method: string, req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  if (method === "GET") {
    jsonResponse(res, 200, session.brandAssets?.brandKit || {});
    return;
  }

  if (method === "POST") {
    readBody(req, (body) => {
      try {
        const kit = JSON.parse(body);
        if (!session.brandAssets) session.brandAssets = {};

        const cleaned: Record<string, unknown> = {};
        if (kit.colors && typeof kit.colors === "object") {
          const c: Record<string, string> = {};
          for (const k of ["primary", "secondary", "accent"] as const) {
            if (typeof kit.colors[k] === "string" && VALID_HEX.test(kit.colors[k])) {
              c[k] = kit.colors[k];
            }
          }
          if (Object.keys(c).length > 0) cleaned.colors = c;
        }
        if (kit.fonts && typeof kit.fonts === "object") {
          const f: Record<string, string> = {};
          for (const k of ["heading", "body"] as const) {
            if (typeof kit.fonts[k] === "string" && kit.fonts[k].trim()) {
              f[k] = kit.fonts[k].trim();
            }
          }
          if (Object.keys(f).length > 0) cleaned.fonts = f;
        }
        if (typeof kit.logoUrl === "string" && kit.logoUrl.trim()) {
          cleaned.logoUrl = kit.logoUrl.trim();
        }

        session.brandAssets.brandKit = cleaned as import("../session/types.js").BrandKit;
        session.updatedAt = Date.now();

        const assetDir = join(session.themePath, ".vibespot");
        ensureDir(assetDir);
        writeFile(join(assetDir, "brand-kit.json"), JSON.stringify(cleaned, null, 2));

        saveSession();
        jsonResponse(res, 200, { ok: true, brandKit: cleaned });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  if (method === "DELETE") {
    if (session.brandAssets) {
      delete session.brandAssets.brandKit;
    }
    session.updatedAt = Date.now();

    const filePath = join(session.themePath, ".vibespot", "brand-kit.json");
    if (existsSync(filePath)) rmSync(filePath);

    saveSession();
    jsonResponse(res, 200, { ok: true });
    return;
  }

  jsonResponse(res, 405, { error: "Method not allowed" });
}

// ---------------------------------------------------------------------------
// Brand asset extraction from theme
// ---------------------------------------------------------------------------

/** Save a single brand asset to session + disk. */
function saveBrandAsset(
  session: ReturnType<typeof getSession>,
  type: "styleguide" | "brandvoice" | "themeContext",
  content: string,
): void {
  if (!session) return;
  if (!session.brandAssets) session.brandAssets = {};
  session.brandAssets[type] = content;
  session.updatedAt = Date.now();

  const filename = type === "themeContext" ? "theme-context.md" : `${type}.md`;
  const assetDir = join(session.themePath, ".vibespot");
  ensureDir(assetDir);
  writeFile(join(assetDir, filename), content);
}

/** Extract a single brand asset by type. */
async function extractSingleAsset(
  session: NonNullable<ReturnType<typeof getSession>>,
  type: "styleguide" | "brandvoice" | "themeContext",
  sourcePath?: string,
): Promise<string | null> {
  if (type === "styleguide") {
    const { extractDesignContext } = await import("../../ai/design-extractor.js");
    return extractDesignContext(sourcePath || session.themePath);
  }

  // brandvoice and themeContext need AI + rendered preview HTML
  const { resolveAgenticEngine } = await import("../ai-handler.js");
  const { loadConfig } = await import("../../utils/config.js");
  const config = loadConfig();
  const { engine, apiKey, model } = resolveAgenticEngine(config);

  const { buildPreviewHtml } = await import("../preview.js");
  const previewHtml = buildPreviewHtml();
  if (!previewHtml || previewHtml.length < 50) return null;

  if (type === "brandvoice") {
    const { extractBrandvoice } = await import("../agent/stages/brandvoice-extractor.js");
    return extractBrandvoice(previewHtml, engine, apiKey, model);
  }

  // themeContext
  const { extractThemeContext } = await import("../agent/stages/context-extractor.js");
  return extractThemeContext(previewHtml, session.brandAssets?.themeContext, engine, apiKey, model);
}

export function handleDesignExtractRoute(req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  readBody(req, (body) => {
    (async () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const type = parsed.type || "styleguide";
        const sourcePath = parsed.sourcePath;

        if (type === "all") {
          // Extract all three in parallel
          const types = ["styleguide", "brandvoice", "themeContext"] as const;
          const results = await Promise.allSettled(
            types.map((t) => extractSingleAsset(session, t, sourcePath)),
          );

          const extracted: Record<string, string | null> = {};
          for (let i = 0; i < types.length; i++) {
            const r = results[i];
            const content = r.status === "fulfilled" ? r.value : null;
            if (content) {
              saveBrandAsset(session, types[i], content);
            }
            extracted[types[i]] = content;
          }

          let syncedKit: import("../session/types.js").BrandKit | null = null;
          if (extracted.styleguide) {
            syncedKit = syncBrandKitFromStyleguide(session, extracted.styleguide);
          }

          saveSession();
          jsonResponse(res, 200, { ok: true, type: "all", extracted, brandKit: syncedKit });
          return;
        }

        if (type !== "styleguide" && type !== "brandvoice" && type !== "themeContext") {
          jsonResponse(res, 400, { error: `Invalid type: ${type}` });
          return;
        }

        const content = await extractSingleAsset(session, type, sourcePath);
        if (!content) {
          jsonResponse(res, 200, { ok: false, type, error: "No content to extract from" });
          return;
        }

        saveBrandAsset(session, type, content);
        let syncedKit: import("../session/types.js").BrandKit | null = null;
        if (type === "styleguide") {
          syncedKit = syncBrandKitFromStyleguide(session, content);
        }
        saveSession();
        jsonResponse(res, 200, { ok: true, type, content, brandKit: syncedKit });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Reference theme import — download from HubSpot + extract design
// ---------------------------------------------------------------------------

export function handleReferenceImportRoute(req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 404, { error: "No active session" });
    return;
  }

  readBody(req, (body) => {
    (async () => {
      try {
        const { source, themeName, localPath } = JSON.parse(body);

        let sourcePath: string;

        if (source === "hubspot") {
          // Download theme from HubSpot to temp location
          if (!themeName) {
            jsonResponse(res, 400, { error: "themeName is required for HubSpot import" });
            return;
          }
          const pak = getHubSpotPak();
          if (!pak) {
            jsonResponse(res, 400, { error: "No HubSpot account connected" });
            return;
          }

          // Strip leading/trailing slashes (HubSpot DM "Copy path" gives "/@marketplace/Theme")
          const cleanName = themeName.replace(/^\/+|\/+$/g, "");
          if (!cleanName) {
            jsonResponse(res, 400, { error: "Invalid theme name" });
            return;
          }

          // Sanitize for local directory name (replace @ and / with safe chars)
          const safeDirName = cleanName.replace(/[@/]/g, "_").replace(/_+/g, "_");
          const { homedir } = await import("node:os");
          const refDir = join(homedir(), "vibespot-themes", ".references", safeDirName);
          ensureDir(refDir);

          const { fetchTheme } = await import("../../hubspot/fetcher.js");
          await fetchTheme(pak, cleanName, refDir);
          sourcePath = refDir;
        } else if (source === "local") {
          if (!localPath) {
            jsonResponse(res, 400, { error: "localPath is required for local import" });
            return;
          }
          if (!existsSync(localPath)) {
            jsonResponse(res, 400, { error: `Path not found: ${localPath}` });
            return;
          }
          sourcePath = localPath;
        } else {
          jsonResponse(res, 400, { error: "source must be 'hubspot' or 'local'" });
          return;
        }

        // Extract design context and save to current theme
        const { extractDesignContext } = await import("../../ai/design-extractor.js");
        const styleguide = await extractDesignContext(sourcePath);

        if (!session.brandAssets) session.brandAssets = {};
        session.brandAssets.styleguide = styleguide;
        session.updatedAt = Date.now();

        const assetDir = join(session.themePath, ".vibespot");
        ensureDir(assetDir);
        writeFile(join(assetDir, "styleguide.md"), styleguide);

        saveSession();
        jsonResponse(res, 200, { ok: true, styleguide, source: sourcePath });
      } catch (err) {
        jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}
