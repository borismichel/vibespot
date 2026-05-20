/**
 * Engine adapter for agentic pipeline — structured output via each provider's
 * native mechanism (Anthropic tool_use, OpenAI json_schema, Gemini responseSchema)
 * for API engines, or prompt-based JSON extraction for CLI engines.
 *
 * This is a lower-level API than the streaming functions in ai-engines.ts.
 * It accepts custom system prompts and structured output schemas, returning
 * parsed JSON or raw text.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { spawnCLI, spawnClaudeCodeStreamJSON } from "../ai-engines.js";
import { tryParseJSON, tryRepairTruncatedJSON } from "../ai-parser.js";
import { loadConfig } from "../../utils/config.js";
import { OAUTH_EXTRA_HEADERS, OAUTH_SYSTEM_PREFIX } from "../../utils/claude-oauth.js";
import { log } from "../log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MultimodalContent {
  type: "text";
  text: string;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string | MultimodalContent[];
}

export interface StructuredOutputSpec {
  /** JSON Schema for the expected output */
  schema: Record<string, unknown>;
  /** Name for the schema / tool (used by Anthropic tool_use, OpenAI json_schema) */
  name: string;
}

/** System prompt block with optional cache control (for Anthropic prompt caching). */
export interface SystemPromptBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface AgentCallOptions {
  systemPrompt: string;
  /** When provided, used instead of systemPrompt for Anthropic engines (enables prompt caching). */
  systemBlocks?: SystemPromptBlock[];
  messages: AgentMessage[];
  structuredOutput?: StructuredOutputSpec;
  maxTokens?: number;
  onChunk?: (chunk: string) => void;
  onStatus?: (status: string) => void;
  /**
   * Extended thinking budget in tokens (Anthropic only). When set and the model
   * supports it, the SDK enables `thinking: { type: "enabled", budget_tokens }`.
   * Stages opt in (e.g. Page Architect) — not every call benefits.
   */
  thinkingBudgetTokens?: number;
  /**
   * Allow the model to use the web-search tool. Honored on:
   *  - Anthropic API engines: appends `web_search_20250305` to `tools` (only
   *    when `structuredOutput` is NOT set — structured output forces a single
   *    tool, which would prevent the model from searching anyway).
   *  - Claude Code CLI: passes `--allowedTools=WebSearch` so the agent's
   *    internal allowlist permits it.
   * Other engines silently ignore.
   */
  enableWebSearch?: boolean;
}

export type AgentCallResult =
  | { type: "structured"; data: unknown }
  | { type: "text"; text: string };

export type AgentEngine =
  | "anthropic-api"
  | "claude-oauth"
  | "openai-api"
  | "gemini-api"
  | "langdock-api"
  | "claude-code"
  | "gemini-cli"
  | "codex-cli";

/**
 * Langdock — EU-hosted (Frankfurt) AI gateway with a GDPR-native DPA covering
 * OpenAI, Anthropic, Mistral, and Google models behind a single contract.
 * Each provider has its own API-compatible endpoint. Override `langdockBaseUrl`
 * in config for self-hosted / private-cloud installs.
 */
export const LANGDOCK_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.langdock.com/anthropic",
  openai: "https://api.langdock.com/openai",
  google: "https://api.langdock.com/google",
  mistral: "https://api.langdock.com/mistral",
};
const LANGDOCK_DEFAULT_BASE_URL = LANGDOCK_BASE_URLS.anthropic;

// ---------------------------------------------------------------------------
// Rate limit retry delays (shared with ai-engines.ts pattern)
// ---------------------------------------------------------------------------

const RATE_LIMIT_DELAYS = [10, 20, 40, 60, 120]; // seconds

