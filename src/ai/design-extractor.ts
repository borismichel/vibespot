/**
 * AI-powered design extraction — analyzes a theme's CSS/HTML/fields
 * and generates a structured design system document (styleguide).
 *
 * Supports all configured AI engines: Anthropic API, OpenAI API, Gemini API,
 * Claude Code CLI, Gemini CLI, Codex CLI.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { resolveAsset, readFile } from "../utils/fs.js";
import { loadConfig, getApiKeyForEngine, type AIEngineType } from "../utils/config.js";
import { reportModelUsage } from "../server/langfuse.js";
import {
  mapAnthropicUsage,
  mapOpenAIUsage,
  mapGeminiUsage,
  type TokenUsage,
} from "../server/pricing.js";

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
// Theme file collection
// ---------------------------------------------------------------------------

const MAX_CONTENT_CHARS = 80_000;

function safeRead(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

/**
 * Collect CSS, HTML, and fields.json from a theme directory.
 * Prioritizes CSS (most design-relevant), then HTML, then fields.
 */
export function collectThemeFiles(themePath: string): string {
  const parts: string[] = [];
  let totalChars = 0;

  function addSection(label: string, content: string): boolean {
    if (!content.trim()) return true;
    const section = `\n### ${label}\n\`\`\`\n${content}\n\`\`\`\n`;
    if (totalChars + section.length > MAX_CONTENT_CHARS) return false;
    parts.push(section);
    totalChars += section.length;
    return true;
  }

  // Theme metadata
  const themeJson = safeRead(join(themePath, "theme.json"));
  if (themeJson) addSection("theme.json", themeJson);

  // Shared CSS files (highest priority for design tokens)
  const cssDir = join(themePath, "css");
  if (existsSync(cssDir)) {
    for (const f of readdirSync(cssDir).filter((f) => f.endsWith(".css"))) {
      if (!addSection(`css/${f}`, safeRead(join(cssDir, f)))) break;
    }
  }

  // Module CSS files
  const modulesDir = join(themePath, "modules");
  if (existsSync(modulesDir)) {
    for (const dir of readdirSync(modulesDir).filter((d) => d.endsWith(".module"))) {
      const modPath = join(modulesDir, dir);
      const css = safeRead(join(modPath, "module.css"));
      if (css && !addSection(`modules/${dir}/module.css`, css)) break;
    }
  }

  // Module HTML templates (for component patterns)
  if (existsSync(modulesDir)) {
    for (const dir of readdirSync(modulesDir).filter((d) => d.endsWith(".module"))) {
      const modPath = join(modulesDir, dir);
      const html = safeRead(join(modPath, "module.html"));
      if (html && !addSection(`modules/${dir}/module.html`, html)) break;
    }
  }

  // Module fields.json (for content structure)
  if (existsSync(modulesDir)) {
    for (const dir of readdirSync(modulesDir).filter((d) => d.endsWith(".module"))) {
      const modPath = join(modulesDir, dir);
      const fields = safeRead(join(modPath, "fields.json"));
      if (fields && !addSection(`modules/${dir}/fields.json`, fields)) break;
    }
  }

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

let _extractionPrompt = "";
function getExtractionPrompt(): string {
  if (!_extractionPrompt) {
    try { _extractionPrompt = readFile(resolveAsset("extraction-prompt.md")); } catch { _extractionPrompt = ""; }
  }
  return _extractionPrompt;
}

// ---------------------------------------------------------------------------
// CLI subprocess helper
// ---------------------------------------------------------------------------

function spawnCLIForExtraction(bin: string, args: string[], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE; // prevent recursion if running inside Claude Code

    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", (err) =>
      reject(new Error(`${bin} failed to start: ${err.message}`))
    );

    child.on("close", (code) => {
      if (code === 0 || stdout.trim()) resolve(stdout.trim());
      else reject(new Error(`${bin} exited with code ${code}: ${stderr.trim()}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

export interface ExtractionProgress {
  status: string;
}

/**
 * Extract a design system document from a theme directory using AI.
 * Uses the currently configured AI engine.
 * Returns a markdown string suitable for saving as a styleguide.
 */
export async function extractDesignContext(
  themePath: string,
  onProgress?: (p: ExtractionProgress) => void,
): Promise<string> {
  onProgress?.({ status: "Collecting theme files..." });
  const themeContent = collectThemeFiles(themePath);
  if (!themeContent.trim()) {
    throw new Error("No CSS, HTML, or fields.json files found in theme.");
  }

  const systemPrompt = getExtractionPrompt();
  if (!systemPrompt) {
    throw new Error("Extraction prompt not found (assets/extraction-prompt.md).");
  }

  const userMessage = `Analyze this HubSpot CMS theme and extract the design system:\n${themeContent}`;

  onProgress?.({ status: "Analyzing design patterns..." });

  const config = loadConfig();
  const engine = (config.aiEngine || "anthropic-api") as AIEngineType;
  let text = "";
  // Usage instrumentation — captured per API path, reported after the switch.
  // CLI engines report no usage (same as the agentic adapter).
  const startTime = new Date();
  let usage: TokenUsage | undefined;
  let usedModel = "";

  switch (engine) {
    // ----- API engines -----
    case "anthropic-api":
    case "api": {
      const apiKey = getApiKeyForEngine("anthropic-api");
      if (!apiKey) throw new Error("Anthropic API key not configured. Open Settings to add one.");

      const AnthropicSDK = await getAnthropicSDK();
      const client = new AnthropicSDK({ apiKey });
      usedModel = config.anthropicApiModel || "claude-sonnet-4-6";
      const response = await client.messages.create({
        model: usedModel,
        max_tokens: 8000,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userMessage }],
      });
      text = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      usage = mapAnthropicUsage(response.usage);
      break;
    }

    case "claude-oauth": {
      const { getValidAccessToken, OAUTH_EXTRA_HEADERS, OAUTH_SYSTEM_PREFIX } = await import("../utils/claude-oauth.js");
      const accessToken = await getValidAccessToken();
      if (!accessToken) throw new Error("Claude OAuth session expired. Please re-authenticate in Settings.");

      const AnthropicSDK = await getAnthropicSDK();
      const client = new AnthropicSDK({ authToken: accessToken, defaultHeaders: OAUTH_EXTRA_HEADERS } as any);
      usedModel = config.anthropicApiModel || "claude-sonnet-4-6";
      const response = await client.messages.create({
        model: usedModel,
        max_tokens: 8000,
        system: [
          { type: "text", text: OAUTH_SYSTEM_PREFIX },
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ] as any,
        messages: [{ role: "user", content: userMessage }],
      });
      text = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      usage = mapAnthropicUsage(response.usage);
      break;
    }

    case "openai-api": {
      const apiKey = getApiKeyForEngine("openai-api");
      if (!apiKey) throw new Error("OpenAI API key not configured. Open Settings to add one.");

      usedModel = config.openaiApiModel || "gpt-4o";
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: usedModel,
          max_tokens: 8000,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        }),
      });
      if (!resp.ok) throw new Error(`OpenAI API error: ${resp.status} ${await resp.text()}`);
      const data = await resp.json() as { choices: { message: { content: string } }[]; usage?: Parameters<typeof mapOpenAIUsage>[0] };
      text = data.choices?.[0]?.message?.content || "";
      usage = mapOpenAIUsage(data.usage);
      break;
    }

    case "gemini-api": {
      const apiKey = getApiKeyForEngine("gemini-api");
      if (!apiKey) throw new Error("Gemini API key not configured. Open Settings to add one.");

      usedModel = config.geminiApiModel || "gemini-2.5-flash";
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${usedModel}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: userMessage }] }],
            generationConfig: { maxOutputTokens: 8000 },
          }),
        },
      );
      if (!resp.ok) throw new Error(`Gemini API error: ${resp.status} ${await resp.text()}`);
      const data = await resp.json() as { candidates: { content: { parts: { text: string }[] } }[]; usageMetadata?: Parameters<typeof mapGeminiUsage>[0] };
      text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      usage = mapGeminiUsage(data.usageMetadata);
      break;
    }

    // ----- CLI engines -----
    case "claude-code": {
      const combinedPrompt = `${systemPrompt}\n\n## User Request\n${userMessage}`;
      const args = ["--print"];
      if (config.claudeCodeModel) args.push("--model", config.claudeCodeModel);
      text = await spawnCLIForExtraction("claude", args, combinedPrompt);
      break;
    }

    case "gemini-cli": {
      const combinedPrompt = `${systemPrompt}\n\n## User Request\n${userMessage}`;
      text = await spawnCLIForExtraction("gemini", [], combinedPrompt);
      break;
    }

    case "codex-cli": {
      const combinedPrompt = `${systemPrompt}\n\n## User Request\n${userMessage}`;
      text = await spawnCLIForExtraction("codex", [], combinedPrompt);
      break;
    }

    default:
      throw new Error(`Unknown AI engine: ${engine}. Open Settings to configure one.`);
  }

  if (!text.trim()) {
    throw new Error("AI returned empty response.");
  }

  // Instrument API engines (usage was captured above). CLI engines (claude-code,
  // gemini-cli, codex-cli) report no usage, matching the agentic adapter.
  if (usedModel) {
    reportModelUsage({
      engine,
      model: usedModel,
      name: "styleguide-extraction",
      input: { system: systemPrompt, messages: [{ role: "user", content: userMessage }] },
      output: text,
      usage,
      startTime,
      endTime: new Date(),
    });
  }

  onProgress?.({ status: "Design extraction complete." });
  return text;
}
