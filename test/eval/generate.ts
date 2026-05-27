/**
 * Page generation for the eval harness (VIB-1768).
 *
 *  - `makeRealGenerator` runs the real production pipeline (`runAgentPipeline`)
 *    inside a Langfuse trace, capturing the RAW module-developer output from
 *    `module_progress` events (before the auto-fixer) plus the post-pipeline
 *    final modules and the end-to-end latency.
 *  - `mockGenerator` produces deterministic modules offline so the harness runs
 *    in CI / without API keys. It injects provider-specific flaws so the sample
 *    comparison differentiates, and fires `reportModelUsage` with synthetic
 *    token counts so the real `computeCost` path is exercised.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleFiles } from "../../src/ai/engine.js";
import type { SessionSnapshot } from "../../src/server/session/types.js";
import type { PipelineEvent } from "../../src/server/agent/types.js";
import { runAgentPipeline } from "../../src/server/agent/pipeline.js";
import { runWithTrace, currentTraceId, reportModelUsage } from "../../src/server/langfuse.js";
import type { EvalItem } from "./dataset.js";
import type { Provider } from "./providers.js";

export interface GeneratedPage {
  /** Module-developer output before the pipeline's auto-fixer (scoring input). */
  rawModules: ModuleFiles[];
  /** Post-pipeline modules — what a user would actually receive (judge input). */
  finalModules: ModuleFiles[];
  moduleOrder: string[];
  /** End-to-end wall-clock latency for the page (pipeline `stats.durationMs`). */
  durationMs: number;
  /** Langfuse trace id, when tracing is enabled (for dataset-run linkage). */
  traceId?: string;
  failed: number;
}

export type PageGenerator = (
  item: EvalItem,
  provider: Provider,
) => Promise<GeneratedPage>;

export function themeNameFor(item: EvalItem, provider: Provider): string {
  return `eval-${provider.id}-${item.id}`;
}

function emptySnapshot(themeName: string): SessionSnapshot {
  return {
    modules: [],
    moduleOrder: [],
    sharedCss: "",
    sharedJs: "",
    messages: [],
    themeName,
    themePath: join(tmpdir(), "vibespot-eval", themeName),
  };
}

export function makeRealGenerator(concurrency: number): PageGenerator {
  return async (item, provider) => {
    const themeName = themeNameFor(item, provider);
    const snapshot = emptySnapshot(themeName);

    // Capture raw module output from progress events (pre auto-fix).
    const rawByName = new Map<string, ModuleFiles>();
    const onEvent = (event: PipelineEvent) => {
      if (event.type === "module_progress" && event.status === "complete" && event.moduleFiles) {
        rawByName.set(event.moduleFiles.moduleName, event.moduleFiles);
      }
    };

    const { result, traceId } = await runWithTrace(
      {
        name: "eval_generation",
        sessionId: themeName,
        input: item.brief,
        metadata: { provider: provider.id, engine: provider.engine, model: provider.model, evalItem: item.id },
        tags: ["vibespot", "eval", provider.id],
      },
      async () => {
        const tid = currentTraceId();
        const r = await runAgentPipeline(
          item.brief,
          snapshot,
          provider.engine,
          provider.apiKey,
          provider.model,
          concurrency,
          onEvent,
          [],
        );
        return { result: r, traceId: tid };
      },
    );

    return {
      rawModules: [...rawByName.values()],
      finalModules: result.modules,
      moduleOrder: result.moduleOrder,
      durationMs: result.stats.durationMs,
      traceId,
      failed: result.stats.modulesFailed,
    };
  };
}

// ---------------------------------------------------------------------------
// Mock generator — offline, deterministic, provider-differentiated.
// ---------------------------------------------------------------------------

type QualityTier = "high" | "medium" | "low";

const TIER_BY_PROVIDER: Record<string, QualityTier> = {
  anthropic: "high",
  langdock: "high",
  openai: "medium",
  gemini: "low",
};

/** Per-tier simulated page latency (ms) and a flaw profile for differentiation. */
const TIER_PROFILE: Record<QualityTier, { latencyMs: number; dropLastModule: boolean }> = {
  high: { latencyMs: 9200, dropLastModule: false },
  medium: { latencyMs: 7100, dropLastModule: false },
  low: { latencyMs: 5300, dropLastModule: true },
};

