import { join } from "node:path";

/**
 * Single-file binaries built with `bun build --compile` extract bundled
 * assets to a per-user directory on first run, then export the path via
 * VIBESPOT_RUNTIME_ROOT. Callers that resolve packaged files (assets/, ui/,
 * starters/, package.json, CHANGELOG.md) should treat this as the highest-
 * priority candidate before falling back to package-relative or cwd paths.
 */
export function runtimeRootPath(...segments: string[]): string | null {
  const root = process.env.VIBESPOT_RUNTIME_ROOT;
  if (!root) return null;
  return join(root, ...segments);
}
