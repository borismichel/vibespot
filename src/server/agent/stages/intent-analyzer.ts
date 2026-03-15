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
import { log } from "../../log.js";

export async function runIntentAnalyzer(
  userMessage: string,
  snapshot: SessionSnapshot,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  onEvent: (event: PipelineEvent) => void,
  libraryModules: { name: string; usedIn: string[] }[],
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
  );

  const result = await callAgent(engine, apiKey, model, {
    systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    structuredOutput: {
      schema: INTENT_ANALYZER_SCHEMA as unknown as Record<string, unknown>,
      name: "pipeline_plan",
    },
    maxTokens: 2000,
  });

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

  // Ensure arrays exist
  plan.affectedModules = plan.affectedModules || [];
  plan.unchangedModules = plan.unchangedModules || [];
  plan.newModules = plan.newModules || [];
  plan.guidesNeeded = plan.guidesNeeded || [];

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
