/**
 * AI engine implementations — streaming handlers for each supported engine.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { getConversionGuide } from "../ai/prompts.js";
import { loadConfig } from "../utils/config.js";
import { getValidAccessToken, OAUTH_EXTRA_HEADERS, OAUTH_SYSTEM_PREFIX } from "../utils/claude-oauth.js";
import { getSession } from "./session.js";
import { buildVibeSystemPrompt, buildVibeSystemPromptBlocks, buildStateContext, buildMessagesWithContext, getPromptContext, type SystemPromptBlock, type MultimodalMessage } from "./ai-prompts.js";
import { log } from "./log.js";
import type { UploadedFileContext } from "./routes/upload-files.js";

// ---------------------------------------------------------------------------
// Lazy-loaded Anthropic SDK
// ---------------------------------------------------------------------------

let _AnthropicCtor: typeof import("@anthropic-ai/sdk").default | null = null;
async function getAnthropicSDK(): Promise<typeof import("@anthropic-ai/sdk").default> {
  if (!_AnthropicCtor) {
    const mod = await import("@anthropic-ai/sdk");
    _AnthropicCtor = mod.default;
  }
  return _AnthropicCtor;
}

// ---------------------------------------------------------------------------
// File context helper (for CLI engines that don't support vision)
// ---------------------------------------------------------------------------

function buildFileContextText(fileContexts?: UploadedFileContext[]): string {
  if (!fileContexts?.length) return "";
  const parts: string[] = [];
  for (const fc of fileContexts) {
    if (fc.type === "image" && fc.usage === "asset" && fc.assetPath) {
      parts.push(`\n[Uploaded image: ${fc.originalName} → use get_asset_url("${fc.assetPath}")]`);
    }
    if (fc.type === "document" && fc.extractedText) {
      parts.push(`\n\n---\n[Attached document: ${fc.originalName}]\n${fc.extractedText}`);
    }
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// CLI status messages (shown while waiting for buffered CLI output)
// ---------------------------------------------------------------------------

export const CLI_STATUS_MESSAGES = [
  "Analyzing your request...",
  "Reading the conversion guide...",
  "Planning module structure...",
  "Generating HTML templates...",
  "Writing CSS styles...",
  "Creating field definitions...",
  "Building module metadata...",
  "Assembling theme assets...",
  "Polishing the output...",
  "Almost there — hang tight...",
];

// ---------------------------------------------------------------------------
// Anthropic Streaming API (shared helper + public wrappers)
// ---------------------------------------------------------------------------

const RATE_LIMIT_DELAYS = [10, 20, 40, 60, 120]; // seconds

/**
 * Shared streaming helper for all Anthropic-based engines.
 * Accepts a pre-built SDK client and system prompt (string or blocks).
 */
