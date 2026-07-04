/**
 * Stage 1: Intent Analyzer
 * Fast classification of user request. ~1.5K token system prompt.
 * Returns a PipelinePlan telling downstream stages what to do.
 */

import type { AgentEngine } from "../engine-adapter.js";
import { callAgent } from "../engine-adapter.js";
import type { PipelinePlan, PipelineEvent } from "../types.js";
import type { SessionSnapshot } from "../../session/types.js";
import {
  buildIntentAnalyzerPrompt,
  INTENT_ANALYZER_SCHEMA,
} from "../prompts/intent-analyzer.js";
import { stagePromptLink } from "../prompts/registry.js";
import { log } from "../../log.js";
import { runWithSpan } from "../../langfuse.js";
import { kebabModuleName } from "../../../utils/path-safety.js";

export async function runIntentAnalyzer(
  userMessage: string,
  snapshot: SessionSnapshot,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  onEvent: (event: PipelineEvent) => void,
  libraryModules: { name: string; usedIn: string[] }[],
  signal?: AbortSignal,
): Promise<PipelinePlan> {
  onEvent({
    type: "agent_step",
    step: "analyzing",
    label: "Analyzing your request...",
  });

  const moduleNames = snapshot.modules.map((m) => m.moduleName);

  const systemPrompt = buildIntentAnalyzerPrompt(
    snapshot.themeName,
    moduleNames,
    libraryModules,
    snapshot.brandAssets?.themeContext,
    snapshot.sitePages ? {
      activePageLabel: snapshot.activePageLabel,
      pages: snapshot.sitePages.map((p) => ({ id: p.id, label: p.label, moduleCount: p.moduleCount })),
    } : undefined,
  );

  // Build messages with recent conversation history for context resolution
  // (e.g., "same section", "that module", corrections like "I meant the hero")
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  const recentMessages = snapshot.messages.slice(-6); // Last 3 exchanges max
  for (const msg of recentMessages) {
    if (msg.role === "user" || msg.role === "assistant") {
      // Truncate long assistant messages to just the first line (narrative summary)
      const content =
        msg.role === "assistant" && msg.content.length > 300
          ? msg.content.slice(0, 300) + "..."
          : msg.content;
      messages.push({ role: msg.role, content });
    }
  }
  // Always end with the current user message
  messages.push({ role: "user", content: userMessage });

  const result = await runWithSpan("intent-analyzer", () =>
    callAgent(engine, apiKey, model, {
      systemPrompt,
      messages,
      structuredOutput: {
        schema: INTENT_ANALYZER_SCHEMA as unknown as Record<string, unknown>,
        name: "pipeline_plan",
      },
      maxTokens: 2000,
      prompt: stagePromptLink("intent-analyzer"),
      signal,
    }),
  );

  if (result.type !== "structured") {
    log.warn("intent-analyzer", "Did not get structured output, falling back");
    // Fallback: treat as full page create/modify
    const isNew = snapshot.modules.length === 0;
    return {
      intent: isNew ? "create" : "modify",
      affectedModules: isNew ? [] : moduleNames,
      unchangedModules: [],
      newModules: [],
      guidesNeeded: ["design", "content", "conversion", "hubspot_rules", "humanify"],
      designSystemChanges: isNew,
    };
  }

  const plan = result.data as PipelinePlan;

  // Ensure arrays exist and normalize contentType
  plan.affectedModules = plan.affectedModules || [];
  plan.unchangedModules = plan.unchangedModules || [];
  plan.newModules = plan.newModules || [];
  // New-module names become path components (`modules/<name>.module`) — coerce
  // structured output to the safe kebab charset before anything downstream
  // touches the filesystem (VIB-1891). Names that coerce to nothing are dropped.
  plan.newModules = plan.newModules
    .map((m) => ({ ...m, name: kebabModuleName(String(m.name ?? "")) }))
    .filter((m) => m.name.length > 0);
  // Same treatment for multi-page plans: page ids/slugs become template
  // filenames, shared module names become module dirs.
  if (plan.pages) {
    plan.pages = plan.pages
      .map((p) => ({
        ...p,
        id: kebabModuleName(String(p.id ?? "")),
        slug: kebabModuleName(String(p.slug ?? "")),
      }))
      .filter((p) => p.id.length > 0);
  }
  if (plan.sharedModules) {
    plan.sharedModules = plan.sharedModules
      .map((n) => kebabModuleName(String(n ?? "")))
      .filter((n) => n.length > 0);
  }
  plan.guidesNeeded = plan.guidesNeeded || [];
  if (snapshot.contentMode === "email" || snapshot.contentMode === "blog") {
    plan.contentType = snapshot.contentMode;
  } else {
    // Normalize to the known content types. "blog" must survive here — it
    // selects the blog prompts/schema/validator downstream (VIB-1895).
    plan.contentType =
      plan.contentType === "email" || plan.contentType === "blog"
        ? plan.contentType
        : "page";
  }

  log.info("intent-analyzer", "Plan", {
    intent: plan.intent,
    affected: plan.affectedModules.length,
    unchanged: plan.unchangedModules.length,
    new: plan.newModules.length,
    reuse: plan.reuseModules?.length || 0,
    designSystem: plan.designSystemChanges,
  });

  onEvent({
    type: "agent_decision",
    step: "analyzing",
    decision: formatDecision(plan),
  });

  return plan;
}

function formatDecision(plan: PipelinePlan): string {
  const parts: string[] = [`Intent: ${plan.intent}`];

  if (plan.affectedModules.length > 0) {
    parts.push(`Modifying: ${plan.affectedModules.join(", ")}`);
  }
  if (plan.unchangedModules.length > 0) {
    parts.push(`Unchanged: ${plan.unchangedModules.join(", ")}`);
  }
  if (plan.newModules.length > 0) {
    parts.push(
      `New: ${plan.newModules.map((m) => m.name).join(", ")}`,
    );
  }
  if (plan.reuseModules?.length) {
    parts.push(
      `Reuse: ${plan.reuseModules.map((m) => `${m.name} from ${m.sourceTemplate}`).join(", ")}`,
    );
  }
  if (plan.designSystemChanges) {
    parts.push("Design system changes: yes");
  }

  return parts.join(" | ");
}
