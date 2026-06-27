/**
 * AI handler coordinator for vibe coding mode.
 * Dispatches to engine implementations, manages generation state,
 * and delegates response parsing. Supports both single-call and
 * agentic pipeline modes.
 */

import { execSync } from "node:child_process";
import { loadConfig, getApiKeyForEngine, type AIEngineType } from "../utils/config.js";
import { getSession, addMessage, saveSession, updateModules, reorderModules, getModuleLibrary, getActiveTemplate, applyMultiPageResult, addProjectCost } from "./session.js";
import { parseAndApplyModules } from "./ai-parser.js";
import { log } from "./log.js";
import { runWithCostTracking } from "./cost-tracker.js";
import {
  streamWithAnthropicAPI,
  streamWithClaudeOAuth,
  streamWithOpenAIAPI,
  streamWithGeminiAPI,
  generateWithClaudeCode,
  generateWithCLI,
} from "./ai-engines.js";
import { hasValidOAuthToken, getValidAccessToken } from "../utils/claude-oauth.js";
import { getFileContexts } from "./routes/upload-files.js";
import { runAgentPipeline, resumeAgentPipeline, isAgenticCapable, isCLIEngine } from "./agent/pipeline.js";
import { saveBrandAssetToTheme } from "./brand-enrichment.js";
import type { CheckpointResolution, CheckpointResumeState } from "./agent/types.js";
import { isAbortError } from "./agent/types.js";
import { runWithTrace, setTraceOutput } from "./langfuse.js";
import type { AgentEngine } from "./agent/engine-adapter.js";
import type { PipelineEvent, PipelineResult, MultiPagePipelineResult } from "./agent/types.js";
import type { SessionSnapshot, PipelineMetadata } from "./session/types.js";

// ---------------------------------------------------------------------------
// Parse warning callback — set by the WebSocket handler
// ---------------------------------------------------------------------------

let parseWarningCallback: ((warning: string) => void) | null = null;

export function setParseWarningCallback(cb: ((warning: string) => void) | null): void {
  parseWarningCallback = cb;
}

// ---------------------------------------------------------------------------
// Generation lock — prevents session switching while AI is generating
// ---------------------------------------------------------------------------

let generatingSessionId: string | null = null;

export function isGenerating(): boolean {
  return generatingSessionId !== null;
}

// ---------------------------------------------------------------------------
// Barge-in cancellation (VIB-1880)
//
// The active agentic run registers an AbortController here. A chat message that
// arrives mid-build calls `cancelActiveGeneration()` to abort it (cancel-and-
// replan); the signal threads down through the pipeline → concurrency limiter →
// provider requests so in-flight generation stops spending immediately. Each
// run is tagged with a monotonic id so a settling old run never clears a newer
// run's controller.
// ---------------------------------------------------------------------------

interface ActiveRun {
  id: number;
  abort: AbortController;
}
let activeRun: ActiveRun | null = null;
let runCounter = 0;

/** Begin tracking a cancellable run. Returns the run handle + its signal. */
function beginCancellableRun(): { run: ActiveRun; signal: AbortSignal } {
  const run: ActiveRun = { id: ++runCounter, abort: new AbortController() };
  activeRun = run;
  return { run, signal: run.abort.signal };
}

/** Stop tracking a run, but only if it's still the current one. */
function endCancellableRun(run: ActiveRun): void {
  if (activeRun === run) activeRun = null;
}

/**
 * Abort the in-flight agentic run, if any (barge-in). Returns true if a run was
 * actually signalled. The run unwinds on its own; callers should wait for
 * `isGenerating()` to clear before starting a replacement.
 */
export function cancelActiveGeneration(): boolean {
  if (!activeRun) return false;
  activeRun.abort.abort();
  return true;
}

// ---------------------------------------------------------------------------
// Finish response — save message and parse modules
// ---------------------------------------------------------------------------