async function _streamAnthropic(
  client: InstanceType<Awaited<ReturnType<typeof getAnthropicSDK>>>,
  system: string | SystemPromptBlock[],
  messages: MultimodalMessage[],
  model: string,
  onChunk: (chunk: string) => void,
  onStatus?: (status: string) => void,
  onFinish?: (fullResponse: string) => void,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      let fullResponse = "";

      let statusIndex = 0;
      const sendStatus = onStatus || (() => {});
      sendStatus(CLI_STATUS_MESSAGES[0]);
      const heartbeat = setInterval(() => {
        statusIndex++;
        sendStatus(CLI_STATUS_MESSAGES[Math.min(statusIndex, CLI_STATUS_MESSAGES.length - 1)]);
      }, 6000);

      try {
        const stream = client.messages.stream({
          model,
          max_tokens: 48000,
          system: system as any,
          messages: messages as unknown as Anthropic.MessageParam[],
        });

        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            const text = event.delta.text;
            fullResponse += text;
            onChunk(text);
          }
        }
      } finally {
        clearInterval(heartbeat);
      }

      if (onFinish) onFinish(fullResponse);
      return;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const errType = (err as { error?: { type?: string } }).error?.type;
      const is429 = status === 429
        || errType === "rate_limit_error"
        || (err instanceof Error && err.message.includes("429"));

      if (!is429 || attempt >= RATE_LIMIT_DELAYS.length) throw err;

      const wait = RATE_LIMIT_DELAYS[attempt];
      log.warn("ai-engine", `Rate limited (429), attempt ${attempt + 1}/${RATE_LIMIT_DELAYS.length} — waiting ${wait}s`);
      if (onStatus) onStatus(`Rate limited by Anthropic API — retrying in ${wait}s...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      if (onStatus) onStatus("Retrying...");
    }
  }
}

/** Prepare common Anthropic call context (messages, system prompt blocks). */
function prepareAnthropicContext(userMessage: string, themeName: string, fileContexts?: UploadedFileContext[]) {
  const conversionGuide = getConversionGuide();
  const session = getSession()!;
  const editMode = session.modules.length > 0;
  const messages = buildMessagesWithContext(userMessage, fileContexts);
  const ctx = getPromptContext();
  const systemBlocks = buildVibeSystemPromptBlocks(conversionGuide, themeName, editMode, ctx.pageType, ctx.brandAssets);
  return { messages, systemBlocks, conversionGuide, editMode };
}

export async function streamWithAnthropicAPI(
  userMessage: string,
  apiKey: string,
  themeName: string,
  model: string,
  onChunk: (chunk: string) => void,
  onStatus?: (status: string) => void,
  onFinish?: (fullResponse: string) => void,
  fileContexts?: UploadedFileContext[],
  baseURL?: string,
): Promise<void> {
  const AnthropicSDK = await getAnthropicSDK();
  const client = new AnthropicSDK({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const { messages, systemBlocks } = prepareAnthropicContext(userMessage, themeName, fileContexts);

  log.info("anthropic", "API call", {
    model,
    systemBlockCount: systemBlocks.length,
    cachedBlocks: systemBlocks.filter((b) => b.cache_control).length,
    messageCount: messages.length,
  });

  await _streamAnthropic(client, systemBlocks, messages, model, onChunk, onStatus, onFinish);
}

// ---------------------------------------------------------------------------
// Claude OAuth Streaming API — uses OAuth token + required headers
// ---------------------------------------------------------------------------

export async function streamWithClaudeOAuth(
  userMessage: string,
  themeName: string,
  model: string,
  onChunk: (chunk: string) => void,
  onStatus?: (status: string) => void,
  onFinish?: (fullResponse: string) => void,
  fileContexts?: UploadedFileContext[]
): Promise<void> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) throw new Error("Claude OAuth session expired. Please re-authenticate in Settings.");

  const AnthropicSDK = await getAnthropicSDK();
  const client = new AnthropicSDK({
    authToken: accessToken,
    defaultHeaders: OAUTH_EXTRA_HEADERS,
  } as any);

  const { messages, systemBlocks } = prepareAnthropicContext(userMessage, themeName, fileContexts);

  // Prepend required Claude Code system prefix as separate first block
  const oauthBlocks: SystemPromptBlock[] = [
    { type: "text", text: OAUTH_SYSTEM_PREFIX },
    ...systemBlocks,
  ];

  log.info("anthropic-oauth", "API call", {
    model,
    systemBlockCount: oauthBlocks.length,
    cachedBlocks: oauthBlocks.filter((b) => b.cache_control).length,
    messageCount: messages.length,
  });

  await _streamAnthropic(client, oauthBlocks, messages, model, onChunk, onStatus, onFinish);
}

// ---------------------------------------------------------------------------
// OpenAI Streaming API (uses native fetch — no npm dependency)
// ---------------------------------------------------------------------------

export async function streamWithOpenAIAPI(
  userMessage: string,
  apiKey: string,
  themeName: string,
  model: string,
  onChunk: (chunk: string) => void,
  onStatus?: (status: string) => void,
  onFinish?: (fullResponse: string) => void,
  fileContexts?: UploadedFileContext[],
  fetchURL?: string,
): Promise<void> {
  const conversionGuide = getConversionGuide();
  const editMode = getSession()!.modules.length > 0;
  const messages = buildMessagesWithContext(userMessage, fileContexts);
  const ctx = getPromptContext();

  // Convert multimodal messages to OpenAI format
  const openaiMessages = messages.map((m) => {
    if (typeof m.content === "string") return m;
    // Convert Anthropic-style content blocks to OpenAI format
    return {
      role: m.role,
      content: m.content.map((block) => {
        if (block.type === "text") return { type: "text" as const, text: block.text };
        return {
          type: "image_url" as const,
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        };
      }),
    };
  });

  const url = fetchURL || "https://api.openai.com/v1/chat/completions";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 48000,
      stream: true,
      messages: [
        { role: "system", content: buildVibeSystemPrompt(conversionGuide, themeName, editMode, ctx.pageType, ctx.brandAssets) },
        ...openaiMessages,
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error (${response.status}): ${err}`);
  }

  let statusIndex = 0;
  const sendStatus = onStatus || (() => {});
  sendStatus(CLI_STATUS_MESSAGES[0]);
  const heartbeat = setInterval(() => {
    statusIndex++;
    sendStatus(CLI_STATUS_MESSAGES[Math.min(statusIndex, CLI_STATUS_MESSAGES.length - 1)]);
  }, 6000);

  let fullResponse = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") break;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullResponse += delta;
            onChunk(delta);
          }
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } finally {
    clearInterval(heartbeat);
  }

  if (onFinish) onFinish(fullResponse);
}