async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  onStatus?: (status: string) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const errType = (err as { error?: { type?: string } }).error?.type;
      const is429 =
        status === 429 ||
        errType === "rate_limit_error" ||
        (err instanceof Error && err.message.includes("429"));

      if (!is429 || attempt >= RATE_LIMIT_DELAYS.length) throw err;

      const wait = RATE_LIMIT_DELAYS[attempt];
      log.warn(
        "agent-adapter",
        `Rate limited (429), attempt ${attempt + 1}/${RATE_LIMIT_DELAYS.length} — waiting ${wait}s`,
      );
      if (onStatus) onStatus(`Rate limited — retrying in ${wait}s...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      if (onStatus) onStatus("Retrying...");
    }
  }
}

// ---------------------------------------------------------------------------
// Post-processing: ensure fieldsJson / metaJson are strings, not objects
// ---------------------------------------------------------------------------

function stringifyJsonFields(data: unknown): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    for (const key of ["fieldsJson", "metaJson"]) {
      if (obj[key] && typeof obj[key] === "object") {
        obj[key] = JSON.stringify(obj[key]);
      }
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Anthropic Adapter — structured output via tool_use
// ---------------------------------------------------------------------------

let _AnthropicCtor: typeof import("@anthropic-ai/sdk").default | null = null;
async function getAnthropicSDK(): Promise<
  typeof import("@anthropic-ai/sdk").default
> {
  if (!_AnthropicCtor) {
    const mod = await import("@anthropic-ai/sdk");
    _AnthropicCtor = mod.default;
  }
  return _AnthropicCtor;
}

async function callAnthropic(
  apiKey: string,
  model: string,
  opts: AgentCallOptions,
  extraHeaders?: Record<string, string>,
  systemPrefix?: string,
  baseURL?: string,
): Promise<AgentCallResult> {
  const AnthropicSDK = await getAnthropicSDK();
  const client = new AnthropicSDK({
    apiKey,
    ...(extraHeaders ? { defaultHeaders: extraHeaders } : {}),
    ...(baseURL ? { baseURL } : {}),
  });

  const messages =
    opts.messages as unknown as Anthropic.MessageParam[];

  // Resolve system prompt: prefer blocks (with cache control), fall back to string
  let system: string | SystemPromptBlock[] = opts.systemPrompt;
  if (opts.systemBlocks) {
    system = systemPrefix
      ? [{ type: "text" as const, text: systemPrefix }, ...opts.systemBlocks]
      : opts.systemBlocks;
  } else if (systemPrefix) {
    system = [
      { type: "text" as const, text: systemPrefix },
      { type: "text" as const, text: opts.systemPrompt },
    ];
  }

  if (opts.structuredOutput) {
    // Use tool_use to enforce structured output. Cache the tool definition —
    // it's identical across every parallel module-developer call, so this
    // saves the schema-encoding tokens on every call after the first.
    const tool: Anthropic.Tool = {
      name: opts.structuredOutput.name,
      description: `Return the result as structured JSON matching the ${opts.structuredOutput.name} schema.`,
      input_schema:
        opts.structuredOutput.schema as Anthropic.Tool.InputSchema,
      cache_control: { type: "ephemeral" },
    };

    return withRateLimitRetry(async () => {
      const response = await client.messages.create({
        model,
        max_tokens: opts.maxTokens || 16000,
        system: system as any,
        messages,
        tools: [tool],
        tool_choice: { type: "tool", name: opts.structuredOutput!.name },
        ...(opts.thinkingBudgetTokens
          ? { thinking: { type: "enabled" as const, budget_tokens: opts.thinkingBudgetTokens } }
          : {}),
      });

      // Extract tool_use input from the response
      for (const block of response.content) {
        if (block.type === "tool_use") {
          return {
            type: "structured" as const,
            data: stringifyJsonFields(block.input),
          };
        }
      }

      // Fallback: no tool_use block found — return text
      const textParts = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text);
      return { type: "text" as const, text: textParts.join("") };
    }, opts.onStatus);
  }

  // Non-structured: regular text generation. Optionally attach the
  // server-side web_search tool — works only on the streaming text path
  // because structured output forces a single tool_choice.
  return withRateLimitRetry(async () => {
    let fullText = "";
    const stream = client.messages.stream({
      model,
      max_tokens: opts.maxTokens || 16000,
      system: system as any,
      messages,
      ...(opts.enableWebSearch
        ? { tools: [{ type: "web_search_20250305" as const, name: "web_search" }] as Anthropic.ToolUnion[] }
        : {}),
      ...(opts.thinkingBudgetTokens
        ? { thinking: { type: "enabled" as const, budget_tokens: opts.thinkingBudgetTokens } }
        : {}),
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullText += event.delta.text;
        if (opts.onChunk) opts.onChunk(event.delta.text);
      }
    }

    return { type: "text" as const, text: fullText };
  }, opts.onStatus);
}

/**
 * OAuth variant — uses authToken (Bearer) instead of apiKey, adds required headers + system prefix.
 */
async function callAnthropicOAuth(
  accessToken: string,
  model: string,
  opts: AgentCallOptions,
): Promise<AgentCallResult> {
  const AnthropicSDK = await getAnthropicSDK();
  const client = new AnthropicSDK({
    authToken: accessToken,
    defaultHeaders: OAUTH_EXTRA_HEADERS,
  } as any);

  const messages =
    opts.messages as unknown as Anthropic.MessageParam[];

  // Build system with OAuth prefix + optional cache blocks
  let system: string | SystemPromptBlock[];
  if (opts.systemBlocks) {
    system = [
      { type: "text" as const, text: OAUTH_SYSTEM_PREFIX },
      ...opts.systemBlocks,
    ];
  } else {
    system = [
      { type: "text" as const, text: OAUTH_SYSTEM_PREFIX },
      { type: "text" as const, text: opts.systemPrompt },
    ];
  }

  if (opts.structuredOutput) {
    const tool: Anthropic.Tool = {
      name: opts.structuredOutput.name,
      description: `Return the result as structured JSON matching the ${opts.structuredOutput.name} schema.`,
      input_schema: opts.structuredOutput.schema as Anthropic.Tool.InputSchema,
      cache_control: { type: "ephemeral" },
    };

    return withRateLimitRetry(async () => {
      const response = await client.messages.create({
        model,
        max_tokens: opts.maxTokens || 16000,
        system: system as any,
        messages,
        tools: [tool],
        tool_choice: { type: "tool", name: opts.structuredOutput!.name },
        ...(opts.thinkingBudgetTokens
          ? { thinking: { type: "enabled" as const, budget_tokens: opts.thinkingBudgetTokens } }
          : {}),
      });

      for (const block of response.content) {
        if (block.type === "tool_use") {
          return { type: "structured" as const, data: stringifyJsonFields(block.input) };
        }
      }

      const textParts = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text);
      return { type: "text" as const, text: textParts.join("") };
    }, opts.onStatus);
  }

  return withRateLimitRetry(async () => {
    let fullText = "";
    const stream = client.messages.stream({
      model,
      max_tokens: opts.maxTokens || 16000,
      system: system as any,
      messages,
      ...(opts.enableWebSearch
        ? { tools: [{ type: "web_search_20250305" as const, name: "web_search" }] as Anthropic.ToolUnion[] }
        : {}),
      ...(opts.thinkingBudgetTokens
        ? { thinking: { type: "enabled" as const, budget_tokens: opts.thinkingBudgetTokens } }
        : {}),
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullText += event.delta.text;
        if (opts.onChunk) opts.onChunk(event.delta.text);
      }
    }

    return { type: "text" as const, text: fullText };
  }, opts.onStatus);
}

// ---------------------------------------------------------------------------
// OpenAI Adapter — structured output via response_format json_schema
// ---------------------------------------------------------------------------

/**
 * Recursively add `additionalProperties: false` to all object-type schemas
 * (required by OpenAI's structured output).
 */
function addAdditionalPropertiesFalse(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...schema };
  if (result.type === "object") {
    result.additionalProperties = false;
    if (
      result.properties &&
      typeof result.properties === "object"
    ) {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(
        result.properties as Record<string, unknown>,
      )) {
        props[k] =
          v && typeof v === "object"
            ? addAdditionalPropertiesFalse(v as Record<string, unknown>)
            : v;
      }
      result.properties = props;
    }
  }
  if (result.items && typeof result.items === "object") {
    result.items = addAdditionalPropertiesFalse(
      result.items as Record<string, unknown>,
    );
  }
  return result;
}

async function callOpenAI(
  apiKey: string,
  model: string,
  opts: AgentCallOptions,
  fetchURL?: string,
): Promise<AgentCallResult> {
  const openaiMessages = [
    { role: "system", content: opts.systemPrompt },
    ...opts.messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content
          : m.content.map((b) => ({ type: "text" as const, text: b.text })),
    })),
  ];

  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens || 16000,
    messages: openaiMessages,
  };

  if (opts.structuredOutput) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: opts.structuredOutput.name,
        strict: true,
        schema: addAdditionalPropertiesFalse(opts.structuredOutput.schema),
      },
    };
  }

  const url = fetchURL || "https://api.openai.com/v1/chat/completions";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    const status = response.status;
    if (status === 429) {
      const error = new Error(`OpenAI rate limit: ${err}`);
      (error as unknown as { status: number }).status = 429;
      throw error;
    }
    throw new Error(`OpenAI API error (${status}): ${err}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content || "";

  if (opts.structuredOutput) {
    try {
      return {
        type: "structured",
        data: stringifyJsonFields(JSON.parse(content)),
      };
    } catch {
      log.warn("agent-adapter", "OpenAI structured output parse failed, returning raw text");
      return { type: "text", text: content };
    }
  }

  return { type: "text", text: content };
}

