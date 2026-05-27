/**
 * Site Module Planner stage for multi-page sites.
 *
 * Plans modules for ALL pages in a single AI call to ensure cross-page
 * coherence. Shared modules (header, footer) are planned once and
 * referenced by every page template.
 *
 * Runs after Design System (2a) and replaces the single-page Module
 * Planner (2b) when the intent is "create_site".
 */

import type { AgentEngine } from "../engine-adapter.js";
import { callAgent, resolveThinkingBudget } from "../engine-adapter.js";
import type {
  PipelinePlan,
  SiteBlueprint,
  SitePageBlueprint,
  PipelineEvent,
  ModuleSpec,
} from "../types.js";
import type { SessionSnapshot } from "../../session/types.js";
import {
  buildSiteModulePlannerPrompt,
  SITE_MODULE_PLANNER_SCHEMA,
} from "../prompts/site-module-planner.js";
import { log } from "../../log.js";
import { runWithSpan } from "../../langfuse.js";

export async function runSiteModulePlanner(
  userMessage: string,
  plan: PipelinePlan,
  snapshot: SessionSnapshot,
  sharedCss: string,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  onEvent: (event: PipelineEvent) => void,
): Promise<SiteBlueprint> {
  onEvent({
    type: "agent_step",
    step: "planning_site",
    label: `Planning modules for ${plan.pages?.length || 0} pages...`,
  });

  const pages = plan.pages || [];
  const sharedModuleNames = plan.sharedModules || ["site-header", "site-footer"];

  const systemPrompt = buildSiteModulePlannerPrompt(
    snapshot.themeName,
    pages,
    sharedModuleNames,
    sharedCss,
    snapshot.brandAssets,
  );

  const userContent = `## User Request\n${userMessage}\n\n## Site Map\n${pages.map((p) => `- ${p.label} (${p.slug}): ${p.purpose}`).join("\n")}`;

  const thinkingBudget = resolveThinkingBudget(engine);
  const result = await runWithSpan("site-module-planner", () =>
    callAgent(engine, apiKey, model, {
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
      structuredOutput: {
        schema: SITE_MODULE_PLANNER_SCHEMA as unknown as Record<string, unknown>,
        name: "site_module_plan",
      },
      maxTokens: 16000,
      ...(thinkingBudget > 0 ? { thinkingBudgetTokens: thinkingBudget } : {}),
    }),
  );

  if (result.type !== "structured") {
    log.warn("site-planner", "Did not get structured output, building fallback");
    return buildFallbackBlueprint(plan, sharedModuleNames, sharedCss);
  }

  const raw = result.data as Record<string, unknown>;

  if (!Array.isArray(raw?.pages) || !Array.isArray(raw?.sharedModules)) {
    log.warn("site-planner", "Structured output missing expected fields", {
      keys: raw ? Object.keys(raw) : [],
    });
    return buildFallbackBlueprint(plan, sharedModuleNames, sharedCss);
  }

  const sharedModuleSpecs = (raw.sharedModules as ModuleSpec[]).map((m) => ({
    name: m.name,
    description: m.description,
    contentBrief: m.contentBrief,
    layoutNotes: m.layoutNotes,
  }));

  const pageBlueprints: SitePageBlueprint[] = (raw.pages as SitePageBlueprint[]).map((p) => ({
    pageId: p.pageId,
    modules: (p.modules || []).map((m) => ({
      name: m.name,
      description: m.description,
      contentBrief: m.contentBrief,
      layoutNotes: m.layoutNotes,
    })),
    moduleOrder: p.moduleOrder || [],
  }));

  const totalModules = sharedModuleSpecs.length +
    pageBlueprints.reduce((sum, p) => sum + p.modules.length, 0);

  log.info("site-planner", "Site plan complete", {
    pages: pageBlueprints.length,
    sharedModules: sharedModuleSpecs.length,
    totalModules,
  });

  onEvent({
    type: "agent_decision",
    step: "planning_site",
    decision: `${pageBlueprints.length} pages planned, ${sharedModuleSpecs.length} shared modules, ${totalModules} total modules`,
  });

  onEvent({
    type: "site_blueprint_ready",
    pages: pageBlueprints.map((p) => {
      const page = pages.find((sp) => sp.id === p.pageId);
      return {
        pageId: p.pageId,
        label: page?.label || p.pageId,
        moduleCount: p.modules.length,
      };
    }),
    sharedModuleCount: sharedModuleSpecs.length,
  });

  return {
    designSystem: {
      cssVariables: {},
      sharedCss,
    },
    pages: pageBlueprints,
    sharedModules: sharedModuleSpecs,
    narrative: (raw.narrative as string) || "Multi-page site generated from user request",
  };
}

function buildFallbackBlueprint(
  plan: PipelinePlan,
  sharedModuleNames: string[],
  sharedCss: string,
): SiteBlueprint {
  const pages = plan.pages || [];

  return {
    designSystem: { cssVariables: {}, sharedCss },
    pages: pages.map((p) => ({
      pageId: p.id,
      modules: [
        {
          name: `${p.slug}-hero`,
          description: `Hero section for ${p.label}`,
          contentBrief: `Create a hero for the ${p.label} page: ${p.purpose}`,
          layoutNotes: "Use responsive layout matching the design system",
        },
        {
          name: `${p.slug}-content`,
          description: `Main content for ${p.label}`,
          contentBrief: `Create main content for the ${p.label} page: ${p.purpose}`,
          layoutNotes: "Use responsive layout matching the design system",
        },
      ],
      moduleOrder: [`${p.slug}-hero`, `${p.slug}-content`],
    })),
    sharedModules: sharedModuleNames.map((name) => ({
      name,
      description: `Shared ${name} module`,
      contentBrief: `Generate ${name} for the site`,
      layoutNotes: "Use responsive layout matching the design system",
    })),
    narrative: "Multi-page site (fallback plan)",
  };
}