// ---------------------------------------------------------------------------
// Gemini Streaming API (uses native fetch — no npm dependency)
// ---------------------------------------------------------------------------

export async function streamWithGeminiAPI(
  userMessage: string,
  apiKey: string,
  themeName: string,
  onChunk: (chunk: string) => void,
  onStatus?: (status: string) => void,
  onFinish?: (fullResponse: string) => void,
  fileContexts?: UploadedFileContext[],
  fetchURL?: string,
  modelOverride?: string,
): Promise<void> {
  const conversionGuide = getConversionGuide();
  const session = getSession()!;
  const editMode = session.modules.length > 0;
  const stateContext = buildStateContext();
  const ctx = getPromptContext();

  const contents: Array<{ role: string; parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> = [];

  for (const m of session.messages.slice(-20)) {
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }

  let userContent = stateContext
    ? `${userMessage}\n\n---\n${stateContext}`
    : userMessage;

  // Add document text from file contexts
  if (fileContexts?.length) {
    for (const fc of fileContexts) {
      if (fc.type === "document" && fc.extractedText) {
        userContent += `\n\n---\n[Attached document: ${fc.originalName}]\n${fc.extractedText}`;
      }
      if (fc.type === "image" && fc.usage === "asset" && fc.assetPath) {
        userContent += `\n\n[Uploaded image: ${fc.originalName} → available as get_asset_url("${fc.assetPath}")]`;
      }
    }
  }

  const userParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  // Add image parts for Gemini vision
  if (fileContexts?.length) {
    for (const fc of fileContexts) {
      if (fc.type === "image" && fc.base64) {
        userParts.push({ inlineData: { mimeType: fc.mimeType, data: fc.base64 } });
      }
    }
  }

  userParts.push({ text: userContent });
  contents.push({ role: "user", parts: userParts });

  const model = modelOverride || "gemini-2.5-flash";
  const url = fetchURL || `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buildVibeSystemPrompt(conversionGuide, themeName, editMode, ctx.pageType, ctx.brandAssets) }] },
      contents,
      generationConfig: { maxOutputTokens: 48000 },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${err}`);
  }

  let statusIndex = 0;
  const sendStatus = onStatus || (() => {});
  sendStatus(CLI_STATUS_MESSAGES[0]);
  const heartbeat = setInterval(() => {
    statusIndex++;
    sendStatus(CLI_STATUS_MESSAGES[Math.min(statusIndex, CLI_STATUS_MESSAGES.length - 1)]);
  }, 6000);

  let fullResponse = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();

        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            fullResponse += text;
            onChunk(text);
          }
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } finally {
    clearInterval(heartbeat);
  }

  if (onFinish) onFinish(fullResponse);
}