// ---------------------------------------------------------------------------
// Gemini Adapter — structured output via responseMimeType + responseSchema
// ---------------------------------------------------------------------------

async function callGemini(
  apiKey: string,
  _model: string,
  opts: AgentCallOptions,
  fetchURL?: string,
): Promise<AgentCallResult> {
  const model = _model || "gemini-2.5-flash";

  // Gemini uses "user" / "model" roles
  const contents = opts.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts:
      typeof m.content === "string"
        ? [{ text: m.content }]
        : m.content.map((b) => ({ text: b.text })),
  }));

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: opts.systemPrompt }] },
    contents,
    generationConfig: {
      maxOutputTokens: opts.maxTokens || 16000,
      ...(opts.structuredOutput
        ? {
            responseMimeType: "application/json",
            responseSchema: opts.structuredOutput.schema,
          }
        : {}),
    },
  };

  const url = fetchURL || `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    const status = response.status;
    if (status === 429) {
      const error = new Error(`Gemini rate limit: ${err}`);
      (error as unknown as { status: number }).status = 429;
      throw error;
    }
    throw new Error(`Gemini API error (${status}): ${err}`);
  }

  const json = await response.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";

  if (opts.structuredOutput) {
    try {
      return {
        type: "structured",
        data: stringifyJsonFields(JSON.parse(text)),
      };
    } catch {
      log.warn("agent-adapter", "Gemini structured output parse failed, returning raw text");
      return { type: "text", text };
    }
  }

  return { type: "text", text };
}

// ---------------------------------------------------------------------------
// CLI Adapter — structured output via prompt instructions + post-parse
// ---------------------------------------------------------------------------

/**
 * Resolve CLI binary and args for a given engine. The `opts` allow us to
 * react to per-call flags (e.g. enabling Web Search on Claude Code).
 */
function resolveCLIBinary(
  engine: AgentEngine,
  model: string,
  opts?: AgentCallOptions,
): { bin: string; args: string[] } {
  switch (engine) {
    case "claude-code": {
      const args = ["--print"];
      if (model) args.push("--model", model);
      // Web Search is exposed via Claude Code's tool allowlist. We add to
      // the existing default toolset rather than replacing it (using the
      // additive form `--allowedTools=WebSearch`).
      if (opts?.enableWebSearch) args.push("--allowedTools=WebSearch");
      return { bin: "claude", args };
    }
    case "gemini-cli": {
      const args: string[] = [];
      if (model) args.push("-m", model);
      return { bin: "gemini", args };
    }
    case "codex-cli": {
      const args = ["exec", "--full-auto"];
      if (model) args.push("-m", model);
      return { bin: "codex", args };
    }
    default:
      throw new Error(`Not a CLI engine: ${engine}`);
  }
}

/**
 * Build a flat prompt string from AgentCallOptions for CLI engines.
 * CLI engines receive a single string via stdin — no separate system/user messages.
 */
function buildCLIPrompt(opts: AgentCallOptions): string {
  const parts: string[] = [opts.systemPrompt];

  for (const msg of opts.messages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content.map((b) => b.text).join("\n");
    parts.push(`\n\n## ${role}\n${text}`);
  }

  if (opts.structuredOutput) {
    const schemaDesc = describeSchema(opts.structuredOutput.schema);
    parts.push(`\n\n## Output Format — CRITICAL
Respond with a JSON code block. Wrap your JSON in \`\`\`json fences. No prose or explanation before or after the code block.

The JSON must match this structure:
${schemaDesc}`);
  }

  return parts.join("");
}

