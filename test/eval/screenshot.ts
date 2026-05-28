/**
 * Optional full-page screenshots for the persistent-theme benchmark (VIB-1833).
 *
 * Screenshots are how we compare *visual fidelity* across models. They are
 * deliberately decoupled from generation: the benchmark always writes a
 * standalone `page.html` (persist.ts); this module turns those into PNGs **iff**
 * a headless browser is usable. It never blocks the benchmark — if Playwright is
 * absent or the browser can't launch (e.g. missing system libs in a sandbox),
 * it reports a skip reason and generation/KPIs are unaffected. Run the benchmark
 * where a browser works (or `npx playwright install --with-deps chromium`) to
 * fill in the PNGs.
 *
 * Playwright is imported dynamically so it stays out of the shipped bundle and
 * out of `package.json` deps — it is dev-only tooling.
 *
 * Sandbox escape hatch (VIB-1838): when Playwright's version-pinned browser can't
 * be downloaded (no network to its CDN) but a compatible Chromium / headless-shell
 * binary already exists, point `VIBESPOT_SHOT_CHROMIUM` at it to launch that
 * binary directly. If the host is missing Chromium's system libs and you can't
 * `apt-get install` them, pair it with `LD_LIBRARY_PATH` to a directory that
 * provides them (e.g. a Homebrew/linuxbrew `lib`). Both are no-ops when unset.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface ShotJob {
  htmlPath: string;
  pngPath: string;
}

export interface ShotOutcome {
  captured: number;
  skipped: number;
  /** Set when nothing could be captured — surfaced in the report + console. */
  unavailableReason?: string;
}

/** Width of the rendered viewport; full page height is captured automatically. */
const VIEWPORT_WIDTH = Number(process.env.VIBESPOT_SHOT_WIDTH) || 1280;

/** Try `playwright`, then `playwright-core`. Returns null if neither imports. */
async function loadChromium(): Promise<unknown | null> {
  for (const pkg of ["playwright", "playwright-core"]) {
    try {
      const mod = (await import(/* @vite-ignore */ pkg)) as { chromium?: unknown };
      if (mod?.chromium) return mod.chromium;
    } catch {
      /* not installed — try next */
    }
  }
  return null;
}

/**
 * Capture full-page PNGs for the given HTML files. Best-effort: returns counts
 * plus a skip reason if no browser was usable. Reuses one browser for the batch.
 */
export async function captureScreenshots(jobs: ShotJob[]): Promise<ShotOutcome> {
  if (jobs.length === 0) return { captured: 0, skipped: 0 };

  const chromium = (await loadChromium()) as {
    launch: (opts?: Record<string, unknown>) => Promise<Browser>;
  } | null;
  if (!chromium) {
    return {
      captured: 0,
      skipped: jobs.length,
      unavailableReason:
        "Playwright not installed — run `npm i -D playwright-core && npx playwright install chromium` (or run the benchmark where a browser is available).",
    };
  }

  // Optional explicit binary for sandboxes that can't download the pinned build.
  const exe = process.env.VIBESPOT_SHOT_CHROMIUM;
  const executablePath = exe && existsSync(exe) ? exe : undefined;

  let browser: Browser;
  try {
    browser = await chromium.launch({
      executablePath,
      args: ["--no-sandbox", "--hide-scrollbars"],
    });
  } catch (err) {
    return {
      captured: 0,
      skipped: jobs.length,
      unavailableReason: `Browser launch failed (${(err as Error).message?.split("\n")[0] ?? err}). On Linux: \`npx playwright install --with-deps chromium\`, or point \`VIBESPOT_SHOT_CHROMIUM\` at an existing Chromium binary.`,
    };
  }

  let captured = 0;
  let skipped = 0;
  try {
    const page = await browser.newPage({ viewport: { width: VIEWPORT_WIDTH, height: 900 } });
    for (const job of jobs) {
      try {
        await page.goto(pathToFileURL(job.htmlPath).href, { waitUntil: "networkidle", timeout: 30_000 });
        await page.screenshot({ path: job.pngPath, fullPage: true });
        captured++;
      } catch {
        skipped++;
      }
    }
    await page.close();
  } finally {
    await browser.close();
  }

  return { captured, skipped };
}

// Minimal structural types for the dynamically-imported Playwright surface.
interface Browser {
  newPage(opts?: Record<string, unknown>): Promise<Page>;
  close(): Promise<void>;
}
interface Page {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  screenshot(opts: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