// ---------------------------------------------------------------------------
// Claude Code stream-json subprocess helper
// ---------------------------------------------------------------------------

/**
 * Event types emitted by Claude Code in `--output-format stream-json` mode.
 * We type only the fields we read; the spec has more.
 */
export interface ClaudeCodeStreamEvent {
  type: "system" | "assistant" | "user" | "result" | string;
  /** Per-event subtype (e.g. "init" for system, "success"/"error_during_execution" for result). */
  subtype?: string;
  /** Free-form session metadata on `system` init events. */
  session_id?: string;
  /** Wraps an Anthropic-style message on `assistant`/`user` events. */
  message?: {
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; name: string; input?: Record<string, unknown> }
      | { type: "tool_result"; tool_use_id?: string; content?: unknown }
      | { type: "thinking"; thinking?: string }
      | { type: string; [key: string]: unknown }
    >;
  };
  /** On `result` events: final text and usage. */
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface ClaudeCodeStreamHandlers {
  /** Called for each assistant text fragment (extracted from message.content[].text). */
  onChunk?: (chunk: string) => void;
  /** Called when the agent decides to call a tool (e.g. WebSearch, Read, Bash). */
  onToolUse?: (toolName: string, input: Record<string, unknown> | undefined) => void;
  /** Called for any unrecognised event — useful for logging during development. */
  onEvent?: (event: ClaudeCodeStreamEvent) => void;
}

/**
 * Spawn `claude --output-format stream-json --include-partial-messages
 * --verbose` and parse line-delimited JSON. Returns the full assistant text
 * concatenated across all assistant events. Tool-use events are surfaced
 * via the `onToolUse` callback; the pipeline can render them as agent
 * decisions.
 *
 * Why this exists separately from `spawnCLI`:
 *  - stream-json is Claude Code-specific (Gemini/Codex CLIs use plain text).
 *  - Lines may split across stdout chunks → we need a line buffer.
 *  - Events let us expose tool calls + final usage stats, not just raw text.
 */
export function spawnClaudeCodeStreamJSON(
  args: string[],
  prompt: string,
  handlers: ClaudeCodeStreamHandlers = {},
  timeout?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let assistantText = "";
    let stderr = "";
    let buffer = "";
    let settled = false;
    let resultEvent: ClaudeCodeStreamEvent | null = null;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const handleEvent = (event: ClaudeCodeStreamEvent) => {
      try {
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && typeof (block as { text?: string }).text === "string") {
              const text = (block as { text: string }).text;
              assistantText += text;
              if (handlers.onChunk) handlers.onChunk(text);
            } else if (block.type === "tool_use") {
              const tu = block as { name?: string; input?: Record<string, unknown> };
              if (tu.name && handlers.onToolUse) handlers.onToolUse(tu.name, tu.input);
            }
          }
        }
        if (event.type === "result") {
          resultEvent = event;
          // If the agent loop produced a `result.result` string and we never
          // saw any assistant text events (some Claude Code modes emit only
          // the final result), use it as a fallback.
          if (!assistantText && typeof event.result === "string") {
            assistantText = event.result;
            if (handlers.onChunk) handlers.onChunk(event.result);
          }
        }
        if (handlers.onEvent) handlers.onEvent(event);
      } catch {
        // One bad event must not poison the stream — keep going.
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      // Each line is one complete JSON object.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line) as ClaudeCodeStreamEvent);
        } catch {
          // A non-JSON line. Could be a banner or warning the CLI printed
          // outside the stream. Discard silently.
        }
      }
    });

    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", (err) =>
      settle(() => reject(new Error(`claude failed to start: ${err.message}`))),
    );

    child.on("close", (code) => {
      // Flush any trailing buffered line.
      if (buffer.trim()) {
        try { handleEvent(JSON.parse(buffer.trim()) as ClaudeCodeStreamEvent); } catch {}
        buffer = "";
      }
      settle(() => {
        const errored = code !== 0 || (resultEvent && resultEvent.is_error);
        if (errored) {
          reject(new Error(
            `claude exited with code ${code}.\n` +
            (stderr ? `Stderr: ${stderr.slice(0, 500)}\n` : "") +
            (assistantText ? `Output: ${assistantText.slice(0, 500)}` : "No output"),
          ));
        } else {
          resolve(assistantText);
        }
      });
    });

    child.stdin.on("error", () => {});
    const ok = child.stdin.write(prompt);
    if (!ok) child.stdin.once("drain", () => child.stdin.end());
    else child.stdin.end();

    const timeoutMs = timeout || 600_000;
    const timeoutMin = Math.round(timeoutMs / 60_000);
    const timer = setTimeout(() => {
      child.kill();
      settle(() => reject(new Error(
        `claude (stream-json) timed out after ${timeoutMin} minutes.\n` +
        (stderr ? `Stderr: ${stderr.slice(0, 500)}\n` : "") +
        `Partial output (${assistantText.length} chars): ${assistantText.slice(0, 500)}`,
      )));
    }, timeoutMs);
    child.on("close", () => clearTimeout(timer));
  });
}

