/**
 * AI handler for vibe coding mode.
 * Supports multiple AI engines: Anthropic API, OpenAI API, Gemini API,
 * Claude Code, Gemini CLI, and Codex CLI.
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawn, execSync } from "node:child_process";
import { getConversionGuide, getDesignGuide, getContentGuide } from "../ai/prompts.js";
import { loadConfig, getApiKeyForEngine, type AIEngineType } from "../utils/config.js";
import {
  getSession,
  addMessage,
  updateModules,
  saveSession,
  type ChatMessage,
} from "./session.js";
import type { ModuleFiles } from "../ai/engine.js";

// ---------------------------------------------------------------------------
// System prompt for vibe coding mode
// ---------------------------------------------------------------------------

function buildVibeSystemPrompt(conversionGuide: string, themeName: string): string {
  return `You are vibeSpot, an AI that builds HubSpot CMS landing pages from natural language descriptions.

## Your Role
You generate native HubSpot CMS modules directly from user descriptions. Every module you create is immediately compatible with HubSpot's drag-and-drop page editor.

## Output Format
For each module you create or modify, include a JSON code block with this structure:

\`\`\`vibespot-modules
{
  "modules": [
    {
      "moduleName": "Hero",
      "fieldsJson": "...",
      "metaJson": "...",
      "moduleHtml": "...",
      "moduleCss": "...",
      "moduleJs": null
    }
  ],
  "sharedCss": "...",
  "sharedJs": "..."
}
\`\`\`

## Rules
- fieldsJson, metaJson must be valid JSON strings
- moduleHtml uses HubL template syntax ({{ module.field_name }})
- moduleCss is vanilla CSS (no Tailwind, no Sass)
- moduleJs is optional vanilla JS (wrapped in IIFE)
- Use "type": "text" (NEVER "textarea" — it's deprecated)
- NEVER use "name": "name" (reserved) — use "item_name" instead
- Wrap style fields in a "styles" group with "tab": "STYLE"
- All CSS classes must use a unique prefix "${themeName}-" to avoid theme conflicts
- Use BEM naming: ${themeName}-module__element--modifier
- metaJson must include: host_template_types: ["PAGE"], is_available_for_new_content: true
- For repeater groups, use "occurrence": { "min": 0, "max": 100 } and iterate with {% for %}
- Color fields: type "color", default { "color": "#hex", "opacity": 100 }
- Link fields: type "link", default { "url": { "href": "#", "type": "EXTERNAL" }, "open_in_new_tab": false, "no_follow": false }
- Image fields: type "image", default { "src": "", "alt": "" }

## When modifying existing modules
When the user asks to change something, include ONLY the modules that changed. Keep module names consistent.
If the change affects shared CSS or JS, include those too.

## Design Quality
- Use modern, clean design with proper spacing and typography
- Include responsive CSS (mobile breakpoint at 767px)
- Add scroll animation classes where appropriate
- Use CSS custom properties for the design system
- Make content editable through fields.json (headlines, text, colors, images, links)

## Design Guide
${getDesignGuide()}

## Content & Copywriting Guide
${getContentGuide()}

## Conversion Guide Reference
${conversionGuide}`;
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

  const config = loadConfig();
  const engine = config.aiEngine || detectDefaultEngine();

  switch (engine) {
    case "anthropic-api":
    case "api": {
      const apiKey = getApiKeyForEngine("anthropic-api", config);
      if (!apiKey) throw new Error("Anthropic API key not configured. Open Settings to add one.");
      await streamWithAnthropicAPI(userMessage, apiKey, session.themeName,
        config.anthropicApiModel || "claude-sonnet-4-20250514", onChunk);
      break;
    }
    case "openai-api": {
      const apiKey = getApiKeyForEngine("openai-api", config);
      if (!apiKey) throw new Error("OpenAI API key not configured. Open Settings to add one.");
      await streamWithOpenAIAPI(userMessage, apiKey, session.themeName,
        config.openaiApiModel || "gpt-4o", onChunk);
      break;
    }
    case "gemini-api": {
      const apiKey = getApiKeyForEngine("gemini-api", config);
      if (!apiKey) throw new Error("Gemini API key not configured. Open Settings to add one.");
      await streamWithGeminiAPI(userMessage, apiKey, session.themeName, onChunk);
      break;
    }
    case "claude-code":
      await generateWithClaudeCode(userMessage, session.themeName, onChunk, onStatus);
      break;
    case "gemini-cli":
      await generateWithCLI("gemini", userMessage, session.themeName, onChunk, onStatus);
      break;
    case "codex-cli":
      await generateWithCLI("codex", userMessage, session.themeName, onChunk, onStatus);
      break;
    default:
      throw new Error(`Unknown AI engine: ${engine}. Open Settings to configure one.`);
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
// Shared helpers
// ---------------------------------------------------------------------------

function buildStateContext(): string {
  const session = getSession()!;
  let stateContext = "";
  if (session.modules.length > 0) {
    stateContext = "\n\n## Current Module State\n";
    for (const mod of session.modules) {
      stateContext += `\n### ${mod.moduleName}.module\n`;
      stateContext += `**fields.json:**\n\`\`\`json\n${mod.fieldsJson}\n\`\`\`\n`;
      stateContext += `**module.html:**\n\`\`\`html\n${mod.moduleHtml}\n\`\`\`\n`;
      stateContext += `**module.css:**\n\`\`\`css\n${mod.moduleCss}\n\`\`\`\n`;
      if (mod.moduleJs) {
        stateContext += `**module.js:**\n\`\`\`js\n${mod.moduleJs}\n\`\`\`\n`;
      }
    }
    if (session.sharedCss) {
      stateContext += `\n### Shared CSS\n\`\`\`css\n${session.sharedCss}\n\`\`\`\n`;
    }
    if (session.sharedJs) {
      stateContext += `\n### Shared JS\n\`\`\`js\n${session.sharedJs}\n\`\`\`\n`;
    }
  }
  return stateContext;
}

function buildMessagesWithContext(userMessage: string): Array<{ role: "user" | "assistant"; content: string }> {
  const session = getSession()!;
  const messages: Array<{ role: "user" | "assistant"; content: string }> =
    session.messages.slice(-20).map((m) => ({
      role: m.role,
      content: m.content,
    }));

  const stateContext = buildStateContext();
  const userContent = stateContext
    ? `${userMessage}\n\n---\n${stateContext}`
    : userMessage;

  messages.push({ role: "user", content: userContent });
  return messages;
}

function finishResponse(fullResponse: string): void {
  addMessage("assistant", fullResponse);
  parseAndApplyModules(fullResponse);
  saveSession();
}

// ---------------------------------------------------------------------------
// Anthropic Streaming API
// ---------------------------------------------------------------------------

async function streamWithAnthropicAPI(
  userMessage: string,
  apiKey: string,
  themeName: string,
  model: string,
  onChunk: (chunk: string) => void
): Promise<void> {
  const client = new Anthropic({ apiKey });
  const conversionGuide = getConversionGuide();
  const messages = buildMessagesWithContext(userMessage);

  let fullResponse = "";

  const stream = client.messages.stream({
    model,
    max_tokens: 16384,
    system: buildVibeSystemPrompt(conversionGuide, themeName),
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

  finishResponse(fullResponse);
}

// ---------------------------------------------------------------------------
// OpenAI Streaming API (uses native fetch — no npm dependency)
// ---------------------------------------------------------------------------

async function streamWithOpenAIAPI(
  userMessage: string,
  apiKey: string,
  themeName: string,
  model: string,
  onChunk: (chunk: string) => void
): Promise<void> {
  const conversionGuide = getConversionGuide();
  const messages = buildMessagesWithContext(userMessage);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
      stream: true,
      messages: [
        { role: "system", content: buildVibeSystemPrompt(conversionGuide, themeName) },
        ...messages,
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${err}`);
  }

  let fullResponse = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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

  finishResponse(fullResponse);
}

// ---------------------------------------------------------------------------
// Gemini Streaming API (uses native fetch — no npm dependency)
// ---------------------------------------------------------------------------

async function streamWithGeminiAPI(
  userMessage: string,
  apiKey: string,
  themeName: string,
  onChunk: (chunk: string) => void
): Promise<void> {
  const conversionGuide = getConversionGuide();
  const session = getSession()!;
  const stateContext = buildStateContext();

  // Build conversation for Gemini format
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  // Add system instruction as first user message (Gemini uses systemInstruction separately)
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

  const model = "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buildVibeSystemPrompt(conversionGuide, themeName) }] },
      contents,
      generationConfig: { maxOutputTokens: 16384 },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${err}`);
  }

  let fullResponse = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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

  finishResponse(fullResponse);
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
    delete env.CLAUDECODE; // allow nesting when running inside Claude Code

    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
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

    // Send prompt via stdin to avoid shell argument length limits
    child.stdin.on("error", () => {}); // handle EPIPE if child exits early
    child.stdin.write(prompt);
    child.stdin.end();

    // 10 min timeout (complex pages need time)
    setTimeout(() => {
      child.kill();
      reject(new Error(`${bin} timed out after 10 minutes`));
    }, 600_000);
  });
}

// ---------------------------------------------------------------------------
// CLI status messages (shown while waiting for buffered CLI output)
// ---------------------------------------------------------------------------

const CLI_STATUS_MESSAGES = [
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
// Claude Code subprocess
// ---------------------------------------------------------------------------

async function generateWithClaudeCode(
  userMessage: string,
  themeName: string,
  onChunk: (chunk: string) => void,
  onStatus?: (status: string) => void
): Promise<void> {
  const conversionGuide = getConversionGuide();
  const config = loadConfig();

  let prompt = buildVibeSystemPrompt(conversionGuide, themeName);
  prompt += "\n\n## User Request\n" + userMessage;
  prompt += buildStateContext();

  const args = ["--print"];
  if (config.claudeCodeModel) args.push("--model", config.claudeCodeModel);

  // Claude --print buffers output until completion, so send periodic
  // status updates so the user knows what's happening
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
    finishResponse(result);
  } finally {
    clearInterval(heartbeat);
  }
}

// ---------------------------------------------------------------------------
// Generic CLI subprocess (Gemini CLI, Codex CLI)
// ---------------------------------------------------------------------------

async function generateWithCLI(
  cli: "gemini" | "codex",
  userMessage: string,
  themeName: string,
  onChunk: (chunk: string) => void,
  onStatus?: (status: string) => void
): Promise<void> {
  const conversionGuide = getConversionGuide();

  let prompt = buildVibeSystemPrompt(conversionGuide, themeName);
  prompt += "\n\n## User Request\n" + userMessage;
  prompt += buildStateContext();

  let bin: string;
  let args: string[];
  if (cli === "gemini") {
    bin = "gemini";
    args = [];
  } else {
    bin = "codex";
    args = ["--quiet", "--full-auto"];
  }

  // CLI may buffer output — send status updates so user knows what's happening
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
    finishResponse(result);
  } finally {
    clearInterval(heartbeat);
  }
}

// ---------------------------------------------------------------------------
// Module parsing
// ---------------------------------------------------------------------------

/**
 * Parse vibespot-modules JSON blocks from an AI response and update the session.
 */
