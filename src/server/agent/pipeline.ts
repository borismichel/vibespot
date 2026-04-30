/**
 * Agentic Pipeline Orchestrator
 *
 * Runs the 4-stage pipeline:
 * 1. Intent Analyzer — classify request, plan modules
 * 2. Page Architect — design system + module specs (new pages / design changes only)
 * 3. Module Developer — parallel per-module generation
 * 4. Validator — rule-based checks + auto-fix
 */

import type { ModuleFiles } from "../../ai/engine.js";
import type { SessionSnapshot } from "../session/types.js";
import type { AgentEngine } from "./engine-adapter.js";
import { isCLIEngine } from "./engine-adapter.js";
import type {
  PipelineEvent,
  PipelineResult,
  ModuleSpec,
  PageBlueprint,
} from "./types.js";
import { runIntentAnalyzer } from "./stages/intent-analyzer.js";
import { runPageArchitect } from "./stages/page-architect.js";
import { runModuleDeveloper } from "./stages/module-developer.js";
import { validateModules } from "./stages/validator.js";
import { log } from "../log.js";
import { execSync } from "node:child_process";

export { isAgenticCapable, isCLIEngine } from "./engine-adapter.js";

/**
 * Run the full agentic pipeline for a user message.
 *
 * @param userMessage  The user's chat message
 * @param snapshot     Immutable copy of session state at pipeline start
 * @param engine       Which API engine to use
 * @param apiKey       API key for the engine
 * @param model        Model ID
 * @param concurrency  Max parallel module generation calls
 * @param onEvent      Callback for pipeline progress events (WebSocket)
 * @param libraryModules  Modules available for reuse from other templates
 */
