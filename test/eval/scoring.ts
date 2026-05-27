/**
 * Rule-based scoring for the eval harness (VIB-1768).
 *
 * Two rule-based axes (the LLM-as-judge fidelity axis lives in `judge.ts`):
 *
 *  1. Validator pass-rate — reuses the shipped `stages/validator.ts`. Run
 *     against the RAW module-developer output (before the pipeline's auto-fixer
 *     touches it), so it actually discriminates providers: a module "passes" if
 *     it has no *unfixable* issues (i.e. it would ship correctly), and is
 *     "clean" if it has zero issues at all. Auto-fixable issues (reserved field
 *     names, deprecated types, missing CSS prefix, unbalanced HubL) are counted
 *     as quality signal but don't fail a module.
 *
 *  2. Coverage — did the provider produce the module kinds the brief calls for?
 *     Matched structurally against `expectedModules` (name + content keywords).
 */

import type { ModuleFiles } from "../../src/ai/engine.js";
import type { EvalContentType, ExpectedModule } from "./dataset.js";
import {
  validateModules,
  type ValidationResult,
} from "../../src/server/agent/stages/validator.js";

export interface ValidityScore {
  moduleCount: number;
  /** Modules with zero issues of any kind. */
  cleanModules: number;
  /** Modules with at least one issue the auto-fixer cannot resolve. */
  modulesWithUnfixable: number;
  totalIssues: number;
  autoFixableIssues: number;
  unfixableIssues: number;
  /** Fraction of modules that would ship correctly (no unfixable issues). */
  passRate: number;
  /** Fraction of modules that were perfect on first generation. */
  cleanRate: number;
  /** Human-readable list of the distinct unfixable issues found. */
  unfixableSamples: string[];
}

/**
 * Score raw modules against the rule-based validator. `validateModules` returns
 * auto-fixed copies plus the issue list — we only read the issues, never the
 * fixed output, so this measures the provider's unaided correctness.
 */
export function scoreValidity(
  rawModules: ModuleFiles[],
  themeName: string,
  contentType?: EvalContentType,
): ValidityScore {
  if (rawModules.length === 0) {
    return {
      moduleCount: 0,
      cleanModules: 0,
      modulesWithUnfixable: 0,
      totalIssues: 0,
      autoFixableIssues: 0,
      unfixableIssues: 0,
      passRate: 0,
      cleanRate: 0,
      unfixableSamples: [],
    };
  }

  const results: ValidationResult[] = validateModules(
    rawModules,
    themeName,
    () => {},
    contentType === "page" ? undefined : contentType,
  );

  let cleanModules = 0;
  let modulesWithUnfixable = 0;
  let totalIssues = 0;
  let autoFixableIssues = 0;
  let unfixableIssues = 0;
  const unfixableSamples = new Set<string>();

  for (const r of results) {
    totalIssues += r.issues.length;
    const fixable = r.issues.filter((i) => i.autoFixed);
    const unfixable = r.issues.filter((i) => !i.autoFixed);
    autoFixableIssues += fixable.length;
    unfixableIssues += unfixable.length;
    if (r.issues.length === 0) cleanModules++;
    if (unfixable.length > 0) {
      modulesWithUnfixable++;
      for (const i of unfixable) unfixableSamples.add(`${i.module}: ${i.message}`);
    }
  }

  const moduleCount = results.length;
  return {
    moduleCount,
    cleanModules,
    modulesWithUnfixable,
    totalIssues,
    autoFixableIssues,
    unfixableIssues,
    passRate: (moduleCount - modulesWithUnfixable) / moduleCount,
    cleanRate: cleanModules / moduleCount,
    unfixableSamples: [...unfixableSamples].slice(0, 10),
  };
}

export interface CoverageScore {
  expectedCount: number;
  coveredCount: number;
  coverage: number;
  missing: string[];
}

/**
 * Structural coverage: for each expected section, count it covered when a
 * generated module's name OR its rendered text matches the section name or any
 * of its keywords. Lenient by design — we reward producing the right *kind* of
 * section, not exact naming.
 */
export function scoreCoverage(
  modules: ModuleFiles[],
  expected: ExpectedModule[],
): CoverageScore {
  const haystacks = modules.map((m) => ({
    name: m.moduleName.toLowerCase(),
    text: `${m.moduleName} ${m.moduleHtml} ${m.fieldsJson}`.toLowerCase(),
  }));

  const missing: string[] = [];
  let covered = 0;

  for (const exp of expected) {
    const needles = [exp.name, ...exp.keywords].map((k) => k.toLowerCase());
    const hit = haystacks.some((h) =>
      needles.some(
        (n) => h.name.includes(n.replace(/\s+/g, "-")) || h.text.includes(n),
      ),
    );
    if (hit) covered++;
    else missing.push(exp.name);
  }

  const expectedCount = expected.length;
  return {
    expectedCount,
    coveredCount: covered,
    coverage: expectedCount === 0 ? 1 : covered / expectedCount,
    missing,
  };
}

export interface JudgeScore {
  briefCoverage: number;
  layoutQuality: number;
  contentQuality: number;
  hubspotCorrectness: number;
  /** Mean of the four dimensions, normalised to 0–1. */
  overall: number;
  rationale: string;
}

/**
 * Blend the three axes into a single 0–1 accuracy figure. Weights favour
 * correctness (validator) and fidelity (judge) over structural coverage, which
 * is the coarsest signal. Documented in PROVIDER-COMPARISON.md.
 */
export function combineAccuracy(
  validity: ValidityScore,
  coverage: CoverageScore,
  judge: JudgeScore | null,
): number {
  const w = judge
    ? { validity: 0.4, coverage: 0.2, judge: 0.4 }
    : { validity: 0.65, coverage: 0.35, judge: 0 };
  return (
    w.validity * validity.passRate +
    w.coverage * coverage.coverage +
    w.judge * (judge?.overall ?? 0)
  );
}
