import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { printBanner } from "../cli/banner.js";
import { theme } from "../cli/theme.js";
import * as ui from "../prompts/prompter.js";
import { loadConfig } from "../utils/config.js";
import {
  analyzeTheme,
  applyTokensToSharedCss,
  type InverseFinding,
} from "../server/inverse-analyzer.js";

interface InverseOpts {
  path?: string;
  json?: boolean;
  applyTokens?: boolean;
}

export async function inverseCommand(opts: InverseOpts = {}): Promise<void> {
  const themePath = await resolveThemePath(opts.path);
  const themeName = basename(themePath);

  if (opts.applyTokens) {
    const target = applyTokensToSharedCss(themePath, themeName);
    if (target) ui.logSuccess(`Wrote design tokens to ${target}`);
    else ui.log(theme.muted("Skipped: theme already has shared CSS or no tokens were inferred."));
  }

  const report = analyzeTheme(themePath);

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(0);
  }

  printBanner();
  await ui.intro("Inverse pipeline analyzer");

  const s = report.summary;
  ui.log(
    `${theme.heading("Summary")}  ${s.moduleCount} module(s), ${s.templateCount} template(s), ${s.orphanCount} orphan, ${s.paletteSize} colour(s), ${s.cssVarCount} CSS var(s), ${s.customMacroCount} macro(s)`,
  );

  if (report.designTokens.palette.length > 0) {
    ui.log("");
    ui.log(theme.heading("Palette (top by frequency)"));
    for (const c of report.designTokens.palette.slice(0, 6)) {
      const named = c.varName ? theme.muted(` (${c.varName})`) : "";
      ui.log(`  ${c.value}  ${theme.muted(`×${c.count}`)}${named}`);
    }
  }
  if (report.designTokens.fontFamilies.length > 0) {
    ui.log("");
    ui.log(theme.heading("Typography"));
    for (const f of report.designTokens.fontFamilies.slice(0, 4)) {
      ui.log(`  ${f}`);
    }
  }
  if (report.graph.templates.length > 0) {
    ui.log("");
    ui.log(theme.heading("Template → modules"));
    for (const t of report.graph.templates) {
      ui.log(`  ${t.id}: ${t.modules.length === 0 ? theme.muted("(empty)") : t.modules.join(", ")}`);
    }
  }
  if (report.graph.orphanModules.length > 0) {
    ui.log("");
    ui.log(theme.heading("Orphan modules"));
    for (const m of report.graph.orphanModules) ui.log(`  ${m}`);
  }

  printFindings("Errors", report.findings.filter((f) => f.severity === "error"));
  printFindings("Warnings", report.findings.filter((f) => f.severity === "warning"));
  printFindings("Notes", report.findings.filter((f) => f.severity === "info"));

  if (!opts.applyTokens && report.summary.cssVarCount === 0 && report.designTokens.palette.length > 0) {
    ui.log("");
    ui.log(`Tip: run ${theme.accent("vibespot inverse --apply-tokens")} to seed a :root block from the inferred palette.`);
  }

  await ui.outro("Analysis complete.");
  process.exit(0);
}

async function resolveThemePath(provided?: string): Promise<string> {
  if (provided) {
    const abs = resolve(provided);
    if (!existsSync(abs)) throw new Error(`Theme not found: ${abs}`);
    return abs;
  }
  const config = loadConfig();
  if (config.lastThemePath && existsSync(config.lastThemePath)) {
    return config.lastThemePath;
  }
  printBanner();
  const path = await ui.text({
    message: "Path to the imported HubSpot theme directory:",
    placeholder: "./my-theme",
    validate: (v) => (v.trim() ? undefined : "Path is required"),
  });
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`Theme not found: ${abs}`);
  return abs;
}

function printFindings(heading: string, findings: InverseFinding[]): void {
  if (findings.length === 0) return;
  ui.log("");
  ui.log(theme.heading(heading));
  for (const f of findings) {
    const where = f.file ? theme.muted(`[${f.file}] `) : "";
    const tag =
      f.severity === "error"
        ? theme.error("✗")
        : f.severity === "warning"
          ? theme.warn("!")
          : theme.muted("·");
    ui.log(`  ${tag} ${where}${f.message}`);
    if (f.fix) ui.log(`    ${theme.muted("→ " + f.fix)}`);
  }
}