export async function runAgentPipeline(
  userMessage: string,
  snapshot: SessionSnapshot,
  engine: AgentEngine,
  apiKey: string,
  model: string,
  concurrency: number,
  onEvent: (event: PipelineEvent) => void,
  libraryModules: { name: string; usedIn: string[] }[],
): Promise<PipelineResult> {
  const startTime = Date.now();

  // All engines use the configured concurrency (default 20, cap in ai-handler)
  const effectiveConcurrency = concurrency;

  if (isCLIEngine(engine)) {
    const binMap: Record<string, string> = {
      "claude-code": "claude",
      "gemini-cli": "gemini",
      "codex-cli": "codex",
    };
    const bin = binMap[engine];
    if (bin) {
      try {
        execSync(`command -v ${bin}`, { stdio: "ignore" });
      } catch {
        throw new Error(
          `CLI engine "${engine}" requires "${bin}" to be installed and on your PATH.`,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Stage 1: Intent Analyzer
  // -----------------------------------------------------------------------

  const plan = await runIntentAnalyzer(
    userMessage,
    snapshot,
    engine,
    apiKey,
    model,
    onEvent,
    libraryModules,
  );

  // Short-circuit for questions
  if (plan.intent === "question" && plan.answer) {
    const durationMs = Date.now() - startTime;
    onEvent({
      type: "pipeline_complete",
      modulesGenerated: 0,
      modulesUnchanged: snapshot.modules.length,
      durationMs,
      answer: plan.answer,
    });
    return {
      modules: [...snapshot.modules],
      moduleOrder: snapshot.moduleOrder as string[],
      sharedCss: snapshot.sharedCss,
      sharedJs: snapshot.sharedJs,
      assistantMessage: plan.answer,
      stats: {
        modulesGenerated: 0,
        modulesUnchanged: snapshot.modules.length,
        modulesFailed: 0,
        durationMs,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Stage 2: Page Architect (new pages or design system changes)
  // -----------------------------------------------------------------------

  let blueprint: PageBlueprint | null = null;
  let sharedCss = snapshot.sharedCss;
  let sharedJs = snapshot.sharedJs;

  const needsArchitect =
    plan.intent === "create" || plan.designSystemChanges;

  if (needsArchitect) {
    // Stage 2 now runs two sequential calls:
    // 2a: Design System (CSS vars + shared CSS/JS) — emits design_system_ready
    // 2b: Module Planner (module specs + order) — uses the finalized CSS
    blueprint = await runPageArchitect(
      userMessage,
      plan,
      snapshot,
      engine,
      apiKey,
      model,
      onEvent,
    );
    if (plan.contentType !== "email") {
      sharedCss = blueprint.designSystem.sharedCss || sharedCss;
      sharedJs = blueprint.designSystem.sharedJs || sharedJs;
    }

    // Notify client of module order for incremental preview placeholders
    onEvent({
      type: "blueprint_ready",
      moduleOrder: blueprint.moduleOrder,
      sharedCss,
      sharedJs,
    });
  }

  // -----------------------------------------------------------------------
  // Build module specs for Stage 3
  // -----------------------------------------------------------------------

  const moduleSpecs: ModuleSpec[] = [];

  // New modules from the plan
  if (blueprint) {
    for (const bpMod of blueprint.modules) {
      moduleSpecs.push({
        name: bpMod.name,
        description: bpMod.description,
        contentBrief: bpMod.contentBrief,
        layoutNotes: bpMod.layoutNotes,
      });
    }
  } else {
    // No blueprint — build specs from plan
    for (const newMod of plan.newModules) {
      moduleSpecs.push({
        name: newMod.name,
        description: newMod.description,
        contentBrief: "Generate appropriate content based on the user request",
        layoutNotes: "Use responsive layout matching the existing design system",
      });
    }

    // Affected existing modules (modifications)
    for (const modName of plan.affectedModules) {
      const existing = snapshot.modules.find(
        (m) => m.moduleName === modName,
      );
      if (existing) {
        moduleSpecs.push({
          name: modName,
          description: `Modify existing module: ${modName}`,
          contentBrief: "Apply the user's requested changes",
          layoutNotes: "Preserve existing layout unless changes are requested",
          existingCode: existing,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Stage 3: Module Developer (parallel)
  // -----------------------------------------------------------------------

  let generatedModules: ModuleFiles[] = [];
  let failedModules: string[] = [];

  if (moduleSpecs.length > 0) {
    const devResults = await runModuleDeveloper(
      userMessage,
      moduleSpecs,
      sharedCss,
      snapshot.themeName,
      engine,
      apiKey,
      model,
      effectiveConcurrency,
      onEvent,
      plan.guidesNeeded,
      snapshot.brandAssets,
      plan.contentType,
    );

    for (const r of devResults) {
      if (r.module) {
        generatedModules.push(r.module);
      } else {
        failedModules.push(r.moduleName);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Stage 4: Quality Check
  // -----------------------------------------------------------------------

  let validationResults: import("./stages/validator.js").ValidationResult[] | null = null;

  if (generatedModules.length > 0) {
    validationResults = validateModules(
      generatedModules,
      snapshot.themeName,
      onEvent,
      plan.contentType,
    );

    // Replace generated modules with validated/auto-fixed versions
    generatedModules = validationResults.map((r) => r.module);

    // Log quality check summary with details
    const totalIssues = validationResults.reduce(
      (sum, r) => sum + r.issues.length,
      0,
    );
    if (totalIssues > 0) {
      const autoFixed = validationResults.reduce(
        (sum, r) => sum + r.issues.filter((i) => i.autoFixed).length,
        0,
      );
      log.info("pipeline", `Quality check: ${totalIssues} issues, ${autoFixed} auto-fixed`);

      // Build detailed issue list for the user
      const issueDetails = validationResults
        .flatMap((r) => r.issues)
        .map((i) => `${i.autoFixed ? "✓" : "⚠"} ${i.module}: ${i.message}`)
        .join("\n");

      onEvent({
        type: "agent_decision",
        step: "quality_check",
        decision: `${totalIssues} issues found, ${autoFixed} auto-fixed\n${issueDetails}`,
      });
    } else {
      onEvent({
        type: "agent_decision",
        step: "quality_check",
        decision: "All modules passed quality checks",
      });
    }
  }

  // -----------------------------------------------------------------------
  // Assemble final module list
  // -----------------------------------------------------------------------

  const finalModules = assembleModuleList(
    snapshot,
    plan,
    generatedModules,
    blueprint,
    libraryModules,
  );

  // Build module order (reconciles any missing modules automatically)
  const moduleOrder = buildModuleOrder(
    snapshot,
    plan,
    blueprint,
    finalModules,
  );

  // Warn if moduleOrder was missing modules (reconciled in buildModuleOrder)
  if (blueprint?.moduleOrder?.length) {
    const blueprintSet = new Set(blueprint.moduleOrder);
    const missing = finalModules
      .filter((m) => !blueprintSet.has(m.moduleName))
      .map((m) => m.moduleName);
    if (missing.length > 0) {
      onEvent({
        type: "agent_decision",
        step: "quality_check",
        decision: `⚠ ${missing.length} module${missing.length === 1 ? "" : "s"} missing from page order — auto-inserted: ${missing.join(", ")}`,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Build assistant message
  // -----------------------------------------------------------------------

  const durationMs = Date.now() - startTime;
  const modulesGenerated = generatedModules.length;
  const modulesUnchanged = plan.unchangedModules.length;

  const validationIssues = validationResults
    ? validationResults.flatMap((r) => r.issues)
    : [];

  const assistantMessage = buildAssistantMessage(
    plan,
    modulesGenerated,
    modulesUnchanged,
    failedModules,
    durationMs,
    blueprint,
    validationIssues,
  );

  // -----------------------------------------------------------------------
  // Emit completion event
  // -----------------------------------------------------------------------

  if (failedModules.length > 0) {
    onEvent({
      type: "pipeline_partial",
      succeeded: generatedModules.map((m) => m.moduleName),
      failed: failedModules,
      durationMs,
    });
  } else {
    onEvent({
      type: "pipeline_complete",
      modulesGenerated,
      modulesUnchanged,
      durationMs,
    });
  }

  return {
    modules: finalModules,
    moduleOrder,
    sharedCss,
    sharedJs,
    assistantMessage,
    stats: {
      modulesGenerated,
      modulesUnchanged,
      modulesFailed: failedModules.length,
      durationMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assemble the final module list by combining generated, unchanged, and reused modules.
 */
function assembleModuleList(
  snapshot: SessionSnapshot,
  plan: { unchangedModules: string[]; reuseModules?: { name: string; sourceTemplate: string; position: number }[] },
  generatedModules: ModuleFiles[],
  blueprint: PageBlueprint | null,
  libraryModules: { name: string; usedIn: string[]; module?: ModuleFiles }[],
): ModuleFiles[] {
  const result: ModuleFiles[] = [];
  const added = new Set<string>();

  // Add generated modules
  for (const mod of generatedModules) {
    result.push(mod);
    added.add(mod.moduleName);
  }

  // Add unchanged modules from snapshot
  for (const name of plan.unchangedModules) {
    if (added.has(name)) continue;
    const existing = snapshot.modules.find((m) => m.moduleName === name);
    if (existing) {
      result.push(existing as ModuleFiles);
      added.add(name);
    }
  }

  // Add reused modules from library
  if (plan.reuseModules) {
    for (const reuse of plan.reuseModules) {
      if (added.has(reuse.name)) continue;
      const libEntry = libraryModules.find(
        (l) => l.name === reuse.name && (l as { module?: ModuleFiles }).module,
      );
      if (libEntry && (libEntry as { module?: ModuleFiles }).module) {
        result.push((libEntry as { module: ModuleFiles }).module);
        added.add(reuse.name);
      }
    }
  }

  return result;
}

/**
 * Build the final module order.
 */
function buildModuleOrder(
  snapshot: SessionSnapshot,
  plan: { intent: string; newModules: { name: string; position: number }[]; reuseModules?: { name: string; position: number }[] },
  blueprint: PageBlueprint | null,
  finalModules: ModuleFiles[],
): string[] {
  // If blueprint provides order, use it — but reconcile with actual modules
  if (blueprint?.moduleOrder?.length) {
    const order = [...blueprint.moduleOrder];
    // Append any generated modules missing from the blueprint order
    // (AI sometimes drops modules from moduleOrder while still generating them)
    const orderSet = new Set(order);
    for (const mod of finalModules) {
      if (!orderSet.has(mod.moduleName)) {
        // Insert before footer if present, otherwise append
        const footerIdx = order.findIndex(
          (n) => n.toLowerCase().includes("footer"),
        );
        if (footerIdx !== -1) {
          order.splice(footerIdx, 0, mod.moduleName);
        } else {
          order.push(mod.moduleName);
        }
        orderSet.add(mod.moduleName);
        log.warn(
          "pipeline",
          `Module "${mod.moduleName}" missing from blueprint order — inserted`,
        );
      }
    }
    return order;
  }

  // For create intent, use the order from finalModules
  if (plan.intent === "create") {
    return finalModules.map((m) => m.moduleName);
  }

  // Start with existing order
  const order = [...(snapshot.moduleOrder as string[])];

  // Insert new modules at their specified positions
  const insertions = [
    ...plan.newModules.map((m) => ({ name: m.name, position: m.position })),
    ...(plan.reuseModules || []).map((m) => ({
      name: m.name,
      position: m.position,
    })),
  ].sort((a, b) => a.position - b.position);

  for (const ins of insertions) {
    const pos = Math.min(ins.position, order.length);
    order.splice(pos, 0, ins.name);
  }

  // Filter to only modules that exist in finalModules
  const moduleNames = new Set(finalModules.map((m) => m.moduleName));
  return order.filter((name) => moduleNames.has(name));
}

function buildAssistantMessage(
  plan: { intent: string; affectedModules: string[]; newModules: { name: string }[] },
  modulesGenerated: number,
  modulesUnchanged: number,
  failedModules: string[],
  durationMs: number,
  blueprint: PageBlueprint | null,
  validationIssues: { module: string; message: string; autoFixed: boolean }[],
): string {
  const seconds = Math.round(durationMs / 1000);
  const parts: string[] = [];

  if (plan.intent === "create") {
    parts.push(
      `Created ${modulesGenerated} module${modulesGenerated === 1 ? "" : "s"} in ${seconds}s.`,
    );
  } else if (plan.intent === "modify" || plan.intent === "style_change") {
    parts.push(
      `Updated ${modulesGenerated} module${modulesGenerated === 1 ? "" : "s"} in ${seconds}s.`,
    );
    if (modulesUnchanged > 0) {
      parts.push(`${modulesUnchanged} module${modulesUnchanged === 1 ? "" : "s"} unchanged.`);
    }
  } else if (plan.intent === "add") {
    const newNames = plan.newModules.map((m) => m.name).join(", ");
    parts.push(`Added ${newNames} in ${seconds}s.`);
  } else if (plan.intent === "remove") {
    parts.push(`Removed modules in ${seconds}s.`);
  } else if (plan.intent === "rearrange") {
    parts.push(`Rearranged modules in ${seconds}s.`);
  }

  // Add narrative summary from blueprint
  if (blueprint?.narrative) {
    parts.push(`\n\n${blueprint.narrative}`);
  }

  if (failedModules.length > 0) {
    parts.push(
      `\n\n**Failed:** ${failedModules.join(", ")}. You can retry these individually.`,
    );
  }

  // Add validation details
  const unfixed = validationIssues.filter((i) => !i.autoFixed);
  const fixed = validationIssues.filter((i) => i.autoFixed);
  if (fixed.length > 0 || unfixed.length > 0) {
    const valParts: string[] = [];
    if (fixed.length > 0) {
      valParts.push(`**Auto-fixed:** ${fixed.map((i) => `${i.module}: ${i.message}`).join(", ")}`);
    }
    if (unfixed.length > 0) {
      valParts.push(`**Warnings:** ${unfixed.map((i) => `${i.module}: ${i.message}`).join(", ")}`);
    }
    parts.push(`\n\n${valParts.join("\n")}`);
  }

  return parts.join("");
}