function parseAndApplyModules(response: string): void {
  // Look for ```vibespot-modules ... ``` blocks
  const blockPattern = /```vibespot-modules\s*\n([\s\S]*?)```/g;
  let match;

  while ((match = blockPattern.exec(response)) !== null) {
    try {
      const data = JSON.parse(match[1]);

      if (data.modules && Array.isArray(data.modules)) {
        const modules: ModuleFiles[] = data.modules.map((m: Record<string, unknown>) => ({
          moduleName: String(m.moduleName || ""),
          fieldsJson: typeof m.fieldsJson === "string"
            ? m.fieldsJson
            : JSON.stringify(m.fieldsJson, null, 2),
          metaJson: typeof m.metaJson === "string"
            ? m.metaJson
            : JSON.stringify(m.metaJson, null, 2),
          moduleHtml: String(m.moduleHtml || ""),
          moduleCss: String(m.moduleCss || ""),
          moduleJs: m.moduleJs ? String(m.moduleJs) : undefined,
        }));

        updateModules({
          modules,
          sharedCss: data.sharedCss !== undefined ? String(data.sharedCss) : undefined,
          sharedJs: data.sharedJs !== undefined ? String(data.sharedJs) : undefined,
        });
      }
    } catch {
      // Invalid JSON in block — skip
    }
  }

  // Also try to find standalone JSON that looks like module data
  // (in case the AI doesn't use the exact code fence format)
  if (!blockPattern.test(response)) {
    const jsonPattern = /```(?:json)?\s*\n(\{[\s\S]*?"modules"\s*:\s*\[[\s\S]*?\})\s*```/g;
    while ((match = jsonPattern.exec(response)) !== null) {
      try {
        const data = JSON.parse(match[1]);
        if (data.modules && Array.isArray(data.modules)) {
          const modules: ModuleFiles[] = data.modules.map((m: Record<string, unknown>) => ({
            moduleName: String(m.moduleName || ""),
            fieldsJson: typeof m.fieldsJson === "string"
              ? m.fieldsJson
              : JSON.stringify(m.fieldsJson, null, 2),
            metaJson: typeof m.metaJson === "string"
              ? m.metaJson
              : JSON.stringify(m.metaJson, null, 2),
            moduleHtml: String(m.moduleHtml || ""),
            moduleCss: String(m.moduleCss || ""),
            moduleJs: m.moduleJs ? String(m.moduleJs) : undefined,
          }));

          updateModules({
            modules,
            sharedCss: data.sharedCss !== undefined ? String(data.sharedCss) : undefined,
            sharedJs: data.sharedJs !== undefined ? String(data.sharedJs) : undefined,
          });
        }
      } catch {
        // Not valid module JSON — skip
      }
    }
  }
}
