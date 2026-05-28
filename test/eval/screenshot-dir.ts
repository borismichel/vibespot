/**
 * Backfill screenshots into an existing benchmark run (VIB-1833).
 *
 * The benchmark separates generation from screenshots: `page.html` + themes +
 * KPIs land even when no browser is available (e.g. a sandbox without Chromium
 * system libs). This fills in the PNGs afterwards — point it at a run directory
 * once a browser exists and it captures `page.png` next to each saved
 * `page.html`, then re-renders `OVERVIEW.md` with the screenshot gallery.
 *
 *   npm i -D playwright-core && npx playwright install --with-deps chromium
 *   npx tsx test/eval/screenshot-dir.ts --dir=test/eval/benchmark-output/<runStamp>
 *
 * No regeneration, no model spend — purely renders the already-saved pages.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { captureScreenshots, type ShotJob } from "./screenshot.js";
import { renderOverview, type BenchmarkReport } from "./benchmark-report.js";

async function main(): Promise<void> {
  const dirArg = process.argv.slice(2).find((a) => a.startsWith("--dir="));
  if (!dirArg) {
    console.error("usage: tsx test/eval/screenshot-dir.ts --dir=<benchmark run dir>");
    process.exit(1);
  }
  const dir = resolve(dirArg.slice(6));
  const reportPath = join(dir, "benchmark.json");
  if (!existsSync(reportPath)) {
    console.error(`No benchmark.json in ${dir}`);
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as BenchmarkReport;

  // One job per saved page.html (skip records that errored / have no artifacts).
  const jobs: ShotJob[] = [];
  for (const r of report.records) {
    if (r.error) continue;
    const htmlPath = join(dir, r.modelSlug, r.itemId, "page.html");
    if (existsSync(htmlPath)) {
      jobs.push({ htmlPath, pngPath: join(dir, r.modelSlug, r.itemId, "page.png") });
    }
  }

  if (jobs.length === 0) {
    console.error("No page.html files found to screenshot.");
    process.exit(1);
  }

  console.log(`Capturing ${jobs.length} screenshot(s) from ${dir} …`);
  const shot = await captureScreenshots(jobs);
  console.log(`${shot.captured} captured, ${shot.skipped} skipped`);
  if (shot.unavailableReason) {
    console.error(`Screenshots unavailable: ${shot.unavailableReason}`);
    process.exit(2);
  }

  // Re-render the overview with the gallery now that PNGs exist.
  report.screenshotsAvailable = true;
  report.notes = report.notes.filter((n) => !n.startsWith("Screenshots skipped:"));
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "OVERVIEW.md"), renderOverview(report));
  console.log(`Updated ${join(dir, "OVERVIEW.md")} with the screenshot gallery.`);
}

main().catch((err) => {
  console.error("screenshot-dir failed:", err);
  process.exit(1);
});
