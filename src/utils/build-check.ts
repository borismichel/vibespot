/**
 * Boot-time build-staleness detection (VIB-1939).
 *
 * The `vibespot` binary runs the tsup-built server bundle (`dist/index.js`),
 * but the static `ui/*` files are served straight from disk. A `git pull`
 * therefore updates the client immediately while the server's route table only
 * changes after `npm run build` regenerates `dist/`. A user who pulls new code
 * and restarts *without rebuilding* serves the NEW `ui/` against an OLD server
 * bundle — routes the new client calls (`/api/preview-origin`, `/api/whats-new`)
 * 404, and the preview silently goes dark.
 *
 * This turns that silent skew into a loud, one-line fix: if any source file is
 * newer than `dist/index.js`, the build is stale and we say so at boot.
 *
 * Guards:
 *  - npm-installed users ship a prebuilt `dist/` and NO `src/` (see the "files"
 *    field in package.json) — nothing to be newer than the build, so we never
 *    fire for them.
 *  - `npm run dev` (tsx on `src/`) never touches `dist/`, so a stale build is
 *    irrelevant there — we skip when running from source rather than the bundle.
 */

import { existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __owndir = dirname(fileURLToPath(import.meta.url));

export type StalenessReason =
  | "stale" // src is newer than dist/index.js → rebuild needed
  | "fresh" // build is up to date
  | "no-src" // npm-installed (no src/ shipped) — not applicable
  | "no-dist" // dist/index.js missing (never built) — bin already handles this
  | "dev-run"; // running from source (tsx), not the bundle — not applicable

export interface StalenessCheck {
  /** True only when a rebuild warning should be shown. */
  stale: boolean;
  reason: StalenessReason;
  distMtimeMs?: number;
  newestSrcMtimeMs?: number;
  /** The source path that is newer than the build, when stale. */
  newestSrcPath?: string;
}

const NOT_STALE = (reason: StalenessReason): StalenessCheck => ({ stale: false, reason });

/** Directories under src/ we never need to walk (none today, but cheap safety). */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Recursively find the newest mtime (and its path) under `dir`. */
function newestMtime(dir: string): { mtimeMs: number; path: string } {
  let newest = { mtimeMs: 0, path: dir };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = newestMtime(full);
      if (child.mtimeMs > newest.mtimeMs) newest = child;
    } else if (entry.isFile()) {
      try {
        const m = statSync(full).mtimeMs;
        if (m > newest.mtimeMs) newest = { mtimeMs: m, path: full };
      } catch {
        /* unreadable file — ignore */
      }
    }
  }
  return newest;
}

/**
 * Compare the built server bundle against its sources.
 *
 * @param rootOverride Package root to inspect (holds `dist/` and `src/`). When
 *   omitted, the root is resolved from this module's location and the check is
 *   skipped entirely when we are running from source rather than the bundle.
 */
export function checkBuildStaleness(rootOverride?: string): StalenessCheck {
  let root: string;
  if (rootOverride) {
    root = rootOverride;
  } else {
    // In the built bundle this file is inlined into `dist/index.js`, so
    // __owndir === "<root>/dist". Running from source (tsx) it is
    // "<root>/src/utils" — a stale dist is irrelevant there, so bail out.
    const fromDist = /[/\\]dist[/\\]?$/.test(__owndir) || __owndir.endsWith("dist");
    if (!fromDist) return NOT_STALE("dev-run");
    root = join(__owndir, "..");
  }

  const distEntry = join(root, "dist", "index.js");
  const srcDir = join(root, "src");

  // npm-installed users have dist/ but no src/ (see package.json "files").
  if (!existsSync(srcDir)) return NOT_STALE("no-src");
  // Never built — bin/vibespot.mjs already prints a "run npm run build" message.
  if (!existsSync(distEntry)) return NOT_STALE("no-dist");

  let distMtimeMs: number;
  try {
    distMtimeMs = statSync(distEntry).mtimeMs;
  } catch {
    return NOT_STALE("no-dist");
  }

  // Newest of: any file under src/, and package.json (version bumps).
  let newest = newestMtime(srcDir);
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    try {
      const m = statSync(pkg).mtimeMs;
      if (m > newest.mtimeMs) newest = { mtimeMs: m, path: pkg };
    } catch {
      /* ignore */
    }
  }

  // 1s slack absorbs same-second checkout/build ordering on coarse filesystems.
  if (newest.mtimeMs > distMtimeMs + 1000) {
    return {
      stale: true,
      reason: "stale",
      distMtimeMs,
      newestSrcMtimeMs: newest.mtimeMs,
      newestSrcPath: newest.path,
    };
  }
  return { stale: false, reason: "fresh", distMtimeMs, newestSrcMtimeMs: newest.mtimeMs };
}

/**
 * Print a loud, actionable rebuild warning when the build is stale. Called on
 * the boot path (`vibespot vibe`). No-op for npm installs, dev runs, and
 * up-to-date builds. `log` is injectable for testing.
 */
export function warnIfBuildStale(log: (msg: string) => void = console.warn): boolean {
  const result = checkBuildStaleness();
  if (!result.stale) return false;
  log(
    "\n  ⚠ Your build is older than the source you pulled.\n" +
      "    The server is running a stale bundle — new /api/* routes will 404 and\n" +
      "    the live preview may go dark. Run `npm run build` and restart.\n"
  );
  return true;
}