function finishResponse(fullResponse: string): void {
  if (generatingSessionId) {
    const current = getSession();
    if (!current || current.id !== generatingSessionId) {
      log.warn("ai-handler", "Session changed during generation — discarding AI output");
      return;
    }
  }
  addMessage("assistant", fullResponse);
  parseAndApplyModules(fullResponse, parseWarningCallback || undefined);
  saveSession();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stream an AI response for a chat message.
 * Calls onChunk with text fragments as they arrive.
 * After the full response, parses module JSON blocks and updates the session.
 */
export async function handleGenerateStream(
  userMessage: string,
  onChunk: (chunk: string) => void,
  onStatus?: (status: string) => void,
  fileIds?: string[]
): Promise<void> {
  const session = getSession();
  if (!session) throw new Error("No active session");

  const capturedSessionId = session.id;
  generatingSessionId = capturedSessionId;

  // Load file contexts for any attached files
  const fileContexts = fileIds?.length ? getFileContexts(fileIds) : undefined;

  try {
    const config = loadConfig();
    const engine = config.aiEngine || detectDefaultEngine();

    switch (engine) {
      case "anthropic-api":
      case "api": {
        const apiKey = getApiKeyForEngine("anthropic-api", config);
        if (!apiKey) throw new Error("Anthropic API key not configured. Open Settings to add one.");
        await streamWithAnthropicAPI(userMessage, apiKey, session.themeName,
          config.anthropicApiModel || "claude-sonnet-4-6", onChunk, onStatus, finishResponse, fileContexts);
        break;
      }
      case "claude-oauth": {
        await streamWithClaudeOAuth(userMessage, session.themeName,
          config.anthropicApiModel || "claude-sonnet-4-6", onChunk, onStatus, finishResponse, fileContexts);
        break;
      }
      case "openai-api": {
        const apiKey = getApiKeyForEngine("openai-api", config);
        if (!apiKey) throw new Error("OpenAI API key not configured. Open Settings to add one.");
        await streamWithOpenAIAPI(userMessage, apiKey, session.themeName,
          config.openaiApiModel || "gpt-4o", onChunk, onStatus, finishResponse, fileContexts);
        break;
      }
      case "gemini-api": {
        const apiKey = getApiKeyForEngine("gemini-api", config);
        if (!apiKey) throw new Error("Gemini API key not configured. Open Settings to add one.");
        await streamWithGeminiAPI(userMessage, apiKey, session.themeName, onChunk, onStatus, finishResponse, fileContexts);
        break;
      }
      case "claude-code":
        await generateWithClaudeCode(userMessage, session.themeName, onChunk, onStatus, finishResponse, fileContexts);
        break;
      case "gemini-cli":
        await generateWithCLI("gemini", userMessage, session.themeName, onChunk, onStatus, finishResponse, fileContexts);
        break;
      case "codex-cli":
        await generateWithCLI("codex", userMessage, session.themeName, onChunk, onStatus, finishResponse, fileContexts);
        break;
      case "langdock-api": {
        const langdockKey = getApiKeyForEngine("langdock-api", config);
        if (!langdockKey) throw new Error("Langdock API key not configured. Open Settings to add one.");
        const provider = config.langdockProvider || "anthropic";
        const baseUrls: Record<string, string> = {
          anthropic: "https://api.langdock.com/anthropic",
          openai: "https://api.langdock.com/openai",
          google: "https://api.langdock.com/google",
          mistral: "https://api.langdock.com/mistral",
        };
        const base = config.langdockBaseUrl || baseUrls[provider];
        const ldModel = config.langdockApiModel;
        switch (provider) {
          case "openai":
          case "mistral":
            await streamWithOpenAIAPI(userMessage, langdockKey, session.themeName,
              ldModel || "gpt-4.1", onChunk, onStatus, finishResponse, fileContexts,
              `${base}/v1/chat/completions`);
            break;
          case "google":
            await streamWithGeminiAPI(userMessage, langdockKey, session.themeName, onChunk, onStatus, finishResponse, fileContexts,
              `${base}/v1beta/models/${ldModel || "gemini-2.5-flash"}:streamGenerateContent?alt=sse`,
              ldModel);
            break;
          case "anthropic":
          default:
            await streamWithAnthropicAPI(userMessage, langdockKey, session.themeName,
              ldModel || "claude-sonnet-4-6", onChunk, onStatus, finishResponse, fileContexts, base);
            break;
        }
        break;
      }
      default:
        throw new Error(`Unknown AI engine: ${engine}. Open Settings to configure one.`);
    }
  } finally {
    generatingSessionId = null;
    parseWarningCallback = null;
  }
}

/**
 * Detect the best available engine when none is configured.
 */
function detectDefaultEngine(): AIEngineType {
  const config = loadConfig();
  if (hasValidOAuthToken()) return "claude-oauth";
  if (config.anthropicApiKey || process.env.ANTHROPIC_API_KEY) return "anthropic-api";
  if (config.openaiApiKey || process.env.OPENAI_API_KEY) return "openai-api";
  if (config.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY) return "gemini-api";
  try { execSync("claude --version", { stdio: "pipe" }); return "claude-code"; } catch {}
  try { execSync("gemini --version", { stdio: "pipe" }); return "gemini-cli"; } catch {}
  try { execSync("codex --version", { stdio: "pipe" }); return "codex-cli"; } catch {}
  throw new Error("No AI engine available. Open Settings to configure one.");
}

/**
 * Non-streaming generation (used by REST API fallback).
 */
export async function handleGenerate(userMessage: string): Promise<string> {
  let fullResponse = "";
  await handleGenerateStream(userMessage, (chunk) => {
    fullResponse += chunk;
  });
  return fullResponse;
}

// ---------------------------------------------------------------------------
// Agentic pipeline
// ---------------------------------------------------------------------------

/**
 * Take an immutable snapshot of the current session state for the agentic pipeline.
 */
function takeSnapshot(): SessionSnapshot {
  const session = getSession()!;
  const tpl = getActiveTemplate();
  const modules = tpl ? [...tpl.modules] : [...session.modules];
  const moduleOrder = tpl ? [...tpl.moduleOrder] : [...session.moduleOrder];

  const snap: SessionSnapshot = {
    modules,
    moduleOrder,
    sharedCss: tpl?.sharedCss || session.sharedCss,
    sharedJs: tpl?.sharedJs || session.sharedJs,
    messages: [...session.messages],
    themeName: session.themeName,
    themePath: session.themePath,
    contentMode: tpl?.contentMode,
    brandAssets: session.brandAssets ? { ...session.brandAssets } : undefined,
  };

  if (session.templates.length > 1) {
    snap.activePageLabel = tpl?.label;
    snap.sitePages = session.templates.map((t) => ({
      id: t.id,
      label: t.label,
      pageType: t.pageType,
      moduleCount: t.modules.length,
    }));
  }

  return snap;
}

/**
 * Resolve the API engine type and key/model for agentic pipeline.
 */
export function resolveAgenticEngine(config: ReturnType<typeof loadConfig>): {
  engine: AgentEngine;
  apiKey: string;
  model: string;
} {
  const engineType = config.aiEngine || detectDefaultEngine();

  if (!isAgenticCapable(engineType)) {
    throw new Error("Agentic pipeline is not available for this engine.");
  }

  // CLI engines don't need an API key
  if (isCLIEngine(engineType)) {
    let model = "";
    if (engineType === "claude-code") {
      model = config.claudeCodeModel || "";
    }
    return { engine: engineType as AgentEngine, apiKey: "", model };
  }

  // Claude OAuth resolves its token at call time in the engine adapter
  let apiKey: string | undefined;
  if (engineType === "claude-oauth") {
    if (!hasValidOAuthToken()) {
      throw new Error("Claude OAuth session expired. Please re-authenticate in Settings.");
    }
    apiKey = "oauth"; // Token resolved fresh in engine adapter (auto-refresh)
  } else {
    apiKey = getApiKeyForEngine(engineType, config);
  }
  if (!apiKey) {
    throw new Error(`API key not configured for ${engineType}. Open Settings to add one.`);
  }

  let model: string;
  switch (engineType) {
    case "anthropic-api":
    case "claude-oauth":
      model = config.anthropicApiModel || "claude-sonnet-4-6";
      break;
    case "openai-api":
      model = config.openaiApiModel || "gpt-5.5";
      break;
    case "gemini-api":
      model = config.geminiApiModel || "gemini-2.5-pro";
      break;
    case "langdock-api": {
      const ldDefaults: Record<string, string> = {
        anthropic: "claude-sonnet-4-6",
        openai: "gpt-4.1",
        google: "gemini-2.5-flash",
        mistral: "mistral-large-latest",
      };
      model = config.langdockApiModel || ldDefaults[config.langdockProvider || "anthropic"];
      break;
    }
    case "claude-code":
      model = config.claudeCodeModel || "";
      break;
    case "codex-cli":
      model = config.codexCliModel || "";
      break;
    case "gemini-cli":
      model = config.geminiCliModel || "";
      break;
    default:
      model = "";
  }

  return { engine: engineType as AgentEngine, apiKey, model };
}

/**
 * Build a compact result summary for the Langfuse trace output (VIB-1862), so
 * the Traces list shows a meaningful preview instead of an empty result. Kept
 * small — `setTraceOutput` truncates, but a short structured object is more
 * useful than a giant blob of generated code.
 */
function summarizePipelineOutput(result: PipelineResult): Record<string, unknown> {
  const multiPage = (result as PipelineResult & { multiPage?: MultiPagePipelineResult }).multiPage;
  return {
    modules: result.modules.map((m) => m.moduleName),
    moduleCount: result.modules.length,
    moduleOrder: result.moduleOrder,
    stats: result.stats,
    ...(multiPage ? { pages: multiPage.pages.map((p) => p.pageId) } : {}),
    assistantMessage: result.assistantMessage,
  };
}

/**
 * Run the agentic pipeline for a user message.
 * Returns the PipelineResult. The caller (WebSocket handler in server.ts)
 * is responsible for applying the result to the session and committing.
 */
export async function handleAgenticGenerate(
  userMessage: string,
  onEvent: (event: PipelineEvent) => void,
  fileIds?: string[],
  checkpointsEnabled = false,
): Promise<PipelineResult> {
  const session = getSession();
  if (!session) throw new Error("No active session");

  const capturedSessionId = session.id;
  generatingSessionId = capturedSessionId;
  const { run, signal } = beginCancellableRun();

  try {
    const config = loadConfig();
    const { engine, apiKey, model } = resolveAgenticEngine(config);
    const concurrency = config.agenticConcurrency || 20;

    const snapshot = takeSnapshot();

    // If an approved plan exists, prepend it as a design brief — the pipeline
    // treats it as the spec rather than guessing at the user's intent.
    const approvedPlan = snapshot.brandAssets?.plan;
    let enrichedMessage = userMessage;
    if (approvedPlan && approvedPlan.trim()) {
      enrichedMessage = `## Approved plan\n\nBuild the page according to this plan exactly. The user reviewed and approved it; do not deviate from its goal, audience, sections, or content unless the user message below explicitly requests changes.\n\n${approvedPlan}\n\n---\n\n## User message\n\n${userMessage}`;
    }

    // Resolve uploaded file content and append to user message
    const fileContexts = fileIds?.length ? getFileContexts(fileIds) : undefined;
    if (fileContexts?.length) {
      for (const fc of fileContexts) {
        if (fc.type === "document" && fc.extractedText) {
          enrichedMessage += `\n\n---\n[Attached document: ${fc.originalName}]\n${fc.extractedText}`;
        }
        if (fc.type === "image" && fc.usage === "asset" && fc.assetPath) {
          enrichedMessage += `\n\n[Uploaded image: ${fc.originalName} → available as get_asset_url("${fc.assetPath}")]`;
        }
      }
    }

    // Build library module list for intent analyzer
    const library = getModuleLibrary();
    const currentModuleNames = new Set(
      snapshot.modules.map((m) => m.moduleName),
    );
    const libraryModules = library
      .filter((e) => !currentModuleNames.has(e.module.moduleName))
      .map((e) => ({ name: e.module.moduleName, usedIn: e.usedIn }));

    // Wrap in a cost-tracking scope so every model call's usage accumulates
    // into one per-page total (VIB-1770). Independent of Langfuse — works in
    // the local-CLI model with no Langfuse keys configured.
    const { result, cost } = await runWithCostTracking(() =>
      runWithTrace(
        {
          name: "agent_pipeline",
          sessionId: snapshot.themeName,
          input: userMessage,
          metadata: { engine, model, concurrency },
          tags: ["vibespot", "agentic-pipeline"],
        },
        async () => {
          const r = await runAgentPipeline(
            enrichedMessage,
            snapshot,
            engine,
            apiKey,
            model,
            concurrency,
            onEvent,
            libraryModules,
            checkpointsEnabled,
            signal,
          );
          setTraceOutput(summarizePipelineOutput(r));
          return r;
        },
      ),
    ).catch((err) => {
      // Barge-in (VIB-1880): a newer message aborted this run — return a clean
      // "canceled" result instead of surfacing the abort as an error.
      if (isAbortError(err)) {
        log.info("ai-handler", "Agentic run cancelled (barge-in)");
        return { result: canceledPipelineResult(snapshot), cost: undefined };
      }
      throw err;
    });
    result.cost = cost;

    if (result.canceled) return result;

    // Verify session hasn't changed during generation
    const current = getSession();
    if (!current || current.id !== capturedSessionId) {
      log.warn("ai-handler", "Session changed during agentic generation — discarding output");
      throw new Error("Session changed during generation");
    }

    return result;
  } finally {
    generatingSessionId = null;
    endCancellableRun(run);
  }
}

/** A no-op pipeline result for a cancelled (barge-in) run — nothing was built,
 * pre-run state is preserved so the caller skips apply/commit. */
function canceledPipelineResult(snapshot: ReturnType<typeof takeSnapshot>): PipelineResult {
  return {
    modules: [...snapshot.modules],
    moduleOrder: snapshot.moduleOrder as string[],
    sharedCss: snapshot.sharedCss,
    sharedJs: snapshot.sharedJs,
    assistantMessage: "",
    canceled: true,
    stats: { modulesGenerated: 0, modulesUnchanged: snapshot.modules.length, modulesFailed: 0, durationMs: 0 },
  };
}

/**
 * Resume a pipeline parked at a checkpoint gate (VIB-1877) with the user's
 * resolution. Mirrors `handleAgenticGenerate`'s scoping (cost tracking + trace)
 * so the continuation's model calls roll into the same per-page cost. Returns
 * the final `PipelineResult`, OR — for `steer` — another paused result with a
 * fresh `pendingCheckpoint`.
 */
export async function handleAgenticResume(
  resumeToken: string,
  resolution: CheckpointResolution,
  onEvent: (event: PipelineEvent) => void,
  fallbackState?: CheckpointResumeState,
): Promise<PipelineResult> {
  const session = getSession();
  if (!session) throw new Error("No active session");

  const capturedSessionId = session.id;
  generatingSessionId = capturedSessionId;
  const { run, signal } = beginCancellableRun();

  try {
    const config = loadConfig();
    const { engine, apiKey, model } = resolveAgenticEngine(config);
    const concurrency = config.agenticConcurrency || 20;

    const snapshot = takeSnapshot();

    const { result, cost } = await runWithCostTracking(() =>
      runWithTrace(
        {
          name: "agent_pipeline_resume",
          sessionId: snapshot.themeName,
          input: { action: resolution.action, kind: resolution.kind },
          metadata: { engine, model, concurrency },
          tags: ["vibespot", "agentic-pipeline", "checkpoint-resume"],
        },
        async () => {
          const r = await resumeAgentPipeline(
            resumeToken,
            resolution,
            snapshot,
            engine,
            apiKey,
            model,
            concurrency,
            onEvent,
            signal,
            fallbackState,
          );
          setTraceOutput(summarizePipelineOutput(r));
          return r;
        },
      ),
    ).catch((err) => {
      if (isAbortError(err)) {
        log.info("ai-handler", "Checkpoint resume cancelled (barge-in)");
        return { result: canceledPipelineResult(snapshot), cost: undefined };
      }
      throw err;
    });
    result.cost = cost;

    if (result.canceled) return result;

    const current = getSession();
    if (!current || current.id !== capturedSessionId) {
      log.warn("ai-handler", "Session changed during checkpoint resume — discarding output");
      throw new Error("Session changed during generation");
    }

    // Brand intake (VIB-1878): persist the derived brand assets so the design
    // build and all future edits inherit them. Writes to .vibespot/*.md too.
    if (result.brandAssetsUpdate) {
      if (result.brandAssetsUpdate.styleguide) {
        saveBrandAssetToTheme(current, "styleguide", result.brandAssetsUpdate.styleguide);
      }
      if (result.brandAssetsUpdate.brandvoice) {
        saveBrandAssetToTheme(current, "brandvoice", result.brandAssetsUpdate.brandvoice);
      }
      saveSession();
    }

    return result;
  } finally {
    generatingSessionId = null;
    endCancellableRun(run);
  }
}

/**
 * Run the streamlined Figma conversion pipeline.
 * Bypasses the full agentic pipeline — CSS is generated deterministically from
 * design tokens, sections map directly to module specs, and the AI only
 * translates each section to HubL (no creative decisions).
 */
export async function handleFigmaImport(
  extraction: import("./figma/types.js").FigmaExtraction,
  themeName: string,
  onEvent: (event: PipelineEvent) => void,
  options?: { useAssets?: boolean },
): Promise<PipelineResult> {
  const session = getSession();
  if (!session) throw new Error("No active session");

  const capturedSessionId = session.id;
  generatingSessionId = capturedSessionId;

  try {
    const { runFigmaConversion } = await import("./agent/figma-pipeline.js");

    const config = loadConfig();
    const { engine, apiKey, model } = resolveAgenticEngine(config);
    const concurrency = config.agenticConcurrency || 20;

    const snapshot = takeSnapshot();

    const { result, cost } = await runWithCostTracking(() =>
      runWithTrace(
        {
          name: "figma_import",
          sessionId: themeName,
          input: { fileName: extraction.fileName, sections: extraction.sections.length },
          metadata: { engine, model, concurrency },
          tags: ["vibespot", "figma-import"],
        },
        async () => {
          const r = await runFigmaConversion(
            extraction,
            themeName,
            engine,
            apiKey,
            model,
            concurrency,
            onEvent,
            snapshot.brandAssets,
            options?.useAssets,
          );
          setTraceOutput(summarizePipelineOutput(r));
          return r;
        },
      ),
    );
    result.cost = cost;

    const current = getSession();
    if (!current || current.id !== capturedSessionId) {
      log.warn("ai-handler", "Session changed during Figma import — discarding output");
      throw new Error("Session changed during generation");
    }

    return result;
  } finally {
    generatingSessionId = null;
  }
}

/**
 * Apply a pipeline result to the current session.
 * Called by the WebSocket handler after successful pipeline execution.
 */
export function applyPipelineResult(result: PipelineResult, pipelineMeta?: PipelineMetadata): void {
  const multiPage = (result as PipelineResult & { multiPage?: MultiPagePipelineResult }).multiPage;

  if (multiPage && multiPage.pages.length > 0) {
    const pageLabels = new Map<string, { label: string; pageType: import("./session/types.js").PageType }>();
    for (const page of multiPage.pages) {
      pageLabels.set(page.pageId, {
        label: page.label || page.pageId,
        pageType: page.pageType || "website_page",
      });
    }

    applyMultiPageResult({
      pages: multiPage.pages,
      sharedModules: multiPage.sharedModules,
      sharedCss: multiPage.sharedCss,
      sharedJs: multiPage.sharedJs,
      pageLabels,
    });
  } else {
    // Single-page result: update active template
    updateModules({
      modules: result.modules,
      sharedCss: result.sharedCss,
      sharedJs: result.sharedJs,
    });
    reorderModules(result.moduleOrder);

    const ct = result.contentType;
    if (ct === "email") {
      const tpl = getActiveTemplate();
      if (tpl && !tpl.contentMode) {
        tpl.contentMode = "email";
      }
    }
  }

  // Roll this generation's cost into the project (per-theme) running total
  // before persisting (VIB-1770). Cost is carried on the pipeline metadata.
  if (pipelineMeta?.cost) {
    addProjectCost(pipelineMeta.cost);
  }

  // Add assistant message to chat history with pipeline metadata
  addMessage("assistant", result.assistantMessage, pipelineMeta);
  saveSession();
}

// ---------------------------------------------------------------------------
// Plan mode — deliberation phase before generation
// ---------------------------------------------------------------------------

/**
 * Stream a plan-mode AI response.
 * Uses the existing engine adapter with a plan-focused system prompt.
 * No module generation happens here — caller parses the response for
 * `vibespot-plan` and `vibespot-choices` blocks.
 */
export async function handlePlanModeStream(
  userMessage: string,
  onChunk: (chunk: string) => void,
  fileIds?: string[],
): Promise<string> {
  const session = getSession();
  if (!session) throw new Error("No active session");

  const config = loadConfig();
  const { engine, apiKey, model } = resolveAgenticEngine(config);

  // Lazy import to avoid circular dependency.
  const [{ buildPlanModePrompt }, { callAgent }] = await Promise.all([
    import("./agent/prompts/plan-mode.js"),
    import("./agent/engine-adapter.js"),
  ]);

  // Count assistant turns in plan mode for phase guidance.
  // Plan-mode messages share the same chat history; this is an approximation
  // (every assistant turn in the current chat counts) but works for phase
  // selection. Refresh logic: turn 0 = no prior assistant messages yet.
  const turnCount = session.messages.filter((m) => m.role === "assistant").length;

  const existingModuleNames = session.modules.map((m) => m.moduleName);
  const library = getModuleLibrary();
  const currentSet = new Set(existingModuleNames);
  const libraryModules = library
    .filter((e) => !currentSet.has(e.module.moduleName))
    .map((e) => ({ name: e.module.moduleName, usedIn: e.usedIn }));

  const systemPrompt = buildPlanModePrompt(
    session.themeName,
    session.brandAssets,
    existingModuleNames,
    libraryModules,
    turnCount,
  );

  // Inline file context like the existing generators do.
  const fileContexts = fileIds?.length ? getFileContexts(fileIds) : undefined;
  let enrichedMessage = userMessage;
  if (fileContexts?.length) {
    for (const fc of fileContexts) {
      if (fc.type === "document" && fc.extractedText) {
        enrichedMessage += `\n\n---\n[Attached document: ${fc.originalName}]\n${fc.extractedText}`;
      }
    }
  }

  const result = await callAgent(engine, apiKey, model, {
    systemPrompt,
    messages: [{ role: "user", content: enrichedMessage }],
    maxTokens: 8000,
    onChunk,
    // Web search is most useful during deliberation (looking up competitors,
    // industry references, brand examples). Honored on Anthropic API engines
    // and Claude Code CLI; silently ignored elsewhere.
    enableWebSearch: !!config.webSearch,
  });

  if (result.type === "text") return result.text;
  // Fallback (engines that may force structured output even without schema).
  return JSON.stringify(result.data);
}

/**
 * Check if plan mode is active in config.
 */
export function isPlanModeActive(): boolean {
  return !!loadConfig().planMode;
}

/**
 * Check if agentic mode should be used for the current configuration.
 */
export function shouldUseAgenticMode(): {
  useAgentic: boolean;
  needsPrompt: boolean;
  reason?: string;
} {
  const config = loadConfig();
  const engine = config.aiEngine || detectDefaultEngine();

  if (!isAgenticCapable(engine)) {
    return {
      useAgentic: false,
      needsPrompt: false,
      reason: "Agentic pipeline is not available for this engine.",
    };
  }

  if (config.agenticMode === undefined) {
    return { useAgentic: false, needsPrompt: true };
  }

  return { useAgentic: config.agenticMode, needsPrompt: false };
}
