/**
 * LLM-as-judge fidelity scoring (VIB-1768).
 *
 * Scores the *shipped* page (post-pipeline modules) against the brief + rubric
 * on four 1–5 dimensions. The judge is a model call routed through the same
 * `callAgent` adapter as production, so its own token cost lands in the usage
 * collector and (when enabled) Langfuse — it's eval overhead, tracked
 * separately from the provider-under-test's cost.
 *
 * `mockJudge` is a deterministic heuristic used in offline/CI mode so the whole
 * harness runs without keys.
 */

import type { ModuleFiles } from "../../src/ai/engine.js";
import type { EvalItem } from "./dataset.js";
import type { JudgeScore } from "./scoring.js";
import {
  callAgent,
  type AgentEngine,
} from "../../src/server/agent/engine-adapter.js";

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    briefCoverage: {
      type: "integer",
      description:
        "1–5: how completely the page covers everything the brief asked for (all named sections present and on-topic).",
    },
    layoutQuality: {
      type: "integer",
      description:
        "1–5: structural and visual quality — sensible section order, responsive-looking layout, appropriate components.",
    },
    contentQuality: {
      type: "integer",
      description:
        "1–5: copy quality — specific and benefit-led, not generic buzzword soup; matches the brief's tone.",
    },
    hubspotCorrectness: {
      type: "integer",
      description:
        "1–5: correct HubSpot CMS usage — editable fields via {{ module.x }}, well-formed HubL, no obvious template errors.",
    },
    rationale: {
      type: "string",
      description: "One or two sentences justifying the scores.",
    },
  },
  required: [
    "briefCoverage",
    "layoutQuality",
    "contentQuality",
    "hubspotCorrectness",
    "rationale",
  ],
  additionalProperties: false,
};

const MAX_MODULE_CHARS = 1800;
const MAX_TOTAL_CHARS = 14000;

function renderModulesForJudge(modules: ModuleFiles[]): string {
  let total = 0;
  const parts: string[] = [];
  for (const m of modules) {
    const html =
      m.moduleHtml.length > MAX_MODULE_CHARS
        ? m.moduleHtml.slice(0, MAX_MODULE_CHARS) + "\n…[truncated]"
        : m.moduleHtml;
    const block = `### Module: ${m.moduleName}\nfields.json: ${m.fieldsJson.slice(0, 600)}\nHTML:\n${html}\n`;
    if (total + block.length > MAX_TOTAL_CHARS) {
      parts.push(`…[${modules.length - parts.length} more modules omitted]`);
      break;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.join("\n");
}

function clamp1to5(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(5, v));
}

function toJudgeScore(raw: Record<string, unknown>): JudgeScore {
  const briefCoverage = clamp1to5(raw.briefCoverage);
  const layoutQuality = clamp1to5(raw.layoutQuality);
  const contentQuality = clamp1to5(raw.contentQuality);
  const hubspotCorrectness = clamp1to5(raw.hubspotCorrectness);
  const overall =
    (briefCoverage + layoutQuality + contentQuality + hubspotCorrectness) / 20;
  return {
    briefCoverage,
    layoutQuality,
    contentQuality,
    hubspotCorrectness,
    overall,
    rationale: String(raw.rationale ?? ""),
  };
}

export interface JudgeConfig {
  engine: AgentEngine;
  apiKey: string;
  model: string;
}

/**
 * Score a generated page with an LLM judge. Returns `null` if the judge call
 * fails (the harness then falls back to rule-based-only accuracy).
 */
export async function judgePage(
  item: EvalItem,
  modules: ModuleFiles[],
  cfg: JudgeConfig,
): Promise<JudgeScore | null> {
  if (modules.length === 0) {
    return {
      briefCoverage: 1,
      layoutQuality: 1,
      contentQuality: 1,
      hubspotCorrectness: 1,
      overall: 0.2,
      rationale: "No modules were generated.",
    };
  }

  const systemPrompt =
    "You are a meticulous reviewer of HubSpot CMS landing pages. You grade a generated page against the brief it was built from. Be strict and specific. Score each dimension 1–5 (5 = excellent). Reward concrete, on-brief content; penalise generic filler, missing sections, and broken HubL.";

  const userMessage = `## Brief\n${item.brief}\n\n## What good looks like (rubric)\n${item.rubric}\n\n## Generated page (${modules.length} modules)\n${renderModulesForJudge(modules)}`;

  try {
    const result = await callAgent(cfg.engine, cfg.apiKey, cfg.model, {
      systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      structuredOutput: { schema: JUDGE_SCHEMA, name: "page_quality_score" },
      maxTokens: 1500,
    });
    if (result.type === "structured" && result.data && typeof result.data === "object") {
      return toJudgeScore(result.data as Record<string, unknown>);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Deterministic stand-in for the LLM judge used in `--mock` mode. Derives
 * plausible scores from cheap signals so the offline harness still exercises
 * the judge → accuracy path.
 */
export function mockJudge(item: EvalItem, modules: ModuleFiles[]): JudgeScore {
  const text = modules
    .map((m) => `${m.moduleName} ${m.moduleHtml}`.toLowerCase())
    .join(" ");

  const expectedHits = item.expectedModules.filter((e) =>
    [e.name, ...e.keywords].some((k) => text.includes(k.toLowerCase())),
  ).length;
  const briefCoverage = clamp1to5(
    1 + (4 * expectedHits) / Math.max(1, item.expectedModules.length),
  );

  const hasFields = modules.every((m) => /\{\{\s*module\./.test(m.moduleHtml));
  const hubspotCorrectness = clamp1to5(hasFields ? 5 : 3);

  const avgLen =
    modules.reduce((s, m) => s + m.moduleHtml.length, 0) /
    Math.max(1, modules.length);
  const layoutQuality = clamp1to5(avgLen > 400 ? 4 : 3);
  const contentQuality = clamp1to5(avgLen > 250 ? 4 : 3);

  return toJudgeScore({
    briefCoverage,
    layoutQuality,
    contentQuality,
    hubspotCorrectness,
    rationale: `[mock judge] ${expectedHits}/${item.expectedModules.length} expected sections detected; ${hasFields ? "all" : "not all"} modules use editable fields.`,
  });
}
