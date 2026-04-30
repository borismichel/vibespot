/**
 * Stage 3: Module Developer (Parallel)
 * One API call per module, run with concurrency limiter.
 * ~42K token system prompt (conversion guide + HubSpot rules).
 */

import type { ModuleFiles } from "../../../ai/engine.js";
import type { AgentEngine } from "../engine-adapter.js";
import { callAgent } from "../engine-adapter.js";
import type { ContentType, ModuleSpec, PipelineEvent } from "../types.js";
import { createConcurrencyLimiter } from "../types.js";
import {
  buildModuleDeveloperPrompt,
  buildModuleDeveloperPromptBlocks,
  buildModuleUserMessage,
  MODULE_DEVELOPER_SCHEMA,
} from "../prompts/module-developer.js";
import {
  buildEmailModuleDeveloperPrompt,
  buildEmailModuleDeveloperPromptBlocks,
  buildEmailModuleUserMessage,
  EMAIL_MODULE_DEVELOPER_SCHEMA,
} from "../prompts/email-module-developer.js";
import {
  buildBlogModuleDeveloperPrompt,
  buildBlogModuleDeveloperPromptBlocks,
  buildBlogModuleUserMessage,
  BLOG_MODULE_DEVELOPER_SCHEMA,
} from "../prompts/blog-module-developer.js";
import { log } from "../../log.js";

export interface ModuleDevResult {
  moduleName: string;
  module?: ModuleFiles;
  error?: string;
}

export async function runModuleDeveloper(
  userMessage: string,
  specs: ModuleSpec[],
  sharedCss: string,
  themeName: string,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  concurrency: number,
  onEvent: (event: PipelineEvent) => void,
  guidesNeeded?: string[],
  brandAssets?: { styleguide?: string; brandvoice?: string; humanify?: boolean },
  contentType?: ContentType,
): Promise<ModuleDevResult[]> {
  const isEmail = contentType === "email";
  const isBlog = contentType === "blog";
  const typeLabel = isEmail ? "email module" : isBlog ? "blog module" : "module";
  onEvent({
    type: "agent_step",
    step: "developing",
    label: `Generating ${specs.length} ${typeLabel}${specs.length === 1 ? "" : "s"}...`,
  });

  const isAnthropicEngine = engine === "anthropic-api" || engine === "claude-oauth";

  const systemPrompt = isEmail
    ? buildEmailModuleDeveloperPrompt(themeName, brandAssets)
    : isBlog
      ? buildBlogModuleDeveloperPrompt(themeName, sharedCss, guidesNeeded, brandAssets)
      : buildModuleDeveloperPrompt(themeName, sharedCss, guidesNeeded, brandAssets);
  const systemBlocks = isAnthropicEngine
    ? isEmail
      ? buildEmailModuleDeveloperPromptBlocks(themeName, brandAssets)
      : isBlog
        ? buildBlogModuleDeveloperPromptBlocks(themeName, sharedCss, guidesNeeded, brandAssets)
        : buildModuleDeveloperPromptBlocks(themeName, sharedCss, guidesNeeded, brandAssets)
    : undefined;

  const limit = createConcurrencyLimiter(concurrency);
  const total = specs.length;

  const outputSchema = isEmail
    ? EMAIL_MODULE_DEVELOPER_SCHEMA
    : isBlog
      ? BLOG_MODULE_DEVELOPER_SCHEMA
      : MODULE_DEVELOPER_SCHEMA;

  const promises = specs.map((spec, index) =>
    limit(async (): Promise<ModuleDevResult> => {
      onEvent({
        type: "module_progress",
        module: spec.name,
        status: "generating",
        current: index + 1,
        total,
      });

      let lastError = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) {
            log.warn("module-developer", `${spec.name}: retrying after failure (attempt ${attempt + 1})`);
            onEvent({
              type: "module_progress",
              module: spec.name,
              status: "retrying",
              current: index + 1,
              total,
            });
          }

          const module = await generateSingleModule(
            userMessage,
            spec,
            systemPrompt,
            engine,
            apiKey,
            model,
            0,
            systemBlocks,
            isEmail,
            outputSchema,
            isBlog,
          );

          onEvent({
            type: "module_progress",
            module: spec.name,
            status: "complete",
            current: index + 1,
            total,
            moduleFiles: module,
          });

          return { moduleName: spec.name, module };
        } catch (err) {
          lastError =
            err instanceof Error ? err.message
              : typeof err === "object" && err !== null ? JSON.stringify(err)
              : String(err);
          log.error("module-developer", `Failed: ${spec.name} (attempt ${attempt + 1})`, {
            error: lastError,
          });
        }
      }

      // Both attempts failed
      onEvent({
        type: "module_progress",
        module: spec.name,
        status: "failed",
        current: index + 1,
        total,
      });

      return { moduleName: spec.name, error: lastError };
    }),
  );

  const results = await Promise.allSettled(promises);

  return results.map((r) => {
    if (r.status === "fulfilled") return r.value;
    return {
      moduleName: "unknown",
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });
}

async function generateSingleModule(
  userMessage: string,
  spec: ModuleSpec,
  systemPrompt: string,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  retryCount = 0,
  systemBlocks?: import("../engine-adapter.js").SystemPromptBlock[],
  isEmail = false,
  schema: Record<string, unknown> = MODULE_DEVELOPER_SCHEMA as unknown as Record<string, unknown>,
  isBlog = false,
): Promise<ModuleFiles> {
  const userContent = isEmail
    ? buildEmailModuleUserMessage(userMessage, spec, spec.existingCode)
    : isBlog
      ? buildBlogModuleUserMessage(userMessage, spec, spec.existingCode)
      : buildModuleUserMessage(userMessage, spec, spec.existingCode);

  const result = await callAgent(engine, apiKey, model, {
    systemPrompt,
    systemBlocks,
    messages: [{ role: "user", content: userContent }],
    structuredOutput: {
      schema: schema as unknown as Record<string, unknown>,
      name: "module_output",
    },
    maxTokens: 16000,
  });

  if (result.type !== "structured") {
    if (retryCount < 2) {
      log.warn(
        "module-developer",
        `${spec.name}: no structured output, retry ${retryCount + 1}`,
      );
      return generateSingleModule(
        userMessage,
        spec,
        systemPrompt,
        engine,
        apiKey,
        model,
        retryCount + 1,
        systemBlocks,
        isEmail,
        schema,
        isBlog,
      );
    }
    throw new Error(
      `Module "${spec.name}" failed to produce structured output after ${retryCount + 1} attempts`,
    );
  }

  const data = result.data as Record<string, unknown>;

  // Ensure fieldsJson and metaJson are strings
  const fieldsJson =
    typeof data.fieldsJson === "string"
      ? data.fieldsJson
      : JSON.stringify(data.fieldsJson, null, 2);
  const metaJson =
    typeof data.metaJson === "string"
      ? data.metaJson
      : JSON.stringify(data.metaJson, null, 2);

  return {
    moduleName: spec.name,
    fieldsJson,
    metaJson,
    moduleHtml: String(data.moduleHtml || ""),
    moduleCss: isEmail ? "" : String(data.moduleCss || ""),
    moduleJs: isEmail ? undefined : (data.moduleJs ? String(data.moduleJs) : undefined),
  };
}
