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
import { callAgent, resolveThinkingBudget } from "../engine-adapter.js";
import type { PipelinePlan, PageBlueprint, DesignSystemOutput, PipelineEvent } from "../types.js";
import type { SessionSnapshot } from "../../session/types.js";
import {
  buildDesignSystemPrompt,
  buildDesignSystemPromptBlocks,
  buildModulePlannerPrompt,
  DESIGN_SYSTEM_SCHEMA,
  MODULE_PLANNER_SCHEMA,
} from "../prompts/page-architect.js";
import {
  buildEmailDesignSystemPrompt,
  buildEmailDesignSystemPromptBlocks,
  buildEmailModulePlannerPrompt,
  EMAIL_DESIGN_SYSTEM_SCHEMA,
} from "../prompts/email-architect.js";
import { stagePromptLink } from "../prompts/registry.js";
import { log } from "../../log.js";
import { runWithSpan } from "../../langfuse.js";
import { kebabModuleName, isSafePathSegment } from "../../../utils/path-safety.js";

/**
 * Sanitize planner-supplied module names before they enter the blueprint —
 * they become path components downstream (`modules/<name>.module`), so a
 * hostile structured output must never carry traversal sequences (VIB-1891).
 * Names that exactly match an existing module are kept verbatim (imported
 * themes may have non-kebab names; the modify path needs exact matches),
 * everything else is kebab-coerced. Empty results are dropped.
 */
function sanitizeModulePlanNames<
  T extends { modules: PageBlueprint["modules"]; moduleOrder: string[] },
>(modulePlan: T, existingNames: Set<string>): T {
  const safeName = (raw: unknown): string => {
    const name = String(raw ?? "");
    return existingNames.has(name) && isSafePathSegment(name) ? name : kebabModuleName(name);
  };
  const modules = modulePlan.modules
    .map((m) => ({ ...m, name: safeName(m.name) }))
    .filter((m) => m.name.length > 0);
  const moduleOrder = (modulePlan.moduleOrder || [])
    .map((n) => safeName(n))
    .filter((n) => n.length > 0);
  return { ...modulePlan, modules, moduleOrder };
}

/**
 * Run only the Design System stage (2a) without the Module Planner.
 * Used by the multi-page pipeline which replaces 2b with the Site Module Planner.
 */
export async function runDesignSystem(
  userMessage: string,
  plan: PipelinePlan,
  snapshot: SessionSnapshot,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  onEvent: (event: PipelineEvent) => void,
  signal?: AbortSignal,
): Promise<DesignSystemOutput & { sharedCss: string }> {
  const isEmail = plan.contentType === "email";

  onEvent({
    type: "agent_step",
    step: "designing",
    label: isEmail ? "Creating email design tokens..." : "Creating design system...",
  });

  const isAnthropicEngine = engine === "anthropic-api" || engine === "claude-oauth";

  const designPrompt = isEmail
    ? buildEmailDesignSystemPrompt(snapshot.themeName, snapshot.brandAssets)
    : buildDesignSystemPrompt(snapshot.themeName, snapshot.brandAssets);
  const designBlocks = isAnthropicEngine
    ? (isEmail
        ? buildEmailDesignSystemPromptBlocks(snapshot.themeName, snapshot.brandAssets)
        : buildDesignSystemPromptBlocks(snapshot.themeName, snapshot.brandAssets))
    : undefined;

  let designUserContent = `## User Request\n${userMessage}`;
  if (snapshot.modules.length > 0 && plan.designSystemChanges) {
    designUserContent += `\n\n## Current Shared CSS (update this)\n\`\`\`css\n${snapshot.sharedCss}\n\`\`\``;
  }

  const thinkingBudget = resolveThinkingBudget(engine);
  const designSchema = isEmail ? EMAIL_DESIGN_SYSTEM_SCHEMA : DESIGN_SYSTEM_SCHEMA;
  const designResult = await runWithSpan("design-system", () =>
    callAgent(engine, apiKey, model, {
      systemPrompt: designPrompt,
      systemBlocks: designBlocks,
      messages: [{ role: "user", content: designUserContent }],
      structuredOutput: {
        schema: designSchema as unknown as Record<string, unknown>,
        name: "design_system",
      },
      maxTokens: 16000,
      ...(thinkingBudget > 0 ? { thinkingBudgetTokens: thinkingBudget } : {}),
      // Email uses a non-registry builder (email-architect) — link only the
      // registry-managed page-mode prompt (VIB-1861).
      ...(isEmail ? {} : { prompt: stagePromptLink("design-system") }),
      signal,
    }),
  );

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

  let sharedCss = isEmail ? "" : (designSystem.sharedCss || "");
  const vars = designSystem.cssVariables;
  if (!isEmail && vars && typeof vars === "object" && Object.keys(vars).length > 0) {
    if (!sharedCss.includes(":root")) {
      const varLines = Object.entries(vars)
        .map(([k, v]) => `  ${k.startsWith("--") ? k : `--${k}`}: ${v};`)
        .join("\n");
      sharedCss = `:root {\n${varLines}\n}\n\n${sharedCss}`;
    }
  }

  const tokenCount = Object.keys(vars || {}).length;
  const decisionParts = isEmail
    ? [`Email design tokens: ${designSystem.aesthetic || "created"} | ${tokenCount} tokens`]
    : [`Design system: ${designSystem.aesthetic || "created"} | ${tokenCount} variables, ${sharedCss.length} chars CSS`];

  onEvent({
    type: "agent_decision",
    step: "designing",
    decision: decisionParts.join("\n"),
  });

  onEvent({
    type: "design_system_ready",
    sharedCss,
    sharedJs: designSystem.sharedJs || "",
    aesthetic: designSystem.aesthetic || "",
  });

  return { ...designSystem, sharedCss };
}

