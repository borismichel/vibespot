/**
 * WebSocket protocol handler (VIB-1932, extracted from server.ts).
 *
 * Owns the per-connection message dispatch (`chat`, `figma_import`,
 * `extract_brand_assets`, `start_upload`, `upload_fix_with_ai`,
 * `checkpoint_resolve` + the `plan_approve`/`plan_discard` aliases) and the
 * live-client tracking that lets a reconnecting client catch up on an
 * in-flight pipeline. Auth/origin checks happen before a socket reaches
 * `handleWsConnection` — the upgrade gate lives in server.ts (VIB-1889).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  getSession,
  addMessage,
  getOrderedModules,
  updateModules,
  reorderModules,
  writeModulesToDisk,
  saveSession,
  getActiveTemplate,
  createSession,
} from "./session.js";
import { commitThemeState, commitTemplateState, isGitAvailable } from "./project-git.js";
import { handleGenerateStream, handleAgenticGenerate, handleAgenticResume, handleFigmaImport, applyPipelineResult, shouldUseAgenticMode, setParseWarningCallback, resolveAgenticEngine, handlePlanModeStream, isPlanModeActive, isGenerating, cancelActiveGeneration } from "./ai-handler.js";
import { discardCheckpoint } from "./agent/pipeline.js";
import type { PipelineResult } from "./agent/types.js";
import type { CheckpointResolution, CheckpointAction } from "./agent/types.js";
import { savePlan, clearPlan } from "./routes/plan.js";
import { parsePlanResponse } from "./plan-parser.js";
import { loadConfig, saveConfig, getHubSpotPak, getActiveHubSpotAccount } from "../utils/config.js";
import { detectHubSpotAuth, detectDataCenter } from "../utils/detect.js";
import { applyAutoFixes, parseUploadErrors, parseApiErrors } from "./auto-fix.js";
import { startStreamingJob, getJob, addJobListener, removeJobListener } from "./process-manager.js";
import { isSafeThemeName } from "../utils/validate.js";
import { uploadTheme } from "../hubspot/uploader.js";
import { publicErrorMessage } from "./errors.js";
import { runWithTrace, runWithSpan } from "./langfuse.js";
import { getServerContentMode } from "./server-context.js";

// ---------------------------------------------------------------------------
// Live WebSocket tracking — allows reconnecting clients to catch up on
// an in-flight pipeline that started on a previous connection.
// ---------------------------------------------------------------------------

let activeClientWs: WebSocket | null = null;
let pipelineEventLog: object[] = [];

function sendToClient(data: object): void {
  if (activeClientWs && activeClientWs.readyState === WebSocket.OPEN) {
    activeClientWs.send(JSON.stringify(data));
  }
}

function logAndSend(data: object): void {
  pipelineEventLog.push(data);
  sendToClient(data);
}

function clearPipelineEventLog(): void {
  pipelineEventLog = [];
}

// ---------------------------------------------------------------------------
// Shared pipeline event handler — builds the onEvent callback used by all
// three generation entry points (chat, figma import, plan approval).
// ---------------------------------------------------------------------------

function buildPipelineOnEvent(
  pipelineSteps: { step: string; label: string; decisions?: string[] }[],
  pipelineModules: { name: string; status: "complete" | "failed" }[],
): (event: import("./agent/types.js").PipelineEvent) => void {
  return (event) => {
    if (event.type === "module_progress" && event.moduleFiles) {
      const { moduleFiles, ...wsEvent } = event;
      logAndSend(wsEvent);
    } else {
      logAndSend(event);
    }

    if (event.type === "agent_step") {
      pipelineSteps.push({ step: event.step, label: event.label });
    } else if (event.type === "agent_decision") {
      const last = pipelineSteps[pipelineSteps.length - 1];
      if (last) {
        if (!last.decisions) last.decisions = [];
        last.decisions.push(event.decision);
      }
    } else if (event.type === "design_system_ready") {
      updateModules({ sharedCss: event.sharedCss, sharedJs: event.sharedJs });
    } else if (event.type === "blueprint_ready") {
      updateModules({ sharedCss: event.sharedCss, sharedJs: event.sharedJs });
      reorderModules(event.moduleOrder);
      logAndSend({
        type: "modules_updated",
        modules: getOrderedModules().map((m) => m.moduleName),
      });
    } else if (event.type === "module_progress" && event.status === "complete" && event.moduleFiles) {
      updateModules({ modules: [{
        moduleName: event.module,
        fieldsJson: event.moduleFiles.fieldsJson,
        metaJson: event.moduleFiles.metaJson,
        moduleHtml: event.moduleFiles.moduleHtml,
        moduleCss: event.moduleFiles.moduleCss,
        moduleJs: event.moduleFiles.moduleJs,
      }] });
      logAndSend({
        type: "modules_updated",
        modules: getOrderedModules().map((m) => m.moduleName),
      });
      pipelineModules.push({ name: event.module, status: "complete" });
    } else if (event.type === "module_progress" && event.status === "failed") {
      pipelineModules.push({ name: event.module, status: "failed" });
    }
  };
}

// ---------------------------------------------------------------------------
// Generation cost (VIB-1770) — push the per-page token/USD estimate plus the
// updated per-project running total to the UI after a generation completes.
// Call AFTER applyPipelineResult so the session's running total is current.
// No-op when there's no priced usage (e.g. CLI engines report none).
// ---------------------------------------------------------------------------

function sendGenerationCost(result: import("./agent/types.js").PipelineResult): void {
  const cost = result.cost;
  if (!cost || cost.calls === 0) return;
  const sess = getSession();
  sendToClient({
    type: "generation_cost",
    cost,
    projectTotal: sess?.costTotal,
  });
}

/**
 * Apply a completed agentic pipeline result to the session, persist + commit it
 * for version history, and notify the client (cost, preview, module list).
 * Shared by the chat, checkpoint-resume, and plan-approve paths (VIB-1880) so
 * the build+commit tail lives in exactly one place.
 */