function mockModule(
  themeName: string,
  sectionName: string,
  tier: QualityTier,
): ModuleFiles {
  const prefix = `${themeName}-${sectionName}`;
  // Low tier leaves classes unprefixed (auto-fixable) and uses a deprecated
  // field type; medium uses a reserved field name; high is clean.
  const cls = tier === "low" ? sectionName : prefix;
  const fieldType = tier === "low" ? "textarea" : "text";
  const headlineFieldName = tier === "medium" ? "name" : "headline";

  const fields = [
    { name: headlineFieldName, type: "text", label: "Headline", default: `${sectionName} headline` },
    { name: "body_copy", type: fieldType, label: "Body", default: `Specific, benefit-led copy for the ${sectionName} section.` },
    { name: "cta", type: "link", label: "CTA", default: { url: { href: "#", type: "EXTERNAL" } } },
  ];

  // Low tier drops the closing tag on a conditional (auto-fixable: missing endif).
  const conditional =
    tier === "low"
      ? `{% if module.body_copy %}<p>{{ module.body_copy }}</p>`
      : `{% if module.body_copy %}<p>{{ module.body_copy }}</p>{% endif %}`;

  const html = `<section class="${cls}">
  <h2 class="${cls}__title">{{ module.${headlineFieldName} }}</h2>
  ${conditional}
  <a class="${cls}__cta" href="{{ module.cta.url.href }}">Learn more</a>
</section>`;

  const css = `.${cls} { padding: 64px 24px; }
.${cls}__title { font-size: 2rem; font-weight: 700; }
.${cls}__cta { display: inline-block; margin-top: 16px; }`;

  return {
    moduleName: sectionName,
    fieldsJson: JSON.stringify(fields, null, 2),
    metaJson: JSON.stringify({ host_template_types: ["PAGE"], is_available_for_new_content: true }, null, 2),
    moduleHtml: html,
    moduleCss: css,
  };
}

/** Simulate the pipeline's model calls so cost/usage flows through computeCost. */
function emitMockUsage(provider: Provider, moduleCount: number): void {
  const now = Date.now();
  const fire = (name: string, inTok: number, outTok: number, ms: number) => {
    reportModelUsage({
      engine: provider.engine,
      model: provider.model,
      name,
      usage: { inputTokens: inTok, outputTokens: outTok },
      startTime: new Date(now),
      endTime: new Date(now + ms),
      metadata: { mock: true },
    });
  };
  fire("intent_analysis", 3000, 300, 1200);
  fire("design_system", 8000, 2200, 2600);
  fire("module_plan", 6000, 1500, 1800);
  for (let i = 0; i < moduleCount; i++) fire("module_development", 6500, 1600, 1500);
}

export const mockGenerator: PageGenerator = async (item, provider) => {
  const themeName = themeNameFor(item, provider);
  const tier = TIER_BY_PROVIDER[provider.id] ?? "medium";
  const profile = TIER_PROFILE[tier];

  let sections = item.expectedModules.map((e) => e.name);
  if (profile.dropLastModule && sections.length > 1) {
    sections = sections.slice(0, -1); // low tier misses a section (coverage hit)
  }

  const rawModules = sections.map((s) => mockModule(themeName, s, tier));
  emitMockUsage(provider, rawModules.length);

  // "Final" = what the pipeline would ship; the auto-fixer resolves the
  // injected fixable flaws, so final modules are clean copies.
  const finalModules = rawModules.map((m) => ({
    ...m,
    fieldsJson: m.fieldsJson.replace(/"textarea"/g, '"text"').replace(/"name":\s*"name"/g, '"name": "item_name"'),
    moduleHtml: m.moduleHtml.includes("{% endif %}")
      ? m.moduleHtml
      : m.moduleHtml + "\n{% endif %}",
  }));

  return {
    rawModules,
    finalModules,
    moduleOrder: sections,
    durationMs: profile.latencyMs,
    failed: 0,
  };
};