// ---------------------------------------------------------------------------
// CLI subprocess helper — sends prompt via stdin to avoid shell arg limits
// ---------------------------------------------------------------------------

export function spawnCLI(
  bin: string,
  args: string[],
  prompt: string,
  onChunk?: (chunk: string) => void,
  timeout?: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      if (onChunk) onChunk(chunk);
    });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", (err) =>
      settle(() => reject(new Error(`${bin} failed to start: ${err.message}`)))
    );

    child.on("close", (code) => {
      settle(() => {
        if (code !== 0) {
          reject(new Error(
            `${bin} exited with code ${code}.\n` +
            (stderr ? `Stderr: ${stderr.slice(0, 500)}\n` : "") +
            (stdout ? `Output: ${stdout.slice(0, 500)}` : "No output")
          ));
        } else {
          resolve(stdout);
        }
      });
    });

    // Write prompt to stdin with backpressure handling for large prompts
    child.stdin.on("error", () => {});
    const ok = child.stdin.write(prompt);
    if (!ok) {
      // Buffer is full — wait for drain before ending
      child.stdin.once("drain", () => child.stdin.end());
    } else {
      child.stdin.end();
    }

    const timeoutMs = timeout || 600_000; // default 10 minutes
    const timeoutMin = Math.round(timeoutMs / 60_000);
    const timer = setTimeout(() => {
      child.kill();
      settle(() => reject(new Error(
        `${bin} timed out after ${timeoutMin} minutes.\n` +
        (stderr ? `Stderr: ${stderr.slice(0, 500)}\n` : "") +
        `Partial output (${stdout.length} chars): ${stdout.slice(0, 500)}`
      )));
    }, timeoutMs);

    // Clear timeout when process exits normally
    child.on("close", () => clearTimeout(timer));
  });
}

// ---------------------------------------------------------------------------
// Claude Code subprocess
// ---------------------------------------------------------------------------

