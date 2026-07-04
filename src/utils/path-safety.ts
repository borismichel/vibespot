/**
 * Path-safety helpers for filesystem operations whose path components come
 * from untrusted input — AI structured output (module names) or remote API
 * metadata (HubSpot file listings). VIB-1891.
 *
 * Two layers of defense:
 * 1. Sanitize names at the point they enter the system (`kebabModuleName`).
 * 2. Assert containment at every fs sink (`resolveModuleDir`,
 *    `resolveContainedPath`) so a name that slipped past sanitization —
 *    e.g. from a poisoned persisted session — can never write, read, or
 *    delete outside the intended directory.
 */

import { join, resolve, dirname, sep } from "node:path";

/**
 * Coerce a free-typed module name to the kebab-case charset the pipeline
 * requires (see CLAUDE.md "Module names"). Strips every character outside
 * [a-z0-9-], which makes the result safe as a single path segment: no
 * separators, no dots, no traversal. Empty/garbage input returns "".
 */
export function kebabModuleName(raw: string): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * True when `name` can be used as a single path segment: non-empty, no
 * separators, no null bytes, not a dot-directory. Deliberately looser than
 * the kebab charset — module names scanned from an imported HubSpot theme
 * (readdir basenames) may legitimately contain uppercase or underscores.
 */
export function isSafePathSegment(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  return !/[/\\\0]/.test(name);
}

/**
 * Resolve the on-disk directory for a module, `<modulesBaseDir>/<name>.module`,
 * asserting the result stays a direct child of the modules dir. Throws on any
 * name that would traverse or nest (`../x`, `a/b`, absolute paths, null bytes).
 */
export function resolveModuleDir(modulesBaseDir: string, moduleName: string): string {
  const base = resolve(modulesBaseDir);
  if (!isSafePathSegment(`${moduleName}.module`)) {
    throw new Error(`Unsafe module name rejected: ${JSON.stringify(moduleName)}`);
  }
  const dir = resolve(base, `${moduleName}.module`);
  if (dirname(dir) !== base || !dir.endsWith(".module")) {
    throw new Error(`Unsafe module name rejected: ${JSON.stringify(moduleName)}`);
  }
  return dir;
}

/**
 * Join `relativePath` under `baseDir` and assert the resolved result stays
 * inside `baseDir`. Returns the joined path; throws on escape. Use for
 * multi-segment relative paths from untrusted sources (zip-slip guard).
 */
export function resolveContainedPath(baseDir: string, relativePath: string): string {
  if (relativePath.includes("\0")) {
    throw new Error(`Unsafe path rejected: ${JSON.stringify(relativePath)}`);
  }
  const joined = join(baseDir, relativePath);
  const base = resolve(baseDir);
  const resolved = resolve(joined);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error(`Path escapes target directory: ${JSON.stringify(relativePath)}`);
  }
  return joined;
}
