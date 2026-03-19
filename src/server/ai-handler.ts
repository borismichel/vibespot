/**
 * AI handler coordinator for vibe coding mode.
 * Dispatches to engine implementations, manages generation state,
 * and delegates response parsing. Supports both single-call and
 * agentic pipeline modes.
 */

import { execSync } from "node:child_process";
import { loadConfig, getApiKeyForEngine, type AIEngineType } from "../utils/config.js";
import { getSession, addMessage, saveSession, updateModules, reorderModules, getModuleLibrary, getActiveTemplate } from "./session.js";
import { parseAndApplyModules } from "./ai-parser.js";
import { log } from "./log.js";
import {
  streamWithAnthropicAPI,
  streamWithOpenAIAPI,
  streamWithGeminiAPI,
  generateWithClaudeCode,
  generateWithCLI,
} from "./ai-engines.js";
import { getFileContexts } from "./routes/upload-files.js";
import { runAgentPipeline, isAgenticCapable, isCLIEngine } from "./agent/pipeline.js";
import type { AgentEngine } from "./agent/engine-adapter.js";
import type { PipelineEvent, PipelineResult } from "./agent/types.js";
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

  return {
    modules,
    moduleOrder,
    sharedCss: tpl?.sharedCss || session.sharedCss,
    sharedJs: tpl?.sharedJs || session.sharedJs,
    messages: [...session.messages],
    themeName: session.themeName,
    themePath: session.themePath,
    brandAssets: session.brandAssets ? { ...session.brandAssets } : undefined,
  };
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

  const apiKey = getApiKeyForEngine(engineType, config);
  if (!apiKey) {
    throw new Error(`API key not configured for ${engineType}. Open Settings to add one.`);
  }

  let model: string;
  switch (engineType) {
    case "anthropic-api":
      model = config.anthropicApiModel || "claude-sonnet-4-6";
      break;
    case "openai-api":
      model = config.openaiApiModel || "gpt-4o";
      break;
    case "gemini-api":
      model = "gemini-2.5-flash";
      break;
    default:
      model = "";
  }

  return { engine: engineType as AgentEngine, apiKey, model };
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
): Promise<PipelineResult> {
  const session = getSession();
  if (!session) throw new Error("No active session");

  const capturedSessionId = session.id;
  generatingSessionId = capturedSessionId;

  try {
    const config = loadConfig();
    const { engine, apiKey, model } = resolveAgenticEngine(config);
    const concurrency = config.agenticConcurrency || 20;

    const snapshot = takeSnapshot();

    // Build library module list for intent analyzer
    const library = getModuleLibrary();
    const currentModuleNames = new Set(
      snapshot.modules.map((m) => m.moduleName),
    );
    const libraryModules = library
      .filter((e) => !currentModuleNames.has(e.module.moduleName))
      .map((e) => ({ name: e.module.moduleName, usedIn: e.usedIn }));

    const result = await runAgentPipeline(
      userMessage,
      snapshot,
      engine,
      apiKey,
      model,
      concurrency,
      onEvent,
      libraryModules,
    );

    // Verify session hasn't changed during generation
    const current = getSession();
    if (!current || current.id !== capturedSessionId) {
      log.warn("ai-handler", "Session changed during agentic generation — discarding output");
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
  // Update modules in the session (merges new + updates existing)
  updateModules({
    modules: result.modules,
    sharedCss: result.sharedCss,
    sharedJs: result.sharedJs,
  });

  // Set the module order from the pipeline result
  reorderModules(result.moduleOrder);

  // Add assistant message to chat history with pipeline metadata
  addMessage("assistant", result.assistantMessage, pipelineMeta);
  saveSession();
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
