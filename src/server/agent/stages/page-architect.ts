/**
 * Stage 2: Design System + Module Planner
 *
 * Split into two sequential agent calls:
 * 2a: Design System — creates :root vars, shared CSS, shared JS
 * 2b: Module Planner — plans modules using the finalized CSS
 *
 * This ensures module developers get a complete, working design system.
 */

import type { AgentEngine } from "../engine-adapter.js";
import { callAgent } from "../engine-adapter.js";
import type { PipelinePlan, PageBlueprint, DesignSystemOutput, PipelineEvent } from "../types.js";
import type { SessionSnapshot } from "../../session/types.js";
import {
  buildDesignSystemPrompt,
  buildDesignSystemPromptBlocks,
  buildModulePlannerPrompt,
  DESIGN_SYSTEM_SCHEMA,
  MODULE_PLANNER_SCHEMA,
} from "../prompts/page-architect.js";
import { log } from "../../log.js";

export async function runPageArchitect(
  userMessage: string,
  plan: PipelinePlan,
  snapshot: SessionSnapshot,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  onEvent: (event: PipelineEvent) => void,
): Promise<PageBlueprint> {
  // -------------------------------------------------------------------------
  // Stage 2a: Design System
  // -------------------------------------------------------------------------

  onEvent({
    type: "agent_step",
    step: "designing",
    label: "Creating design system...",
  });

  const isAnthropicEngine = engine === "anthropic-api" || engine === "claude-oauth";
  const designPrompt = buildDesignSystemPrompt(
    snapshot.themeName,
    snapshot.brandAssets,
  );
  const designBlocks = isAnthropicEngine
    ? buildDesignSystemPromptBlocks(snapshot.themeName, snapshot.brandAssets)
    : undefined;

  let designUserContent = `## User Request\n${userMessage}`;
  if (snapshot.modules.length > 0 && plan.designSystemChanges) {
    designUserContent += `\n\n## Current Shared CSS (update this)\n\`\`\`css\n${snapshot.sharedCss}\n\`\`\``;
  }

  const designResult = await callAgent(engine, apiKey, model, {
    systemPrompt: designPrompt,
    systemBlocks: designBlocks,
    messages: [{ role: "user", content: designUserContent }],
    structuredOutput: {
      schema: DESIGN_SYSTEM_SCHEMA as unknown as Record<string, unknown>,
      name: "design_system",
    },
    maxTokens: 16000,
  });

  let designSystem: DesignSystemOutput;

  if (designResult.type !== "structured") {
    log.warn("page-architect", "Design system: did not get structured output, using fallback");
    designSystem = {
      cssVariables: {},
      sharedCss: snapshot.sharedCss || "",
      sharedJs: snapshot.sharedJs || "",
      aesthetic: "default",
    };
  } else {
    designSystem = designResult.data as DesignSystemOutput;
    log.info("page-architect", "Design system created", {
      aesthetic: designSystem.aesthetic,
      varCount: Object.keys(designSystem.cssVariables || {}).length,
      cssLength: designSystem.sharedCss?.length || 0,
    });
  }

  // Ensure :root block exists in sharedCss
  let sharedCss = designSystem.sharedCss || "";
  const vars = designSystem.cssVariables;
  if (vars && typeof vars === "object" && Object.keys(vars).length > 0) {
    if (!sharedCss.includes(":root")) {
      const varLines = Object.entries(vars)
        .map(([k, v]) => `  ${k.startsWith("--") ? k : `--${k}`}: ${v};`)
        .join("\n");
      sharedCss = `:root {\n${varLines}\n}\n\n${sharedCss}`;
    }
  }

  // Detect if the user requested web fonts that couldn't be used
  const fontNotes: string[] = [];
  const webFontPattern = /\b(Montserrat|Inter|Poppins|Raleway|Playfair|Lato|Roboto|Open\s?Sans|Nunito|Merriweather|Oswald|Source\s?Sans|Fira\s?Sans|Work\s?Sans|Manrope|Plus\s?Jakarta)\b/gi;
  const requestedFonts = [...new Set((userMessage.match(webFontPattern) || []).map((f) => f.trim()))];
  if (requestedFonts.length > 0) {
    const usedFonts = requestedFonts.filter((f) =>
      sharedCss.toLowerCase().includes(f.toLowerCase()),
    );
    const droppedFonts = requestedFonts.filter((f) => !usedFonts.includes(f));
    if (droppedFonts.length > 0) {
      fontNotes.push(
        `Note: ${droppedFonts.join(", ")} not available — HubSpot modules use system font stacks (no external font imports allowed)`,
      );
    }
  }

  const decisionParts = [
    `Design system: ${designSystem.aesthetic || "created"} | ${Object.keys(vars || {}).length} variables, ${sharedCss.length} chars CSS`,
    ...fontNotes,
  ];

  onEvent({
    type: "agent_decision",
    step: "designing",
    decision: decisionParts.join("\n"),
  });

  // Emit design system ready so the preview can start showing themed placeholders
  onEvent({
    type: "design_system_ready",
    sharedCss,
    sharedJs: designSystem.sharedJs || "",
    aesthetic: designSystem.aesthetic || "",
  });

  // -------------------------------------------------------------------------
  // Stage 2b: Module Planner
  // -------------------------------------------------------------------------

  onEvent({
    type: "agent_step",
    step: "designing",
    label: "Planning modules...",
  });

  const plannerPrompt = buildModulePlannerPrompt(
    snapshot.themeName,
    sharedCss,
    snapshot.brandAssets,
    plan.guidesNeeded,
  );

  let plannerUserContent = `## User Request\n${userMessage}`;
  if (plan.newModules.length > 0) {
    plannerUserContent += `\n\n## Planned Modules\n${plan.newModules.map((m, i) => `${i + 1}. **${m.name}** — ${m.description}`).join("\n")}`;
  }
  if (snapshot.modules.length > 0 && !plan.designSystemChanges) {
    plannerUserContent += `\n\n## Existing Modules (keeping)\n${snapshot.modules.map((m) => `- ${m.moduleName}`).join("\n")}`;
  }

  const plannerResult = await callAgent(engine, apiKey, model, {
    systemPrompt: plannerPrompt,
    messages: [{ role: "user", content: plannerUserContent }],
    structuredOutput: {
      schema: MODULE_PLANNER_SCHEMA as unknown as Record<string, unknown>,
      name: "module_plan",
    },
    maxTokens: 8000,
  });

  let modulePlan: { modules: PageBlueprint["modules"]; moduleOrder: string[]; narrative: string };

  if (plannerResult.type !== "structured") {
    log.warn("page-architect", "Module planner: did not get structured output, using fallback");
    modulePlan = {
      modules: plan.newModules.map((m) => ({
        name: m.name,
        description: m.description,
        contentBrief: "Generate appropriate content",
        layoutNotes: "Use responsive layout",
      })),
      moduleOrder: plan.newModules.map((m) => m.name),
      narrative: "Page generated from user request",
    };
  } else {
    modulePlan = plannerResult.data as typeof modulePlan;
    log.info("page-architect", "Module plan", {
      moduleCount: modulePlan.modules.length,
    });
  }

  onEvent({
    type: "agent_decision",
    step: "designing",
    decision: `Page: ${modulePlan.narrative} | ${modulePlan.modules.length} modules planned`,
  });

  // -------------------------------------------------------------------------
  // Assemble full blueprint
  // -------------------------------------------------------------------------

  return {
    designSystem: {
      cssVariables: designSystem.cssVariables || {},
      sharedCss,
      sharedJs: designSystem.sharedJs,
    },
    modules: modulePlan.modules,
    moduleOrder: modulePlan.moduleOrder,
    narrative: modulePlan.narrative,
  };
}