/**
 * Generate a human-readable schema description from a JSON Schema object.
 */
function describeSchema(schema: Record<string, unknown>, indent = 0): string {
  const pad = "  ".repeat(indent);
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = (schema.required as string[]) || [];

  if (!props) return `${pad}${JSON.stringify(schema)}`;

  const lines: string[] = ["{"];
  for (const [key, prop] of Object.entries(props)) {
    const req = required.includes(key) ? " (required)" : "";
    const type = prop.type || "any";
    const desc = prop.description ? ` — ${prop.description}` : "";
    const enumVals = prop.enum ? ` [${(prop.enum as string[]).join(", ")}]` : "";

    if (type === "array" && prop.items) {
      const itemType = (prop.items as Record<string, unknown>).type || "object";
      lines.push(`${pad}  "${key}": ${type}<${itemType}>${req}${desc}${enumVals}`);
    } else if (type === "object" && prop.properties) {
      lines.push(`${pad}  "${key}": ${describeSchema(prop as Record<string, unknown>, indent + 1)}${req}${desc}`);
    } else {
      lines.push(`${pad}  "${key}": ${type}${req}${desc}${enumVals}`);
    }
  }
  lines.push(`${pad}}`);
  return lines.join("\n");
}

/**
 * Extract JSON from CLI output that may contain prose, markdown fences, or raw JSON.
 * Tries multiple strategies to find valid JSON anywhere in the output.
 */
