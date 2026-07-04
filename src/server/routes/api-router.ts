/**
 * API route table + dispatcher (VIB-1932).
 *
 * Replaces the ~78-case switch that used to live in server.ts. Each entry maps
 * an exact `/api/*` path to a handler; `methods` lists the accepted verbs and
 * anything else gets a 405. Entries without `methods` delegate method dispatch
 * to the handler itself (multi-verb resource routes like /api/themes).
 *
 * Auth is NOT handled here — the single auth-gate seam stays in
 * server.ts:handleRequest (VIB-1889), which only calls this dispatcher for
 * requests that already passed the gate. This module owns the API-specific
 * CORS reflection and the cross-origin mutation guard.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { jsonResponse } from "../route-helpers.js";
import { isAllowedOrigin } from "../security.js";

// Route modules
import {
  handleSetupInfoRoute,
  handleSetupCreateRoute,
  handleSetupFetchRoute,
  handleSetupOpenRoute,
  handleSetupResumeRoute,
  handleSetupApiKeyRoute,
  handleSetupRemoteThemesRoute,
  handleStartersListRoute,
} from "./setup.js";
import {
  handleSettingsStatusRoute,
  handleSettingsModelsRoute,
  handleSettingsToolsRoute,
  handleSettingsEngineRoute,
  handleSettingsApiKeyRoute,
  handleSettingsInstallRoute,
  handleSettingsHsAuthRoute,
  handleSettingsGhAuthRoute,
  handleSettingsHsSwitchRoute,
  handleSettingsGhLogoutRoute,
  handleSettingsCLIAuthRoute,
  handleSettingsHsModeRoute,
  handleSettingsCliToggleRoute,
  handleSettingsGenericRoute,
  handleSettingsJobRoute,
} from "./settings.js";
import {
  handleWhatsNewRoute,
  handleWhatsNewDismissRoute,
  handleChangelogRoute,
} from "./whats-new.js";
import {
  handleClaudeOAuthSaveRoute,
  handleClaudeOAuthStatusRoute,
  handleClaudeOAuthLogoutRoute,
} from "./claude-oauth.js";
import {
  handleThemesRoute,
  handleThemeSwitchRoute,
  handleDeleteLocalThemeRoute,
  handleRenameThemeRoute,
  handleDuplicateThemeRoute,
} from "./themes.js";
import {
  handleDashboardRoute,
  handleDownloadZipRoute,
  handleTemplatesRoute,
  handleTemplateActivateRoute,
  handleTemplateRenameRoute,
  handleTemplateCloneRoute,
  handleTemplateReorderRoute,
  handleModuleLibraryRoute,
  handleAddModuleToTemplateRoute,
  handleBrandAssetsRoute,
  handleBrandKitRoute,
  handleDesignExtractRoute,
  handleReferenceImportRoute,
  handleFontsRoute,
} from "./templates.js";
import {
  handleSessionRoute,
  handleModulesRoute,
  handleReorderRoute,
  handleUploadRoute,
  handleFieldRoute,
  handleImportRoute,
  handleHistoryRoute,
  handleRollbackRoute,
  handleCodeUpdateRoute,
} from "./modules.js";
import { handleFileUploadRoute } from "./upload-files.js";
import { handleFigmaTestTokenRoute, handleFigmaExtractRoute, handleFigmaGenerateRoute } from "./figma.js";
import {
  handleMarketplaceCheckRoute,
  handleMarketplaceFixRoute,
  handleMarketplaceListingRoute,
} from "./marketplace.js";
import {
  handleInverseAnalyzeRoute,
  handleInverseApplyTokensRoute,
} from "./inverse.js";
import { handlePlanEditRoute, handlePlanDiscardRoute, handlePlanTemplatesRoute, handlePlanTemplateRoute } from "./plan.js";
import { handlePreviewOriginRoute } from "./preview-origin.js";

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

interface ApiRouteContext {
  method: string;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
}

interface ApiRouteEntry {
  /** Accepted methods; any other verb gets a 405. Omit when the handler does
   * its own method dispatch (multi-verb resource routes). */
  methods?: readonly string[];
  handler: (ctx: ApiRouteContext) => void;
}

