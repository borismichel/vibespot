/**
 * AI engine implementations — streaming handlers for each supported engine.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { getConversionGuide } from "../ai/prompts.js";
import { loadConfig } from "../utils/config.js";
import { getSession } from "./session.js";
import { buildVibeSystemPrompt, buildStateContext, buildMessagesWithContext, getPromptContext } from "./ai-prompts.js";
import { log } from "./log.js";

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
  onFinish?: (fullResponse: string) => void
): Promise<void> {
  const AnthropicSDK = await getAnthropicSDK();
  const client = new AnthropicSDK({ apiKey });
  const conversionGuide = getConversionGuide();
  const session = getSession()!;
  const editMode = session.modules.length > 0;
  const messages = buildMessagesWithContext(userMessage);
  const ctx = getPromptContext();
  const systemPrompt = buildVibeSystemPrompt(conversionGuide, themeName, editMode, ctx.pageType, ctx.brandAssets);

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
          messages,
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
  onFinish?: (fullResponse: string) => void
): Promise<void> {
  const conversionGuide = getConversionGuide();
  const editMode = getSession()!.modules.length > 0;
  const messages = buildMessagesWithContext(userMessage);
  const ctx = getPromptContext();

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
        ...messages,
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
  onFinish?: (fullResponse: string) => void
): Promise<void> {
  const conversionGuide = getConversionGuide();
  const session = getSession()!;
  const editMode = session.modules.length > 0;
  const stateContext = buildStateContext();
  const ctx = getPromptContext();

  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  for (const m of session.messages.slice(-20)) {
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }

  const userContent = stateContext
    ? `${userMessage}\n\n---\n${stateContext}`
    : userMessage;
  contents.push({ role: "user", parts: [{ text: userContent }] });

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

function spawnCLI(
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
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      if (onChunk) onChunk(chunk);
    });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", (err) =>
      reject(new Error(`${bin} failed to start: ${err.message}`))
    );

    child.on("close", (code) => {
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

    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();

    setTimeout(() => {
      child.kill();
      reject(new Error(`${bin} timed out after 10 minutes`));
    }, 600_000);
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
  onFinish?: (fullResponse: string) => void
): Promise<void> {
  const conversionGuide = getConversionGuide();
  const config = loadConfig();
  const editMode = getSession()!.modules.length > 0;
  const ctx = getPromptContext();

  let prompt = buildVibeSystemPrompt(conversionGuide, themeName, editMode, ctx.pageType, ctx.brandAssets);
  prompt += "\n\n## User Request\n" + userMessage;
  prompt += buildStateContext();

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
  onFinish?: (fullResponse: string) => void
): Promise<void> {
  const conversionGuide = getConversionGuide();
  const editMode = getSession()!.modules.length > 0;
  const ctx = getPromptContext();

  let prompt = buildVibeSystemPrompt(conversionGuide, themeName, editMode, ctx.pageType, ctx.brandAssets);
  prompt += "\n\n## User Request\n" + userMessage;
  prompt += buildStateContext();

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