function finalizeAgenticGeneration(
  result: PipelineResult,
  opts: {
    steps: { step: string; label: string; decisions?: string[] }[];
    modules: { name: string; status: "complete" | "failed" }[];
    commitLabel: string;
  },
): void {
  applyPipelineResult(result, {
    steps: opts.steps,
    modules: opts.modules,
    stats: result.stats,
    cost: result.cost,
  });
  sendGenerationCost(result);

  const currentSession = getSession();
  if (currentSession) {
    writeModulesToDisk();
    const activeTpl = getActiveTemplate();
    let commitHash: string | null = null;
    if (activeTpl) {
      const filePaths = activeTpl.moduleOrder.map((n: string) => `modules/${n}.module`);
      if (activeTpl.templateFile) filePaths.push(activeTpl.templateFile);
      if (activeTpl.sharedCss) filePaths.push(`css/${currentSession.themeName}-theme.css`);
      if (activeTpl.sharedJs) filePaths.push(`js/${currentSession.themeName}-animations.js`);
      commitHash = commitTemplateState(currentSession.themePath, activeTpl.id, opts.commitLabel, filePaths);
    } else {
      commitHash = commitThemeState(currentSession.themePath, opts.commitLabel);
    }
    if (commitHash) {
      sendToClient({ type: "version_created", hash: commitHash });
    }
  }

  sendToClient({ type: "generation_complete" });
  {
    const sess = getSession();
    sendToClient({
      type: "modules_updated",
      modules: getOrderedModules().map((m) => m.moduleName),
      templateId: sess?.activeTemplateId || null,
      templates: (sess?.templates || []).map((t) => ({
        id: t.id, label: t.label, pageType: t.pageType, moduleCount: t.modules.length,
      })),
    });
  }
  clearPipelineEventLog();
}

// ---------------------------------------------------------------------------
// Plan mode as a checkpoint variant (VIB-1880)
//
// Plan mode is the heaviest checkpoint: the whole deliberation phase is one
// "plan" checkpoint. These helpers are shared by the chat plan-mode branch and
// the `checkpoint_resolve {kind:"plan"}` path so plan deliberation, approval,
// and discard each live in one place — collapsing the old plan_approve branch.
// ---------------------------------------------------------------------------

/** Stream a plan-mode deliberation turn, persist the plan, and park a "plan"
 * checkpoint so the user can approve/steer/cancel through checkpoint_resolve. */
async function runPlanDeliberation(userMessage: string, fileIds?: string[]): Promise<void> {
  addMessage("user", userMessage);
  saveSession();

  try {
    sendToClient({ type: "stream_status", content: "Planning..." });
    let fullResponse = "";
    const fullText = await handlePlanModeStream(
      userMessage,
      (chunk) => {
        fullResponse += chunk;
        sendToClient({ type: "stream", content: chunk });
      },
      fileIds,
    );

    const parsed = parsePlanResponse(fullText || fullResponse);

    if (parsed.plan) {
      savePlan(parsed.plan);
      sendToClient({ type: "plan_updated", plan: parsed.plan });
      const sess = getSession();
      if (sess) {
        sess.pendingCheckpoint = {
          kind: "plan",
          resumeToken: "plan",
          preview: { kind: "plan", headline: "Plan ready for review", data: { plan: parsed.plan } },
          createdAt: new Date().toISOString(),
        };
        saveSession();
      }
    }
    if (parsed.choices) {
      sendToClient({
        type: "plan_choices",
        question: parsed.choices.question,
        options: parsed.choices.options,
      });
    }

    addMessage("assistant", parsed.cleanedContent);
    saveSession();

    sendToClient({ type: "plan_complete", cleanedContent: parsed.cleanedContent });
    sendToClient({ type: "generation_complete" });
  } catch (err) {
    sendToClient({ type: "error", message: publicErrorMessage(err) });
  }
}