const API_ROUTES: Record<string, ApiRouteEntry> = {
  "/api/session": { handler: ({ method, res }) => handleSessionRoute(method, res) },
  "/api/preview-origin": { handler: ({ req, res }) => handlePreviewOriginRoute(req, res) },
  "/api/modules": { handler: ({ method, req, res }) => handleModulesRoute(method, req, res) },
  "/api/modules/reorder": { handler: ({ req, res }) => handleReorderRoute(req, res) },
  "/api/modules/code": { handler: ({ req, res }) => handleCodeUpdateRoute(req, res) },
  "/api/upload": { handler: ({ res }) => handleUploadRoute(res) },
  "/api/upload-files": { methods: ["POST"], handler: ({ req, res }) => handleFileUploadRoute(req, res) },
  "/api/field": { handler: ({ req, res }) => handleFieldRoute(req, res) },
  "/api/import": { handler: ({ req, res }) => handleImportRoute(req, res) },

  // Setup routes
  "/api/setup": { handler: ({ res }) => handleSetupInfoRoute(res) },
  "/api/setup/create": { handler: ({ req, res }) => handleSetupCreateRoute(req, res) },
  "/api/setup/fetch": { handler: ({ req, res }) => handleSetupFetchRoute(req, res) },
  "/api/setup/open": { handler: ({ req, res }) => handleSetupOpenRoute(req, res) },
  "/api/setup/resume": { handler: ({ req, res }) => handleSetupResumeRoute(req, res) },
  "/api/setup/apikey": { handler: ({ req, res }) => handleSetupApiKeyRoute(req, res) },
  "/api/setup/remote-themes": { methods: ["GET"], handler: ({ res }) => handleSetupRemoteThemesRoute(res) },
  "/api/starters": { methods: ["GET"], handler: ({ res }) => handleStartersListRoute(res) },

  // "What's new" release dialog (VIB-1885)
  "/api/whats-new": { methods: ["GET"], handler: ({ res }) => handleWhatsNewRoute(res) },
  "/api/whats-new/dismiss": { methods: ["POST"], handler: ({ req, res }) => handleWhatsNewDismissRoute(req, res) },
  "/api/changelog": { methods: ["GET"], handler: ({ res }) => handleChangelogRoute(res) },

  // Settings routes
  "/api/settings/status": { methods: ["GET"], handler: ({ res }) => handleSettingsStatusRoute(res) },
  "/api/settings/models": { methods: ["GET"], handler: ({ req, res }) => handleSettingsModelsRoute(req, res) },
  "/api/settings/tools": { methods: ["GET"], handler: ({ req, res }) => handleSettingsToolsRoute(req, res) },
  "/api/settings/engine": { methods: ["POST"], handler: ({ req, res }) => handleSettingsEngineRoute(req, res) },
  "/api/settings/apikey": { methods: ["POST"], handler: ({ req, res }) => handleSettingsApiKeyRoute(req, res) },
  "/api/settings/install": { methods: ["POST"], handler: ({ req, res }) => handleSettingsInstallRoute(req, res) },
  "/api/settings/hs-auth": { methods: ["POST"], handler: ({ req, res }) => handleSettingsHsAuthRoute(req, res) },
  "/api/settings/gh-auth": { methods: ["POST"], handler: ({ req, res }) => handleSettingsGhAuthRoute(req, res) },
  "/api/settings/hs-switch": { methods: ["POST"], handler: ({ req, res }) => handleSettingsHsSwitchRoute(req, res) },
  "/api/settings/gh-logout": { methods: ["POST"], handler: ({ res }) => handleSettingsGhLogoutRoute(res) },
  "/api/settings/cli-auth": { methods: ["POST"], handler: ({ req, res }) => handleSettingsCLIAuthRoute(req, res) },
  "/api/settings/hs-mode": { methods: ["POST"], handler: ({ req, res }) => handleSettingsHsModeRoute(req, res) },
  "/api/settings/cli-toggle": { methods: ["POST"], handler: ({ req, res }) => handleSettingsCliToggleRoute(req, res) },
  "/api/settings/claude-oauth/save": { methods: ["POST"], handler: ({ req, res }) => handleClaudeOAuthSaveRoute(req, res) },
  "/api/settings/claude-oauth/status": { methods: ["GET"], handler: ({ req, res }) => handleClaudeOAuthStatusRoute(req, res) },
  "/api/settings/claude-oauth/logout": { methods: ["POST"], handler: ({ req, res }) => handleClaudeOAuthLogoutRoute(req, res) },
  "/api/settings": { methods: ["POST"], handler: ({ req, res }) => handleSettingsGenericRoute(req, res) },

  // Theme routes
  "/api/themes": { handler: ({ method, req, res }) => handleThemesRoute(method, req, res) },
  "/api/themes/switch": { methods: ["POST"], handler: ({ req, res }) => handleThemeSwitchRoute(req, res) },
  "/api/themes/delete-local": { methods: ["POST"], handler: ({ req, res }) => handleDeleteLocalThemeRoute(req, res) },
  "/api/themes/rename": { methods: ["POST"], handler: ({ req, res }) => handleRenameThemeRoute(req, res) },
  "/api/themes/duplicate": { methods: ["POST"], handler: ({ req, res }) => handleDuplicateThemeRoute(req, res) },

  // Version history
  "/api/history": { methods: ["GET"], handler: ({ req, res }) => handleHistoryRoute(req, res) },
  "/api/rollback": { methods: ["POST"], handler: ({ req, res }) => handleRollbackRoute(req, res) },

  // Dashboard & template routes
  "/api/dashboard": { methods: ["GET"], handler: ({ res }) => handleDashboardRoute(res) },
  "/api/templates": { handler: ({ method, req, res }) => handleTemplatesRoute(method, req, res) },
  "/api/templates/activate": { methods: ["POST"], handler: ({ req, res }) => handleTemplateActivateRoute(req, res) },
  "/api/templates/rename": { methods: ["POST"], handler: ({ req, res }) => handleTemplateRenameRoute(req, res) },
  "/api/templates/clone": { methods: ["POST"], handler: ({ req, res }) => handleTemplateCloneRoute(req, res) },
  "/api/templates/reorder": { methods: ["POST"], handler: ({ req, res }) => handleTemplateReorderRoute(req, res) },
  "/api/module-library": { methods: ["GET"], handler: ({ res }) => handleModuleLibraryRoute(res) },

  // Brand assets
  "/api/brand-assets": { handler: ({ method, req, res }) => handleBrandAssetsRoute(method, req, res) },
  "/api/brand-kit": { handler: ({ method, req, res }) => handleBrandKitRoute(method, req, res) },
  "/api/fonts": { methods: ["GET"], handler: ({ req, res }) => handleFontsRoute(req, res) },
  "/api/brand-assets/extract": { methods: ["POST"], handler: ({ req, res }) => handleDesignExtractRoute(req, res) },
  "/api/brand-assets/import-reference": { methods: ["POST"], handler: ({ req, res }) => handleReferenceImportRoute(req, res) },

  "/api/download-zip": { methods: ["GET"], handler: ({ res }) => handleDownloadZipRoute(res) },

  // Figma routes
  "/api/figma/test-token": { methods: ["POST"], handler: ({ req, res }) => handleFigmaTestTokenRoute(req, res) },
  "/api/figma/extract": { methods: ["POST"], handler: ({ req, res }) => handleFigmaExtractRoute(req, res) },
  "/api/figma/generate": { methods: ["POST"], handler: ({ req, res }) => handleFigmaGenerateRoute(req, res) },

  // Plan-mode routes
  "/api/plan/edit": { methods: ["POST"], handler: ({ req, res }) => handlePlanEditRoute(req, res) },
  "/api/plan/discard": { methods: ["POST"], handler: ({ req, res }) => handlePlanDiscardRoute(req, res) },
  "/api/plan/templates": { methods: ["GET"], handler: ({ req, res }) => handlePlanTemplatesRoute(req, res) },
  "/api/plan/template": { methods: ["POST"], handler: ({ req, res }) => handlePlanTemplateRoute(req, res) },

  // Marketplace routes
  "/api/marketplace/check": { methods: ["GET"], handler: ({ req, res }) => handleMarketplaceCheckRoute(req, res) },
  "/api/marketplace/fix": { methods: ["POST"], handler: ({ req, res }) => handleMarketplaceFixRoute(req, res) },
  "/api/marketplace/listing": { handler: ({ method, req, res }) => handleMarketplaceListingRoute(method, req, res) },

  // Inverse (imported-theme analysis) routes
  "/api/inverse/analyze": { methods: ["GET"], handler: ({ req, res }) => handleInverseAnalyzeRoute(req, res) },
  "/api/inverse/apply-tokens": { methods: ["POST"], handler: ({ req, res }) => handleInverseApplyTokensRoute(req, res) },
};