export async function runPageArchitect(
  userMessage: string,
  plan: PipelinePlan,
  snapshot: SessionSnapshot,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  onEvent: (event: PipelineEvent) => void,
  signal?: AbortSignal,
): Promise<PageBlueprint> {
  const isEmail = plan.contentType === "email";

  // -------------------------------------------------------------------------
  // Stage 2a: Design System (or Email Design Tokens)
  // -------------------------------------------------------------------------

  onEvent({
    type: "agent_step",
    step: "designing",
    label: isEmail ? "Creating email design tokens..." : "Creating design system...",
  });

  const isAnthropicEngine = engine === "anthropic-api" || engine === "claude-oauth";

  const designPrompt = isEmail
    ? buildEmailDesignSystemPrompt(snapshot.themeName, snapshot.brandAssets)
    : buildDesignSystemPrompt(snapshot.themeName, snapshot.brandAssets);
  const designBlocks = isAnthropicEngine
    ? (isEmail
        ? buildEmailDesignSystemPromptBlocks(snapshot.themeName, snapshot.brandAssets)
        : buildDesignSystemPromptBlocks(snapshot.themeName, snapshot.brandAssets))
    : undefined;

  let designUserContent = `## User Request\n${userMessage}`;
  if (snapshot.modules.length > 0 && plan.designSystemChanges) {
    designUserContent += `\n\n## Current Shared CSS (update this)\n\`\`\`css\n${snapshot.sharedCss}\n\`\`\``;
  }

  const thinkingBudget = resolveThinkingBudget(engine);
  const designSchema = isEmail ? EMAIL_DESIGN_SYSTEM_SCHEMA : DESIGN_SYSTEM_SCHEMA;
  const designResult = await runWithSpan("design-system", () =>
    callAgent(engine, apiKey, model, {
      systemPrompt: designPrompt,
      systemBlocks: designBlocks,
      messages: [{ role: "user", content: designUserContent }],
      structuredOutput: {
        schema: designSchema as unknown as Record<string, unknown>,
        name: "design_system",
      },
      maxTokens: 16000,
      ...(thinkingBudget > 0 ? { thinkingBudgetTokens: thinkingBudget } : {}),
      // Email uses a non-registry builder (email-architect) — link only the
      // registry-managed page-mode prompt (VIB-1861).
      ...(isEmail ? {} : { prompt: stagePromptLink("design-system") }),
      signal,
    }),
  );

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

  // For email: no CSS at all — tokens are used inline by module developers.
  // For pages: ensure :root block exists in sharedCss.
  let sharedCss = isEmail ? "" : (designSystem.sharedCss || "");
  const vars = designSystem.cssVariables;
  if (!isEmail && vars && typeof vars === "object" && Object.keys(vars).length > 0) {
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

  const tokenCount = Object.keys(vars || {}).length;
  const decisionParts = isEmail
    ? [`Email design tokens: ${designSystem.aesthetic || "created"} | ${tokenCount} tokens`]
    : [
        `Design system: ${designSystem.aesthetic || "created"} | ${tokenCount} variables, ${sharedCss.length} chars CSS`,
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

  const plannerPrompt = isEmail
    ? buildEmailModulePlannerPrompt(
        snapshot.themeName,
        vars || {},
        snapshot.brandAssets,
        plan.guidesNeeded,
      )
    : buildModulePlannerPrompt(
        snapshot.themeName,
        sharedCss,
        snapshot.brandAssets,
        plan.guidesNeeded,
      );

  let plannerUserContent = `## User Request\n${userMessage}`;
  if (plan.newModules.length > 0) {
    plannerUserContent += `\n\n## Planned Modules\n${plan.newModules.map((m, i) => `${i + 1}. **${m.name}** — ${m.description}`).join("\n")}`;
  }

  // Always surface existing modules to the planner. Hiding them when the
  // design system changes (the previous behavior) caused the planner to
  // re-invent module names and produce duplicates instead of re-styling
  // the existing ones. Split into two lists so the planner knows which
  // names it MUST preserve vs which it may keep without re-planning.
  if (snapshot.modules.length > 0) {
    const affected = new Set(plan.affectedModules);
    const modifying = snapshot.modules.filter((m) => affected.has(m.moduleName));
    const keeping = snapshot.modules.filter((m) => !affected.has(m.moduleName));

    if (modifying.length > 0) {
      plannerUserContent +=
        `\n\n## Existing Modules to Re-plan (PRESERVE THESE EXACT NAMES)\n` +
        `These already exist and are being regenerated. Your output's module names MUST match these exactly — do NOT rename, retitle-case, or "improve" them. Their content/layout may change; their identifier must not.\n` +
        modifying.map((m) => `- \`${m.moduleName}\``).join("\n");
    }

    if (keeping.length > 0) {
      plannerUserContent +=
        `\n\n## Existing Modules to Keep (do not re-plan)\n` +
        `These stay as-is. Do NOT include them in your output. They will appear in the final \`moduleOrder\` (you can reference them by name when you list it).\n` +
        keeping.map((m) => `- \`${m.moduleName}\``).join("\n");
    }
  }

  const plannerResult = await runWithSpan("module-planner", () =>
    callAgent(engine, apiKey, model, {
      systemPrompt: plannerPrompt,
      messages: [{ role: "user", content: plannerUserContent }],
      structuredOutput: {
        schema: MODULE_PLANNER_SCHEMA as unknown as Record<string, unknown>,
        name: "module_plan",
      },
      maxTokens: 8000,
      ...(thinkingBudget > 0 ? { thinkingBudgetTokens: thinkingBudget } : {}),
      ...(isEmail ? {} : { prompt: stagePromptLink("module-planner") }),
      signal,
    }),
  );

  let modulePlan: { modules: PageBlueprint["modules"]; moduleOrder: string[]; narrative: string };

  const fallbackPlan = {
    modules: plan.newModules.map((m) => ({
      name: m.name,
      description: m.description,
      contentBrief: "Generate appropriate content",
      layoutNotes: "Use responsive layout",
    })),
    moduleOrder: plan.newModules.map((m) => m.name),
    narrative: "Page generated from user request",
  };

  if (plannerResult.type !== "structured") {
    log.warn("page-architect", "Module planner: did not get structured output, using fallback");
    modulePlan = fallbackPlan;
  } else {
    const raw = plannerResult.data as Record<string, unknown>;
    // Validate expected shape — AI may return unexpected structures
    if (Array.isArray(raw?.modules) && raw.modules.length > 0) {
      modulePlan = raw as typeof modulePlan;
      modulePlan.moduleOrder = modulePlan.moduleOrder || modulePlan.modules.map((m) => m.name);
      modulePlan.narrative = modulePlan.narrative || "Page generated from user request";
    } else {
      log.warn("page-architect", "Module planner: structured output missing 'modules' array, using fallback", {
        keys: raw ? Object.keys(raw) : [],
      });
      modulePlan = fallbackPlan;
    }
    log.info("page-architect", "Module plan", {
      moduleCount: modulePlan.modules.length,
    });
  }

  modulePlan = sanitizeModulePlanNames(
    modulePlan,
    new Set(snapshot.modules.map((m) => m.moduleName)),
  );

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

/**
 * Run ONLY the Module Planner half (Stage 2b) against an already-computed design
 * system. The checkpoint gate (VIB-1877) splits the architect at the design seam:
 * `runDesignSystem` (2a) runs before the gate, then this runs on resume with the
 * parked design. Mirrors the 2b block inside `runPageArchitect` so the one-shot
 * path stays byte-identical.
 */
export async function runModulePlanner(
  userMessage: string,
  plan: PipelinePlan,
  snapshot: SessionSnapshot,
  designSystem: DesignSystemOutput,
  sharedCss: string,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  onEvent: (event: PipelineEvent) => void,
  signal?: AbortSignal,
): Promise<PageBlueprint> {
  const isEmail = plan.contentType === "email";
  const vars = designSystem.cssVariables;
  const thinkingBudget = resolveThinkingBudget(engine);

  onEvent({
    type: "agent_step",
    step: "designing",
    label: "Planning modules...",
  });

  const plannerPrompt = isEmail
    ? buildEmailModulePlannerPrompt(
        snapshot.themeName,
        vars || {},
        snapshot.brandAssets,
        plan.guidesNeeded,
      )
    : buildModulePlannerPrompt(
        snapshot.themeName,
        sharedCss,
        snapshot.brandAssets,
        plan.guidesNeeded,
      );

  let plannerUserContent = `## User Request\n${userMessage}`;
  if (plan.newModules.length > 0) {
    plannerUserContent += `\n\n## Planned Modules\n${plan.newModules.map((m, i) => `${i + 1}. **${m.name}** — ${m.description}`).join("\n")}`;
  }

  if (snapshot.modules.length > 0) {
    const affected = new Set(plan.affectedModules);
    const modifying = snapshot.modules.filter((m) => affected.has(m.moduleName));
    const keeping = snapshot.modules.filter((m) => !affected.has(m.moduleName));

    if (modifying.length > 0) {
      plannerUserContent +=
        `\n\n## Existing Modules to Re-plan (PRESERVE THESE EXACT NAMES)\n` +
        `These already exist and are being regenerated. Your output's module names MUST match these exactly — do NOT rename, retitle-case, or "improve" them. Their content/layout may change; their identifier must not.\n` +
        modifying.map((m) => `- \`${m.moduleName}\``).join("\n");
    }

    if (keeping.length > 0) {
      plannerUserContent +=
        `\n\n## Existing Modules to Keep (do not re-plan)\n` +
        `These stay as-is. Do NOT include them in your output. They will appear in the final \`moduleOrder\` (you can reference them by name when you list it).\n` +
        keeping.map((m) => `- \`${m.moduleName}\``).join("\n");
    }
  }

  const plannerResult = await runWithSpan("module-planner", () =>
    callAgent(engine, apiKey, model, {
      systemPrompt: plannerPrompt,
      messages: [{ role: "user", content: plannerUserContent }],
      structuredOutput: {
        schema: MODULE_PLANNER_SCHEMA as unknown as Record<string, unknown>,
        name: "module_plan",
      },
      maxTokens: 8000,
      ...(thinkingBudget > 0 ? { thinkingBudgetTokens: thinkingBudget } : {}),
      ...(isEmail ? {} : { prompt: stagePromptLink("module-planner") }),
      signal,
    }),
  );

  let modulePlan: { modules: PageBlueprint["modules"]; moduleOrder: string[]; narrative: string };

  const fallbackPlan = {
    modules: plan.newModules.map((m) => ({
      name: m.name,
      description: m.description,
      contentBrief: "Generate appropriate content",
      layoutNotes: "Use responsive layout",
    })),
    moduleOrder: plan.newModules.map((m) => m.name),
    narrative: "Page generated from user request",
  };

  if (plannerResult.type !== "structured") {
    log.warn("page-architect", "Module planner: did not get structured output, using fallback");
    modulePlan = fallbackPlan;
  } else {
    const raw = plannerResult.data as Record<string, unknown>;
    if (Array.isArray(raw?.modules) && raw.modules.length > 0) {
      modulePlan = raw as typeof modulePlan;
      modulePlan.moduleOrder = modulePlan.moduleOrder || modulePlan.modules.map((m) => m.name);
      modulePlan.narrative = modulePlan.narrative || "Page generated from user request";
    } else {
      log.warn("page-architect", "Module planner: structured output missing 'modules' array, using fallback", {
        keys: raw ? Object.keys(raw) : [],
      });
      modulePlan = fallbackPlan;
    }
    log.info("page-architect", "Module plan", {
      moduleCount: modulePlan.modules.length,
    });
  }

  modulePlan = sanitizeModulePlanNames(
    modulePlan,
    new Set(snapshot.modules.map((m) => m.moduleName)),
  );

  onEvent({
    type: "agent_decision",
    step: "designing",
    decision: `Page: ${modulePlan.narrative} | ${modulePlan.modules.length} modules planned`,
  });

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
