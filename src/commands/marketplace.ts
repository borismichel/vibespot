import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { printBanner } from "../cli/banner.js";
import { theme } from "../cli/theme.js";
import * as ui from "../prompts/prompter.js";
import { loadConfig } from "../utils/config.js";
import {
  validateMarketplace,
  applyMarketplaceAutoFixes,
  readMarketplaceMeta,
  writeMarketplaceMeta,
  MARKETPLACE_CATEGORIES,
  type MarketplaceFinding,
  type MarketplaceMetadata,
  type MarketplaceReport,
} from "../server/marketplace.js";

interface MarketplaceCheckOpts {
  path?: string;
  json?: boolean;
  fix?: boolean;
}

export async function marketplaceCheckCommand(opts: MarketplaceCheckOpts = {}): Promise<void> {
  const themePath = await resolveThemePath(opts.path);

  if (opts.fix) {
    const fixResult = applyMarketplaceAutoFixes(themePath);
    if (fixResult.applied.length > 0) {
      ui.logSuccess(`Applied ${fixResult.applied.length} auto-fix${fixResult.applied.length === 1 ? "" : "es"}:`);
      for (const line of fixResult.applied) ui.log(`  ${line}`);
    } else {
      ui.log(theme.muted("No auto-fixable issues found."));
    }
    if (fixResult.skipped.length > 0) {
      for (const line of fixResult.skipped) ui.logWarn(line);
    }
  }

  const report = validateMarketplace(themePath);

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.passed) process.exit(1);
    return;
  }

  printBanner();
  await ui.intro("Marketplace check");

  const summary = `${report.errorCount} error${plural(report.errorCount)}, ${report.warningCount} warning${plural(report.warningCount)}, ${report.infoCount} note${plural(report.infoCount)}`;
  if (report.passed) {
    ui.logSuccess(`Theme passes Marketplace checks (${summary}).`);
  } else {
    ui.logError(`Theme is not yet ready: ${summary}.`);
  }

  printFindings("Errors", report.findings.filter((f) => f.severity === "error"));
  printFindings("Warnings", report.findings.filter((f) => f.severity === "warning"));
  printFindings("Notes", report.findings.filter((f) => f.severity === "info"));

  if (!report.passed) {
    ui.log("");
    ui.log(`Tip: run ${theme.accent("vibespot marketplace check --fix")} to apply auto-fixable issues, then re-check.`);
    process.exit(1);
  }

  await ui.outro("Looks good! Submit the theme via your HubSpot Marketplace dashboard.");
}

interface MarketplaceEditOpts {
  path?: string;
}

export async function marketplaceEditCommand(opts: MarketplaceEditOpts = {}): Promise<void> {
  const themePath = await resolveThemePath(opts.path);

  printBanner();
  await ui.intro("Marketplace listing details");

  const existing = readMarketplaceMeta(themePath) ?? {};

  const category = await ui.select<string>({
    message: "Category",
    options: MARKETPLACE_CATEGORIES.map((c) => ({ value: c, label: c })),
  });

  const description = await ui.text({
    message: "Description (1–2 sentences shown on the listing)",
    placeholder: "A clean, fast SaaS landing page theme...",
    defaultValue: existing.description ?? "",
    validate: (v) => (v.trim().length < 40 ? "Aim for at least 40 characters." : undefined),
  });

  const featuresRaw = await ui.text({
    message: "Key features (comma-separated, 2–5 items)",
    placeholder: "Hero, Pricing, Testimonials, Footer",
    defaultValue: (existing.features ?? []).join(", "),
    validate: (v) => {
      const count = v.split(",").map((s) => s.trim()).filter(Boolean).length;
      if (count < 2) return "Provide at least 2 features.";
      if (count > 5) return "Provide at most 5 features.";
      return undefined;
    },
  });
  const features = featuresRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const supportUrl = await ui.text({
    message: "Public support URL",
    placeholder: "https://example.com/support",
    defaultValue: existing.supportUrl ?? "",
    validate: (v) => (v && !/^https?:\/\//i.test(v) ? "Must start with http(s)://" : undefined),
  });

  const documentationUrl = await ui.text({
    message: "Documentation URL (optional)",
    placeholder: "https://example.com/docs",
    defaultValue: existing.documentationUrl ?? "",
    validate: (v) => (v && !/^https?:\/\//i.test(v) ? "Must start with http(s)://" : undefined),
  });

  const pricingTier = await ui.select<"free" | "paid">({
    message: "Pricing tier",
    options: [
      { value: "free", label: "Free" },
      { value: "paid", label: "Paid" },
    ],
  });

  const meta: MarketplaceMetadata = {
    category,
    description: description.trim(),
    features,
    supportUrl: supportUrl.trim() || undefined,
    documentationUrl: documentationUrl.trim() || undefined,
    pricingTier,
    tags: existing.tags,
  };

  writeMarketplaceMeta(themePath, meta);
  ui.logSuccess("Saved marketplace.json");

  await ui.outro(`Run ${theme.accent("vibespot marketplace check")} to confirm the theme is ready to submit.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    message: "Path to your HubSpot theme directory:",
    placeholder: "./my-theme",
    validate: (v) => (v.trim() ? undefined : "Path is required"),
  });
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`Theme not found: ${abs}`);
  return abs;
}

function printFindings(heading: string, findings: MarketplaceFinding[]): void {
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

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