// Parameterized paths — checked after the exact-match table. A method
// mismatch here falls through to the 404 (preserving the pre-router switch's
// default-case behavior).
const PATTERN_ROUTES: {
  matches: (path: string) => boolean;
  method: string;
  handler: (ctx: ApiRouteContext) => void;
}[] = [
  {
    // Job polling: /api/settings/job/:id
    matches: (path) => path.startsWith("/api/settings/job/"),
    method: "GET",
    handler: ({ path, res }) => handleSettingsJobRoute(path, res),
  },
  {
    // Template add-module: /api/templates/:id/add-module
    matches: (path) => /^\/api\/templates\/[^/]+\/add-module$/.test(path),
    method: "POST",
    handler: ({ path, req, res }) => handleAddModuleToTemplateRoute(path, req, res),
  },
];

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function handleApiRoute(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse
): void {
  // CORS — reflect only same-origin or local/private origins (VIB-1889).
  const origin = req.headers.origin;
  const originAllowed = isAllowedOrigin(origin, req.headers.host);
  if (origin && originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Vibespot-Token");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Cross-origin mutation guard (VIB-1889): CORS stops reads but not simple
  // no-preflight writes (e.g. text/plain POSTs from a hostile page). Reject
  // state-changing requests whose browser Origin fails the allow-list.
  if (origin && !originAllowed && method !== "GET" && method !== "HEAD") {
    jsonResponse(res, 403, { error: "Origin not allowed" });
    return;
  }

  const ctx: ApiRouteContext = { method, path, req, res };

  const entry = API_ROUTES[path];
  if (entry) {
    if (entry.methods && !entry.methods.includes(method)) {
      jsonResponse(res, 405, { error: "Method not allowed" });
      return;
    }
    entry.handler(ctx);
    return;
  }

  for (const pattern of PATTERN_ROUTES) {
    if (pattern.method === method && pattern.matches(path)) {
      pattern.handler(ctx);
      return;
    }
  }

  jsonResponse(res, 404, { error: "Not found" });
}