export async function generateWithClaudeCode(
  userMessage: string,
  themeName: string,
  onChunk: (chunk: string) => void,
  onStatus?: (status: string) => void,
  onFinish?: (fullResponse: string) => void,
  fileContexts?: UploadedFileContext[]
): Promise<void> {
  const conversionGuide = getConversionGuide();
  const config = loadConfig();
  const editMode = getSession()!.modules.length > 0;
  const ctx = getPromptContext();

  let prompt = buildVibeSystemPrompt(conversionGuide, themeName, editMode, ctx.pageType, ctx.brandAssets);
  prompt += "\n\n## User Request\n" + userMessage;
  prompt += buildStateContext();
  prompt += buildFileContextText(fileContexts);
  prompt += "\n\n---\nRemember: respond with a ```vibespot-modules JSON block containing ALL modules. No text-only responses.";

  const args = ["--print"];
  if (config.claudeCodeModel) args.push("--model", config.claudeCodeModel);
  if (config.webSearch) args.push("--allowedTools=WebSearch");
  // Stream-json gives us structured events we can surface as live status
  // (tool calls). --include-partial-messages preserves the live token-typing
  // UX; --verbose is required to actually emit events.
  args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");

  let statusIndex = 0;
  const sendStatus = onStatus || (() => {});
  sendStatus(CLI_STATUS_MESSAGES[0]);

  // Heartbeat is now a fallback — once a real tool-use status arrives it
  // overrides the rotating placeholder messages.
  const heartbeat = setInterval(() => {
    statusIndex++;
    const msg = CLI_STATUS_MESSAGES[Math.min(statusIndex, CLI_STATUS_MESSAGES.length - 1)];
    sendStatus(msg);
  }, 6000);

  try {
    const result = await spawnClaudeCodeStreamJSON(args, prompt, {
      onChunk: (chunk) => onChunk(chunk),
      onToolUse: (toolName, input) => {
        // Render tool calls as live status. This replaces the generic
        // rotating placeholders with concrete agent activity.
        sendStatus(summarizeClaudeCodeToolUse(toolName, input));
      },
    });
    if (onFinish) onFinish(result);
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Short human-readable status line for a Claude Code tool-use event.
 * Mirrors the helper in engine-adapter.ts so single-call mode and the
 * agentic CLI path produce the same status copy.
 */
function summarizeClaudeCodeToolUse(name: string, input: Record<string, unknown> | undefined): string {
  const i = input || {};
  switch (name) {
    case "WebSearch":
    case "web_search":
      return `Searching: "${String(i.query || "")}"`;
    case "WebFetch":
      return `Fetching: ${String(i.url || "")}`;
    case "Read":
      return `Reading ${String(i.file_path || i.path || "file")}`;
    case "Edit":
    case "Write":
      return `Editing ${String(i.file_path || i.path || "file")}`;
    case "Bash":
      return `Running: ${String(i.command || "").slice(0, 60)}`;
    case "Grep":
      return `Searching for "${String(i.pattern || "")}"`;
    case "Glob":
      return `Globbing ${String(i.pattern || "")}`;
    default:
      return `Using ${name}`;
  }
}

// ---------------------------------------------------------------------------
// Generic CLI subprocess (Gemini CLI, Codex CLI)
// ---------------------------------------------------------------------------

export async function generateWithCLI(
  cli: "gemini" | "codex",
  userMessage: string,
  themeName: string,
  onChunk: (chunk: string) => void,
  onStatus?: (status: string) => void,
  onFinish?: (fullResponse: string) => void,
  fileContexts?: UploadedFileContext[]
): Promise<void> {
  const conversionGuide = getConversionGuide();
  const editMode = getSession()!.modules.length > 0;
  const ctx = getPromptContext();

  let prompt = buildVibeSystemPrompt(conversionGuide, themeName, editMode, ctx.pageType, ctx.brandAssets);
  prompt += "\n\n## User Request\n" + userMessage;
  prompt += buildStateContext();
  prompt += buildFileContextText(fileContexts);
  prompt += "\n\n---\nRemember: respond with a ```vibespot-modules JSON block containing ALL modules. No text-only responses.";

  let bin: string;
  let args: string[];
  if (cli === "gemini") {
    bin = "gemini";
    args = [];
  } else {
    bin = "codex";
    args = ["exec", "--full-auto"];
  }

  let statusIndex = 0;
  const sendStatus = onStatus || (() => {});
  sendStatus(CLI_STATUS_MESSAGES[0]);

  const heartbeat = setInterval(() => {
    statusIndex++;
    const msg = CLI_STATUS_MESSAGES[Math.min(statusIndex, CLI_STATUS_MESSAGES.length - 1)];
    sendStatus(msg);
  }, 6000);

  try {
    const result = await spawnCLI(bin, args, prompt, (chunk) => {
      onChunk(chunk);
    });
    if (onFinish) onFinish(result);
  } finally {
    clearInterval(heartbeat);
  }
}
