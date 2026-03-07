/**
 * AI handler coordinator for vibe coding mode.
 * Dispatches to engine implementations, manages generation state,
 * and delegates response parsing.
 */

import { execSync } from "node:child_process";
import { loadConfig, getApiKeyForEngine, type AIEngineType } from "../utils/config.js";
import { getSession, addMessage, saveSession } from "./session.js";
import { parseAndApplyModules } from "./ai-parser.js";
import { log } from "./log.js";
import {
  streamWithAnthropicAPI,
  streamWithOpenAIAPI,
  streamWithGeminiAPI,
  generateWithClaudeCode,
  generateWithCLI,
} from "./ai-engines.js";

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
  onStatus?: (status: string) => void
): Promise<void> {
  const session = getSession();
  if (!session) throw new Error("No active session");

  const capturedSessionId = session.id;
  generatingSessionId = capturedSessionId;

  try {
    const config = loadConfig();
    const engine = config.aiEngine || detectDefaultEngine();

    switch (engine) {
      case "anthropic-api":
      case "api": {
        const apiKey = getApiKeyForEngine("anthropic-api", config);
        if (!apiKey) throw new Error("Anthropic API key not configured. Open Settings to add one.");
        await streamWithAnthropicAPI(userMessage, apiKey, session.themeName,
          config.anthropicApiModel || "claude-sonnet-4-6", onChunk, onStatus, finishResponse);
        break;
      }
      case "openai-api": {
        const apiKey = getApiKeyForEngine("openai-api", config);
        if (!apiKey) throw new Error("OpenAI API key not configured. Open Settings to add one.");
        await streamWithOpenAIAPI(userMessage, apiKey, session.themeName,
          config.openaiApiModel || "gpt-4o", onChunk, onStatus, finishResponse);
        break;
      }
      case "gemini-api": {
        const apiKey = getApiKeyForEngine("gemini-api", config);
        if (!apiKey) throw new Error("Gemini API key not configured. Open Settings to add one.");
        await streamWithGeminiAPI(userMessage, apiKey, session.themeName, onChunk, onStatus, finishResponse);
        break;
      }
      case "claude-code":
        await generateWithClaudeCode(userMessage, session.themeName, onChunk, onStatus, finishResponse);
        break;
      case "gemini-cli":
        await generateWithCLI("gemini", userMessage, session.themeName, onChunk, onStatus, finishResponse);
        break;
      case "codex-cli":
        await generateWithCLI("codex", userMessage, session.themeName, onChunk, onStatus, finishResponse);
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