/** Approve the parked plan: exit plan mode and run the build (the approved plan
 * is auto-prepended as the brief by handleAgenticGenerate). One-shot — the plan
 * has already gated, so no design checkpoint. */
async function runPlanApproval(): Promise<void> {
  const session = getSession();
  if (!session) {
    sendToClient({ type: "error", message: "No active session" });
    return;
  }
  const planMd = session.brandAssets?.plan;
  if (!planMd || !planMd.trim()) {
    sendToClient({ type: "error", message: "No plan to approve. Send a chat message first." });
    return;
  }

  saveConfig({ planMode: false });
  if (session.pendingCheckpoint?.kind === "plan") session.pendingCheckpoint = undefined;

  const approvalMessage = "Implement the approved plan.";
  addMessage("user", approvalMessage);
  saveSession();

  try {
    clearPipelineEventLog();
    const steps: { step: string; label: string; decisions?: string[] }[] = [];
    const modules: { name: string; status: "complete" | "failed" }[] = [];

    const result = await handleAgenticGenerate(
      approvalMessage,
      buildPipelineOnEvent(steps, modules),
    );

    if (result.canceled) {
      clearPipelineEventLog();
      return;
    }

    finalizeAgenticGeneration(result, { steps, modules, commitLabel: "Approved plan: implementation" });
  } catch (err) {
    clearPipelineEventLog();
    sendToClient({ type: "error", message: publicErrorMessage(err) });
  }
}

/** Discard the plan and exit plan mode (the plan checkpoint's "cancel"). */
function runPlanDiscard(): void {
  const session = getSession();
  if (session?.pendingCheckpoint?.kind === "plan") session.pendingCheckpoint = undefined;
  clearPlan();
  saveConfig({ planMode: false });
  saveSession();
  sendToClient({ type: "plan_discarded" });
}

// ---------------------------------------------------------------------------
// WebSocket handler
// ---------------------------------------------------------------------------

