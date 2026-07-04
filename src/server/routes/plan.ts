/**
 * HTTP routes for plan mode (the deliberation phase before generation).
 *
 * - POST /api/plan/edit       — overwrite the plan markdown (inline editor)
 * - POST /api/plan/discard    — clear the plan and exit plan mode
 * - GET  /api/plan/templates  — list available plan-mode templates
 * - POST /api/plan/template   — apply a chosen template as the seed plan
 *
 * Approval-triggered generation happens via the existing WebSocket flow,
 * not as a separate endpoint — see server.ts where the chat handler
 * branches on `planMode` and the approve action is signalled by a
 * `plan_approve` WebSocket message.
 */

import { publicErrorMessage } from "../errors.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { jsonResponse, readJsonBody } from "../route-helpers.js";
import { getSession, saveSession } from "../session.js";
import { getActiveTemplate } from "../session/templates.js";
import { saveConfig } from "../../utils/config.js";
import { log } from "../log.js";
import { listPlanTemplateMetadata, getPlanTemplate } from "../plan-templates.js";

const PLAN_FILENAME = "plan.md";

function planFilePath(themePath: string): string {
  return join(themePath, ".vibespot", PLAN_FILENAME);
}

/**
 * Persist plan markdown to session and disk.
 * Returns the saved markdown for confirmation.
 */
export function savePlan(markdown: string): string | null {
  const session = getSession();
  if (!session) return null;

  if (!session.brandAssets) session.brandAssets = {};
  session.brandAssets.plan = markdown;

  const tpl = getActiveTemplate();
  if (tpl) tpl.plan = markdown;

  try {
    const dir = join(session.themePath, ".vibespot");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(planFilePath(session.themePath), markdown, "utf-8");
  } catch (err) {
    log.warn("plan", `Failed to write plan.md: ${publicErrorMessage(err)}`);
  }

  saveSession();
  return markdown;
}

/**
 * Clear the plan from session and disk.
 */
export function clearPlan(): void {
  const session = getSession();
  if (!session) return;

  if (session.brandAssets) {
    delete session.brandAssets.plan;
  }

  const tpl = getActiveTemplate();
  if (tpl) delete tpl.plan;

  try {
    const path = planFilePath(session.themePath);
    if (existsSync(path)) rmSync(path);
  } catch (err) {
    log.warn("plan", `Failed to remove plan.md: ${publicErrorMessage(err)}`);
  }

  saveSession();
}

// ---------------------------------------------------------------------------
// POST /api/plan/edit  — inline editor save
// ---------------------------------------------------------------------------

export function handlePlanEditRoute(req: IncomingMessage, res: ServerResponse): void {
  readJsonBody<{ markdown?: string }>(req, res, (body) => {
    const session = getSession();
    if (!session) {
      jsonResponse(res, 400, { error: "No active session" });
      return;
    }

    const markdown = typeof body.markdown === "string" ? body.markdown : "";
    if (!markdown.trim()) {
      jsonResponse(res, 400, { error: "Plan content cannot be empty" });
      return;
    }

    savePlan(markdown);
    jsonResponse(res, 200, { ok: true, plan: markdown });
  });
}

// ---------------------------------------------------------------------------
// POST /api/plan/discard  — clear plan and exit plan mode
// ---------------------------------------------------------------------------

export function handlePlanDiscardRoute(req: IncomingMessage, res: ServerResponse): void {
  readJsonBody<Record<string, never>>(req, res, () => {
    clearPlan();
    saveConfig({ planMode: false });
    jsonResponse(res, 200, { ok: true });
  });
}

// ---------------------------------------------------------------------------
// GET /api/plan/templates  — list available plan-mode templates
// ---------------------------------------------------------------------------

export function handlePlanTemplatesRoute(_req: IncomingMessage, res: ServerResponse): void {
  jsonResponse(res, 200, { templates: listPlanTemplateMetadata() });
}

// ---------------------------------------------------------------------------
// POST /api/plan/template  — apply a template as the seed plan
//
// Body: { templateId: string }
// Behavior: writes the template body to .vibespot/plan.md and the session,
// flips plan mode on (so subsequent chat messages are routed to plan mode),
// and returns the seeded plan markdown.
// ---------------------------------------------------------------------------

export function handlePlanTemplateRoute(req: IncomingMessage, res: ServerResponse): void {
  readJsonBody<{ templateId?: string }>(req, res, (body) => {
    const session = getSession();
    if (!session) {
      jsonResponse(res, 400, { error: "No active session" });
      return;
    }

    const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
    if (!templateId) {
      jsonResponse(res, 400, { error: "templateId is required" });
      return;
    }

    const template = getPlanTemplate(templateId);
    if (!template) {
      jsonResponse(res, 404, { error: `Unknown plan template: ${templateId}` });
      return;
    }

    savePlan(template.body);
    saveConfig({ planMode: true });
    jsonResponse(res, 200, {
      ok: true,
      templateId: template.id,
      label: template.label,
      plan: template.body,
    });
  });
}
