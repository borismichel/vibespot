/**
 * Entry point for the single-file binary built with `bun build --compile`.
 *
 * Extracts the embedded asset bundle (assets/, ui/, starters/, package.json,
 * CHANGELOG.md) into `~/.vibespot/runtime-assets/<version>/` on first run,
 * sets VIBESPOT_RUNTIME_ROOT so the rest of the codebase can locate them,
 * then hands off to the regular Commander program.
 *
 * Re-running with the same package version is a no-op (a `.ready` marker
 * file short-circuits extraction). Override the cache directory with the
 * VIBESPOT_RUNTIME_CACHE env var when debugging.
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RUNTIME_FILES, RUNTIME_VERSION } from "../scripts/.generated/runtime-manifest.js";

declare const Bun: { file(path: string): { arrayBuffer(): Promise<ArrayBuffer> } };

async function ensureRuntimeAssets(): Promise<string> {
  const cacheRoot =
    process.env.VIBESPOT_RUNTIME_CACHE ||
    join(homedir(), ".vibespot", "runtime-assets");
  const root = join(cacheRoot, RUNTIME_VERSION);
  const marker = join(root, ".ready");

  if (existsSync(marker)) return root;

  mkdirSync(root, { recursive: true });
  for (const [logicalPath, virtualPath] of Object.entries(RUNTIME_FILES)) {
    const dest = join(root, logicalPath);
    mkdirSync(dirname(dest), { recursive: true });
    const buf = new Uint8Array(await Bun.file(virtualPath).arrayBuffer());
    writeFileSync(dest, buf);
  }

  writeFileSync(marker, RUNTIME_VERSION);
  return root;
}

const root = await ensureRuntimeAssets();
process.env.VIBESPOT_RUNTIME_ROOT = root;

await import("../src/index.js");