export function handleWsConnection(ws: WebSocket): void {
  ws.on("message", async (data) => {
    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    switch (msg.type) {
      case "chat": {
        const userMessage = String(msg.message || "");
        if (!userMessage.trim()) return;

        const fileIds = Array.isArray(msg.fileIds) ? msg.fileIds as string[] : undefined;

        // Barge-in (VIB-1880): a message that arrives mid-build supersedes the
        // running generation. Cancel it (cancel-and-replan); the replacement
        // run serializes behind it on the per-session generation lock in
        // ai-handler (VIB-1895) — no timed wait that could give up and let two
        // pipelines mutate the same session.
        if (isGenerating() && cancelActiveGeneration()) {
          sendToClient({ type: "generation_superseded" });
        }

        // A fresh chat supersedes any parked checkpoint gate (VIB-1877). Also
        // drop its in-memory resume state — otherwise every superseded gate
        // leaks its entry in the resume store for the life of the process
        // (VIB-1895). No-op for "plan" gates (they never enter the store).
        {
          const sess = getSession();
          if (sess?.pendingCheckpoint) {
            discardCheckpoint(sess.pendingCheckpoint.resumeToken);
            sess.pendingCheckpoint = undefined;
            saveSession();
          }
        }

        // ---------------------------------------------------------------
        // Plan-mode branch — DELIBERATION PHASE, no module generation.
        //
        // While planMode is active, the chat handler routes to the plan-mode
        // stream and refuses to enter the agentic pipeline. When a plan is
        // produced it parks a "plan" checkpoint (VIB-1880) so approval/discard
        // run through the same `checkpoint_resolve` protocol as design — plan
        // mode is just the heaviest checkpoint variant.
        // ---------------------------------------------------------------
        if (isPlanModeActive()) {
          await runPlanDeliberation(userMessage, fileIds);
          break;
        }

        addMessage("user", userMessage);
        saveSession();

        // Check if agentic mode should be used
        const agenticCheck = shouldUseAgenticMode();

        // Notify frontend if agentic mode needs first-run prompt
        if (agenticCheck.needsPrompt) {
          ws.send(JSON.stringify({ type: "agentic_prompt" }));
          // Don't block — fall through to single-call mode for now.
          // User can choose agentic mode from the prompt, which saves to config.
        }

        try {
          if (agenticCheck.useAgentic) {
            // --- Agentic pipeline mode ---
            clearPipelineEventLog();
            const pipelineSteps: { step: string; label: string; decisions?: string[] }[] = [];
            const pipelineModules: { name: string; status: "complete" | "failed" }[] = [];

            // Checkpoints are ON by default (VIB-1877). The send-button's
            // "one-shot it" affordance sets msg.oneShot to skip all gates
            // (= today's behavior).
            const checkpointsEnabled = !msg.oneShot;

            const result = await handleAgenticGenerate(
              userMessage,
              buildPipelineOnEvent(pipelineSteps, pipelineModules),
              fileIds,
              checkpointsEnabled,
            );

            // Barge-in (VIB-1880): this run was itself superseded by an even
            // newer message. Stop quietly — the superseding run owns the UI and
            // will emit its own completion. Nothing was built or committed.
            if (result.canceled) {
              clearPipelineEventLog();
              break;
            }

            // Parked at a checkpoint gate: persist the resume token on the
            // session and stop here. No modules were built, nothing is written
            // or committed. The UI shows the checkpoint card (sent via the
            // checkpoint_requested event) and resolves it with checkpoint_resolve.
            if (result.pendingCheckpoint) {
              const sess = getSession();
              if (sess) {
                sess.pendingCheckpoint = result.pendingCheckpoint;
                saveSession();
              }
              sendGenerationCost(result);
              clearPipelineEventLog();
              break;
            }

            applyPipelineResult(result, {
              steps: pipelineSteps,
              modules: pipelineModules,
              stats: result.stats,
              cost: result.cost,
            });
            sendGenerationCost(result);

          } else {
            // --- Single-call mode (existing behavior) ---
            setParseWarningCallback((warning) => {
              sendToClient({ type: "parse_warning", message: warning });
            });

            await handleGenerateStream(
              userMessage,
              (chunk) => {
                sendToClient({ type: "stream", content: chunk });
              },
              (status) => {
                sendToClient({ type: "stream_status", content: status });
              },
              fileIds
            );
          }

          // Write modules to disk and commit for version history
          const currentSession = getSession();
          if (currentSession) {
            writeModulesToDisk();
            const activeTpl = getActiveTemplate();
            let commitHash: string | null = null;
            if (activeTpl) {
              const filePaths = activeTpl.moduleOrder.map((n: string) => `modules/${n}.module`);
              if (activeTpl.templateFile) filePaths.push(activeTpl.templateFile);
              if (activeTpl.sharedCss) filePaths.push(`css/${currentSession.themeName}-theme.css`);
              if (activeTpl.sharedJs) filePaths.push(`js/${currentSession.themeName}-animations.js`);
              commitHash = commitTemplateState(currentSession.themePath, activeTpl.id, userMessage, filePaths);
            } else {
              commitHash = commitThemeState(currentSession.themePath, userMessage);
            }
            if (commitHash) {
              sendToClient({ type: "version_created", hash: commitHash });
            }
          }

          // After generation, send updated preview
          sendToClient({ type: "generation_complete" });
          {
            const sess = getSession();
            sendToClient({
              type: "modules_updated",
              modules: getOrderedModules().map((m) => m.moduleName),
              templateId: sess?.activeTemplateId || null,
              templates: (sess?.templates || []).map((t) => ({
                id: t.id, label: t.label, pageType: t.pageType, moduleCount: t.modules.length,
              })),
            });
          }
          clearPipelineEventLog();

          // Suggest brand asset extraction if none exist yet
          {
            const sess = getSession();
            if (sess && agenticCheck.useAgentic && !sess.brandAssets?.styleguide && !sess.brandAssets?.brandvoice && !sess.brandAssets?.themeContext) {
              sendToClient({ type: "suggest_brand_extraction" });
            }
          }
        } catch (err) {
          clearPipelineEventLog();
          sendToClient({
            type: "error",
            message: publicErrorMessage(err),
          });
        }
        break;
      }

      case "figma_import": {
        const extractionId = String(msg.extractionId || "");
        const themeName = String(msg.themeName || "");
        if (!extractionId || !themeName) {
          ws.send(JSON.stringify({ type: "error", message: "Missing extractionId or themeName" }));
          break;
        }

        // Retrieve cached extraction
        const { getCachedExtraction } = await import("./routes/figma.js");
        const extraction = getCachedExtraction(extractionId);
        if (!extraction) {
          ws.send(JSON.stringify({ type: "error", message: "Extraction expired or not found. Please re-extract." }));
          break;
        }

        try {
          // Theme + session should already exist (created via /api/setup/create)
          // Fall back to creating them if not (e.g. direct WebSocket call)
          const session = getSession();
          if (!session || session.themeName !== themeName) {
            const { join } = await import("node:path");
            const { homedir } = await import("node:os");
            const { existsSync } = await import("node:fs");
            const { createThemeScaffold } = await import("../hubspot/theme-scaffold.js");
            const workspaceDir = join(homedir(), "vibespot-themes");
            const themePath = join(workspaceDir, themeName);

            if (!existsSync(workspaceDir)) {
              const { mkdirSync } = await import("node:fs");
              mkdirSync(workspaceDir, { recursive: true });
            }
            if (!existsSync(themePath)) {
              createThemeScaffold(themePath, themeName);
            }
            createSession(themePath, themeName);
            saveSession();
          }

          sendToClient({ type: "figma_import_started", fileName: extraction.fileName });

          clearPipelineEventLog();
          const pipelineSteps: { step: string; label: string; decisions?: string[] }[] = [];
          const pipelineModules: { name: string; status: "complete" | "failed" }[] = [];

          const result = await handleFigmaImport(
            extraction,
            themeName,
            buildPipelineOnEvent(pipelineSteps, pipelineModules),
          );

          applyPipelineResult(result, {
            steps: pipelineSteps,
            modules: pipelineModules,
            stats: result.stats,
            cost: result.cost,
          });
          sendGenerationCost(result);

          writeModulesToDisk();
          commitThemeState(getSession()!.themePath, `Figma import: ${extraction.fileName}`);

          sendToClient({ type: "generation_complete" });
          {
            const sess = getSession();
            sendToClient({
              type: "modules_updated",
              modules: getOrderedModules().map((m) => m.moduleName),
              templateId: sess?.activeTemplateId || null,
              templates: (sess?.templates || []).map((t) => ({
                id: t.id, label: t.label, pageType: t.pageType, moduleCount: t.modules.length,
              })),
            });
          }
          clearPipelineEventLog();
        } catch (err) {
          clearPipelineEventLog();
          sendToClient({
            type: "error",
            message: publicErrorMessage(err),
          });
        }
        break;
      }

      case "extract_brand_assets": {
        const session = getSession();
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "No active session" }));
          break;
        }

        // Fire-and-forget — run extraction in background, never block the UI
        (async () => {
          try {
            const config = loadConfig();
            const { engine, apiKey, model } = resolveAgenticEngine(config);

            // Extract theme context from rendered preview HTML
            const { buildPreviewHtml } = await import("./preview.js");
            const previewHtml = buildPreviewHtml();
            if (!previewHtml || previewHtml.length < 50) return;

            const { extractThemeContext } = await import("./agent/stages/context-extractor.js");
            const themeContext = await runWithTrace(
              {
                name: "brand_extract",
                sessionId: session.themeName,
                metadata: { type: "themeContext" },
                tags: ["vibespot", "brand-extract"],
              },
              () =>
                runWithSpan("extract-theme-context", () =>
                  extractThemeContext(
                    previewHtml,
                    session.brandAssets?.themeContext,
                    engine,
                    apiKey,
                    model,
                  ),
                ),
            );

            const { mkdirSync, writeFileSync } = await import("node:fs");

            if (themeContext) {
              if (!session.brandAssets) session.brandAssets = {};
              session.brandAssets.themeContext = themeContext;
              session.updatedAt = Date.now();

              const assetDir = join(session.themePath, ".vibespot");
              if (!existsSync(assetDir)) mkdirSync(assetDir, { recursive: true });
              writeFileSync(join(assetDir, "theme-context.md"), themeContext);

              saveSession();
              ws.send(JSON.stringify({ type: "brand_asset_extracted", assetType: "themeContext" }));
            }

            // Also extract styleguide if missing
            if (!session.brandAssets?.styleguide) {
              try {
                const { extractDesignContext } = await import("../ai/design-extractor.js");
                const styleguide = await runWithTrace(
                  {
                    name: "brand_extract",
                    sessionId: session.themeName,
                    metadata: { type: "styleguide" },
                    tags: ["vibespot", "brand-extract"],
                  },
                  () => runWithSpan("extract-styleguide", () => extractDesignContext(session.themePath)),
                );
                if (styleguide) {
                  if (!session.brandAssets) session.brandAssets = {};
                  session.brandAssets.styleguide = styleguide;
                  session.updatedAt = Date.now();

                  const assetDir = join(session.themePath, ".vibespot");
                  if (!existsSync(assetDir)) mkdirSync(assetDir, { recursive: true });
                  writeFileSync(join(assetDir, "styleguide.md"), styleguide);

                  saveSession();
                  ws.send(JSON.stringify({ type: "brand_asset_extracted", assetType: "styleguide" }));
                }
              } catch { /* non-critical */ }
            }

            ws.send(JSON.stringify({ type: "brand_extraction_complete" }));
          } catch (err) {
            ws.send(JSON.stringify({
              type: "brand_extraction_error",
              message: publicErrorMessage(err),
            }));
          }
        })();
        break;
      }

      case "start_upload": {
        const session = getSession();
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "No active session" }));
          break;
        }

        try {
          writeModulesToDisk();

          // Apply auto-fixes before uploading
          const fixes = applyAutoFixes(session.themePath);
          if (fixes.length > 0) {
            ws.send(JSON.stringify({ type: "upload_status", phase: "autofix", fixes }));
          }

          const config = loadConfig();
          const uploadMode = config.hubspotUploadMode || "api";

          if (uploadMode === "api") {
            // --- API mode: direct HTTP uploads ---
            const pak = getHubSpotPak();
            if (!pak) {
              ws.send(JSON.stringify({
                type: "upload_failed",
                output: "No HubSpot account configured. Open Settings → HubSpot to add one.",
                errors: [{ file: "", message: "No HubSpot account configured", fixable: false }],
              }));
              break;
            }

            ws.send(JSON.stringify({ type: "upload_started", jobId: "api-upload" }));

            const result = await uploadTheme(pak, session.themePath, session.themeName, {
              onFileStart: (path) => {
                ws.send(JSON.stringify({ type: "upload_output", chunk: `Uploading ${path}\n` }));
              },
              onFileComplete: (path) => {
                ws.send(JSON.stringify({ type: "upload_output", chunk: `  ✓ ${path}\n` }));
              },
              onFileError: (path, err) => {
                ws.send(JSON.stringify({ type: "upload_output", chunk: `  ✗ ${path}: ${err.message}\n` }));
              },
              onProgress: (completed, total) => {
                ws.send(JSON.stringify({ type: "upload_progress", completed, total }));
              },
            });

            if (result.success) {
              const acct = getActiveHubSpotAccount();
              ws.send(JSON.stringify({
                type: "upload_complete",
                output: `Uploaded ${result.uploaded} files`,
                portalId: acct?.portalId || "",
                dataCenter: acct?.dataCenter || "na1",
                themeName: session.themeName,
                contentMode: getServerContentMode(),
              }));
            } else {
              const errors = parseApiErrors(result.errors);
              ws.send(JSON.stringify({
                type: "upload_failed",
                output: result.errors.map((e) => `${e.file}: ${e.message}`).join("\n"),
                errors,
              }));
            }
          } else {
            // --- CLI mode: legacy hs cms upload subprocess ---
            if (!isSafeThemeName(session.themeName)) {
              ws.send(JSON.stringify({
                type: "upload_failed",
                output: "Theme name contains unsupported characters and cannot be uploaded via the HubSpot CLI.",
                errors: [{ file: "", message: "Unsafe theme name", fixable: false }],
              }));
              break;
            }
            const jobId = startStreamingJob(
              "hs", ["cms", "upload", session.themePath, session.themeName],
              "Uploading to HubSpot",
              { cwd: join(session.themePath, ".."), timeout: 180_000 }
            );

            ws.send(JSON.stringify({ type: "upload_started", jobId }));

            const chunkListener = (chunk: string) => {
              ws.send(JSON.stringify({ type: "upload_output", chunk }));
            };
            addJobListener(jobId, chunkListener);

            const pollInterval = setInterval(() => {
              const job = getJob(jobId);
              if (!job || job.status === "running") return;

              clearInterval(pollInterval);
              removeJobListener(jobId, chunkListener);

              if (job.status === "completed") {
                const auth = detectHubSpotAuth();
                const dc = auth.portalId ? detectDataCenter(auth.portalId) : "na1";
                ws.send(JSON.stringify({
                  type: "upload_complete",
                  output: job.output,
                  portalId: auth.portalId || "",
                  dataCenter: dc,
                  themeName: session.themeName,
                  contentMode: getServerContentMode(),
                }));
              } else {
                const errors = parseUploadErrors(job.output);
                ws.send(JSON.stringify({
                  type: "upload_failed",
                  output: job.output,
                  errors,
                  exitCode: job.exitCode,
                }));
              }
            }, 500);
          }
        } catch (err) {
          ws.send(JSON.stringify({
            type: "error",
            message: publicErrorMessage(err),
          }));
        }
        break;
      }

      case "upload_fix_with_ai": {
        const errorContext = String(msg.errorContext || "");
        if (!errorContext.trim()) {
          ws.send(JSON.stringify({ type: "error", message: "No error context provided" }));
          break;
        }

        const fixPrompt = `The HubSpot upload ("hs cms upload") failed. Below is the upload log output containing the errors.

IMPORTANT: Be verbose in your response. For each error:
1. State exactly which file has the problem and what the error is
2. Explain WHY this error occurs (e.g. "HubSpot doesn't support textarea field type" or "field name 'name' is reserved in HubSpot modules")
3. Describe the specific fix you're applying (e.g. "Changing field type from textarea to text" or "Renaming field from 'name' to 'item_name'")
4. Apply the fix to the module files

CRITICAL: After fixing the reported errors, scan ALL other module files in the theme for the same issues. For example, if you fix "name" → "item_name" in one module, check every other module's fields.json for the same problem. Fix all occurrences, not just the ones in the error log.

After fixing all errors, summarize the changes you made.

Upload log:
${errorContext}`;
        addMessage("user", fixPrompt);
        saveSession();

        ws.send(JSON.stringify({ type: "upload_fix_started" }));

        try {
          await handleGenerateStream(fixPrompt, (chunk) => {
            // Stream to both the chat panel and the upload panel
            ws.send(JSON.stringify({ type: "stream", content: chunk }));
            ws.send(JSON.stringify({ type: "upload_fix_stream", content: chunk }));
          });

          // Write fixes to disk and commit
          const fixSession = getSession();
          if (fixSession) {
            writeModulesToDisk();
            const fixHash = commitThemeState(fixSession.themePath, "AI fix: upload errors");
            if (fixHash) {
              ws.send(JSON.stringify({ type: "version_created", hash: fixHash }));
            }
          }

          ws.send(JSON.stringify({ type: "upload_fix_complete" }));
          {
            const sess = getSession();
            ws.send(JSON.stringify({
              type: "modules_updated",
              modules: getOrderedModules().map((m) => m.moduleName),
              templateId: sess?.activeTemplateId || null,
              templates: (sess?.templates || []).map((t: any) => ({
                id: t.id, label: t.label, pageType: t.pageType, moduleCount: t.modules.length,
              })),
            }));
          }
        } catch (err) {
          ws.send(JSON.stringify({
            type: "upload_failed",
            output: publicErrorMessage(err),
            errors: [{ file: "AI fix", message: publicErrorMessage(err), fixable: false }],
          }));
        }
        break;
      }

      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;

      // ---------------------------------------------------------------
      // Plan approval — explicit gate clearance.
      //
      // The user clicked "Approve plan" in the Plan pane. We exit plan
      // mode (so the next agentic call is allowed), prepend the plan as
      // a design brief, and run the existing agentic pipeline.
      // ---------------------------------------------------------------
      // Plan approve/discard are now thin aliases over the unified plan
      // checkpoint (VIB-1880). The canonical path is checkpoint_resolve
      // {kind:"plan"}; these remain for older clients.
      case "plan_approve": {
        await runPlanApproval();
        break;
      }

      case "plan_discard": {
        runPlanDiscard();
        break;
      }

      // ---------------------------------------------------------------
      // Checkpoint resolution (VIB-1877) — the user clicked approve /
      // steer / skip / cancel on a checkpoint card. Re-enters the parked
      // pipeline at the gate. approve/skip build & commit; steer re-parks
      // with a fresh card; cancel drops the run.
      // ---------------------------------------------------------------
      case "checkpoint_resolve": {
        const session = getSession();
        if (!session) {
          ws.send(JSON.stringify({ type: "error", message: "No active session" }));
          break;
        }
        const pending = session.pendingCheckpoint;
        if (!pending) {
          ws.send(JSON.stringify({ type: "error", message: "No checkpoint is awaiting resolution." }));
          break;
        }

        const action = String(msg.action || "");
        if (!["approve", "steer", "skip", "cancel"].includes(action)) {
          ws.send(JSON.stringify({ type: "error", message: `Invalid checkpoint action: ${action}` }));
          break;
        }

        // Structure checkpoint (VIB-1879) carries an edited module outline back
        // on approve/skip. Coerce defensively — the build re-sanitizes names.
        const outline = Array.isArray(msg.outline)
          ? msg.outline
              .filter((it: unknown): it is Record<string, unknown> => !!it && typeof (it as Record<string, unknown>).name === "string")
              .map((it: Record<string, unknown>) => ({
                name: String(it.name),
                description: typeof it.description === "string" ? it.description : undefined,
                sourceIndex: Number.isInteger(it.sourceIndex) ? (it.sourceIndex as number) : undefined,
              }))
          : undefined;

        const resolution: CheckpointResolution = {
          kind: pending.kind,
          action: action as CheckpointAction,
          note: typeof msg.note === "string" ? msg.note : undefined,
          // Structure checkpoint (VIB-1879) carries the edited outline.
          outline,
          // Brand-intake channels (VIB-1878) — only meaningful for a
          // brand_intake gate resolved with "Bring your brand" (approve).
          ...(pending.kind === "brand_intake" && msg.brandIntake && typeof msg.brandIntake === "object"
            ? { brandIntake: msg.brandIntake as CheckpointResolution["brandIntake"] }
            : {}),
        };

        // Plan checkpoint (VIB-1880): resolved through the same protocol, but
        // the plan lives on the session — no in-memory resume store. approve →
        // build, steer → re-deliberate + re-park, cancel → drop plan.
        if (pending.kind === "plan") {
          session.pendingCheckpoint = undefined;
          saveSession();
          if (action === "cancel") {
            runPlanDiscard();
          } else if (action === "steer") {
            await runPlanDeliberation(resolution.note?.trim() || "Refine the plan further.");
          } else {
            await runPlanApproval();
          }
          break;
        }

        const resumeToken = pending.resumeToken;

        // Clear the gate up front; a `steer` re-parks with a fresh token below.
        session.pendingCheckpoint = undefined;
        saveSession();

        try {
          clearPipelineEventLog();
          const pipelineSteps: { step: string; label: string; decisions?: string[] }[] = [];
          const pipelineModules: { name: string; status: "complete" | "failed" }[] = [];

          const result = await handleAgenticResume(
            resumeToken,
            resolution,
            buildPipelineOnEvent(pipelineSteps, pipelineModules),
            // Rehydrate the in-memory resume store from the persisted state if
            // the server restarted while parked (VIB-1883). `pending` is the
            // pre-clear snapshot taken at the top of this handler.
            pending.resumeState,
          );

          // Cancelled — nothing built.
          if (result.canceled) {
            sendToClient({ type: "checkpoint_cancelled" });
            sendToClient({ type: "generation_complete" });
            clearPipelineEventLog();
            break;
          }

          // Steered — re-parked at a fresh gate. Persist and wait again.
          if (result.pendingCheckpoint) {
            const sess = getSession();
            if (sess) {
              sess.pendingCheckpoint = result.pendingCheckpoint;
              saveSession();
            }
            sendGenerationCost(result);
            clearPipelineEventLog();
            break;
          }

          // approve / skip — the build completed. Apply, commit, finish.
          finalizeAgenticGeneration(result, {
            steps: pipelineSteps,
            modules: pipelineModules,
            commitLabel: "Checkpoint approved: implementation",
          });
        } catch (err) {
          clearPipelineEventLog();
          sendToClient({
            type: "error",
            message: publicErrorMessage(err),
          });
        }
        break;
      }

      default:
        ws.send(JSON.stringify({ type: "error", message: `Unknown type: ${msg.type}` }));
    }
  });

  // Track this as the active client so in-flight pipelines send to it
  activeClientWs = ws;

  // Send initial state
  const session = getSession();
  if (session) {
    const cfg = loadConfig();
    const engineLabels: Record<string, string> = {
      "claude-code": "Claude Code",
      "anthropic-api": "Anthropic API",
      "claude-oauth": "Claude (OAuth)",
      "openai-api": "OpenAI API",
      "gemini-cli": "Gemini CLI",
      "gemini-api": "Gemini API",
      "codex-cli": "Codex CLI",
      "api": "Anthropic API",
    };
    const generating = isGenerating();
    const activeTpl = getActiveTemplate();
    ws.send(JSON.stringify({
      type: "init",
      sessionId: session.id,
      themeName: session.themeName,
      modules: getOrderedModules().map((m) => m.moduleName),
      messageCount: session.messages.length,
      messages: session.messages,
      gitAvailable: isGitAvailable(),
      engine: cfg.aiEngine ? engineLabels[cfg.aiEngine] || cfg.aiEngine : "",
      updatedAt: session.updatedAt,
      // Multi-template context
      templateId: activeTpl?.id || null,
      pageType: activeTpl?.pageType || null,
      templates: (session.templates || []).map((t) => ({
        id: t.id,
        label: t.label,
        pageType: t.pageType,
        moduleCount: t.modules.length,
      })),
      // Plan-mode state
      planMode: !!cfg.planMode,
      plan: session.brandAssets?.plan || "",
      // Active generation state for reconnecting clients
      isGenerating: generating,
      // A parked checkpoint survives a client refresh / device sleep — the
      // server keeps the gate, so re-send it so the client can resume (VIB-1876).
      // Strip the internal `resumeState` (VIB-1883): it's a server-only disk
      // payload (plan/design system/blueprint); the UI only needs the preview.
      pendingCheckpoint: session.pendingCheckpoint
        ? { ...session.pendingCheckpoint, resumeState: undefined }
        : null,
      // Per-project running generation cost (VIB-1770)
      costTotal: session.costTotal || null,
    }));

    // Replay accumulated pipeline events so reconnecting clients catch up
    if (generating && pipelineEventLog.length > 0) {
      for (const event of pipelineEventLog) {
        ws.send(JSON.stringify(event));
      }
    }
  } else {
    ws.send(JSON.stringify({ type: "needs_setup" }));
  }
}