function extractJSON(output: string): unknown | null {
  const trimmed = output.trim();

  // Strategy 1: Direct parse (output is raw JSON with no surrounding text)
  const direct = tryParseJSON(trimmed);
  if (direct && typeof direct === "object") return direct;

  // Strategy 2: Extract from markdown fenced code blocks (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/```(?:json|vibespot-modules)?\s*\n([\s\S]*?)```/i);
  if (fenceMatch) {
    const fenced = fenceMatch[1].trim();
    const parsed = tryParseJSON(fenced);
    if (parsed && typeof parsed === "object") return parsed;
    const repaired = tryRepairTruncatedJSON(fenced);
    if (repaired && typeof repaired === "object") return repaired;
  }

  // Strategy 3: Find the outermost { ... } in the output (greedy brace matching)
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const braceContent = trimmed.slice(firstBrace, lastBrace + 1);
    const parsed = tryParseJSON(braceContent);
    if (parsed && typeof parsed === "object") return parsed;
    const repaired = tryRepairTruncatedJSON(braceContent);
    if (repaired && typeof repaired === "object") return repaired;
  }

  // Strategy 4: Try repair on the full output (may be truncated JSON with leading text stripped)
  const repaired = tryRepairTruncatedJSON(trimmed);
  if (repaired && typeof repaired === "object") return repaired;

  return null;
}

/**
 * Call an AI agent via CLI subprocess with prompt-based JSON extraction.
 */
