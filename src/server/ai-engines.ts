/**
 * AI engine implementations — streaming handlers for each supported engine.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { getConversionGuide } from "../ai/prompts.js";
import { loadConfig } from "../utils/config.js";
import { getSession } from "./session.js";
import { buildVibeSystemPrompt, buildStateContext, buildMessagesWithContext, getPromptContext, type MultimodalMessage } from "./ai-prompts.js";
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
// Anthropic Streaming API
// ---------------------------------------------------------------------------

const RATE_LIMIT_DELAYS = [10, 20, 40, 60, 120]; // seconds

export async function streamWithAnthropicAPI(
  userMessage: string,
  apiKey: string,
  themeName: string,
  model: string,
  onChunk: (chunk: string) => void,
  onStatus?: (status: string) => void,
  onFinish?: (fullResponse: string) => void,
  fileContexts?: UploadedFileContext[]
): Promise<void> {
  const AnthropicSDK = await getAnthropicSDK();
  const client = new AnthropicSDK({ apiKey });
  const conversionGuide = getConversionGuide();
  const session = getSession()!;
  const editMode = session.modules.length > 0;
  const messages = buildMessagesWithContext(userMessage, fileContexts);
  const ctx = getPromptContext();
  const systemPrompt = buildVibeSystemPrompt(conversionGuide, themeName, editMode, ctx.pageType, ctx.brandAssets);

  log.info("anthropic", "API call", {
    model,
    systemPromptLength: systemPrompt.length,
    messageCount: messages.length,
    messageRoles: messages.map((m) => m.role),
    lastMessageLength: typeof messages[messages.length - 1]?.content === "string"
      ? (messages[messages.length - 1].content as string).length
      : "multimodal",
    conversionGuideLength: conversionGuide.length,
  });

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
          system: systemPrompt,
          messages: messages as unknown as import("@anthropic-ai/sdk").MessageParam[],
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
  fileContexts?: UploadedFileContext[]
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

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
    throw new Error(`OpenAI API error (${response.status}): ${err}`);
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
  fileContexts?: UploadedFileContext[]
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

  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

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
// CLI subprocess helper — sends prompt via stdin to avoid shell arg limits
// ---------------------------------------------------------------------------

export function spawnCLI(
  bin: string,
  args: string[],
  prompt: string,
  onChunk?: (chunk: string) => void
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

    const timer = setTimeout(() => {
      child.kill();
      settle(() => reject(new Error(
        `${bin} timed out after 5 minutes.\n` +
        (stderr ? `Stderr: ${stderr.slice(0, 500)}\n` : "") +
        `Partial output (${stdout.length} chars): ${stdout.slice(0, 500)}`
      )));
    }, 300_000);

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

  let statusIndex = 0;
  const sendStatus = onStatus || (() => {});
  sendStatus(CLI_STATUS_MESSAGES[0]);

  const heartbeat = setInterval(() => {
    statusIndex++;
    const msg = CLI_STATUS_MESSAGES[Math.min(statusIndex, CLI_STATUS_MESSAGES.length - 1)];
    sendStatus(msg);
  }, 6000);

  try {
    const result = await spawnCLI("claude", args, prompt, (chunk) => {
      onChunk(chunk);
    });
    if (onFinish) onFinish(result);
  } finally {
    clearInterval(heartbeat);
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