async function callAgentCLI(
  engine: AgentEngine,
  model: string,
  opts: AgentCallOptions,
): Promise<AgentCallResult> {
  const { bin, args } = resolveCLIBinary(engine, model, opts);
  const prompt = buildCLIPrompt(opts);

  // Claude Code: use stream-json so we get structured events (assistant
  // text deltas, tool calls, final result) instead of raw concatenated
  // text. Tool-use events are surfaced via onStatus so the pipeline UI
  // can show what the agent is doing.
  let rawOutput: string;
  if (engine === "claude-code") {
    const streamArgs = [
      ...args,
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    rawOutput = await spawnClaudeCodeStreamJSON(streamArgs, prompt, {
      onChunk: opts.onChunk,
      onToolUse: (toolName, input) => {
        if (!opts.onStatus) return;
        const summary = summarizeToolUse(toolName, input);
        opts.onStatus(summary);
      },
    });
  } else {
    rawOutput = await spawnCLI(bin, args, prompt, opts.onChunk);
  }

  if (!opts.structuredOutput) {
    return { type: "text", text: rawOutput };
  }

  // Extract JSON from CLI output using multiple strategies
  const parsed = extractJSON(rawOutput);
  if (parsed) {
    return {
      type: "structured",
      data: stringifyJsonFields(parsed as Record<string, unknown>),
    };
  }

  log.warn("agent-cli", `${engine}: failed to parse structured output, returning text`, {
    outputPreview: rawOutput.slice(0, 500),
    outputLength: rawOutput.length,
  });
  return { type: "text", text: rawOutput };
}

/**
 * Render a tool-use event as a short human-readable status line.
 * Used to surface Claude Code agent activity (Web search, file reads,
 * edits, etc.) into the pipeline UI status pane.
 */
function summarizeToolUse(name: string, input: Record<string, unknown> | undefined): string {
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
// Unified entry points
// ---------------------------------------------------------------------------

const API_ENGINES = new Set([
  "anthropic-api",
  "claude-oauth",
  "openai-api",
  "gemini-api",
  "langdock-api",
]);

/**
 * Call an AI agent via API with optional structured output enforcement.
 */
export async function callAgentAPI(
  engine: AgentEngine,
  apiKey: string,
  model: string,
  opts: AgentCallOptions,
): Promise<AgentCallResult> {
  log.info("agent-adapter", `${engine} API call`, {
    model,
    structured: !!opts.structuredOutput,
    schemaName: opts.structuredOutput?.name,
    systemPromptLength: opts.systemPrompt.length,
    messageCount: opts.messages.length,
  });

  switch (engine) {
    case "anthropic-api":
      return callAnthropic(apiKey, model, opts);
    case "claude-oauth": {
      // Resolve fresh OAuth token at call time (auto-refreshes if needed)
      const { getValidAccessToken } = await import("../../utils/claude-oauth.js");
      const oauthToken = await getValidAccessToken();
      if (!oauthToken) throw new Error("Claude OAuth session expired. Please re-authenticate in Settings.");
      return callAnthropicOAuth(oauthToken, model, opts);
    }
    case "openai-api":
      return callOpenAI(apiKey, model, opts);
    case "gemini-api":
      return callGemini(apiKey, model, opts);
    case "langdock-api": {
      const cfg = loadConfig();
      const provider = cfg.langdockProvider || "anthropic";
      const customBase = cfg.langdockBaseUrl;
      switch (provider) {
        case "openai":
        case "mistral": {
          const base = customBase || LANGDOCK_BASE_URLS[provider];
          return callOpenAI(apiKey, model, opts, `${base}/v1/chat/completions`);
        }
        case "google": {
          const base = customBase || LANGDOCK_BASE_URLS.google;
          return callGemini(apiKey, model, opts, `${base}/v1beta/models/${model}:generateContent`);
        }
        case "anthropic":
        default: {
          const baseURL = customBase || LANGDOCK_BASE_URLS.anthropic;
          return callAnthropic(apiKey, model, opts, undefined, undefined, baseURL);
        }
      }
    }
    default:
      throw new Error(`Unsupported API engine: ${engine}`);
  }
}

/**
 * Unified agent call dispatcher — routes to API or CLI adapter based on engine type.
 * Stages should call this instead of callAgentAPI directly.
 */
export async function callAgent(
  engine: AgentEngine,
  apiKey: string,
  model: string,
  opts: AgentCallOptions,
): Promise<AgentCallResult> {
  if (API_ENGINES.has(engine)) {
    return callAgentAPI(engine, apiKey, model, opts);
  }

  log.info("agent-adapter", `${engine} CLI call`, {
    structured: !!opts.structuredOutput,
    schemaName: opts.structuredOutput?.name,
    systemPromptLength: opts.systemPrompt.length,
    messageCount: opts.messages.length,
  });

  return callAgentCLI(engine, model, opts);
}

/**
 * Resolve the extended-thinking budget (in tokens) for the current engine
 * and config. Returns 0 (no thinking) unless extended thinking is enabled
 * AND the engine is Anthropic-based — extended thinking is an Anthropic
 * feature; we don't try to emulate it on other engines.
 */
export function resolveThinkingBudget(engine: AgentEngine): number {
  // Extended thinking is an Anthropic feature; supported on engines that route
  // through Anthropic's API surface (direct, OAuth, or Langdock with Anthropic provider).
  if (engine === "langdock-api") {
    const cfg2 = loadConfig();
    if ((cfg2.langdockProvider || "anthropic") !== "anthropic") return 0;
  } else if (engine !== "anthropic-api" && engine !== "claude-oauth") {
    return 0;
  }
  const cfg = loadConfig();
  if (!cfg.extendedThinking) return 0;
  switch (cfg.extendedThinkingBudget) {
    case "high":
      return 32000;
    case "low":
      return 4000;
    case "medium":
    default:
      return 16000;
  }
}

/**
 * Check if an engine type supports the agentic pipeline.
 * All engine types now support agentic mode — CLI engines use
 * prompt-based JSON extraction instead of native structured output.
 */
export function isAgenticCapable(
  engine: string,
): engine is AgentEngine {
  return (
    engine === "anthropic-api" ||
    engine === "claude-oauth" ||
    engine === "openai-api" ||
    engine === "gemini-api" ||
    engine === "langdock-api" ||
    engine === "claude-code" ||
    engine === "gemini-cli" ||
    engine === "codex-cli"
  );
}

/**
 * Check if an engine is a CLI engine (subprocess-based).
 */
export function isCLIEngine(engine: string): boolean {
  return engine === "claude-code" || engine === "gemini-cli" || engine === "codex-cli";
}
