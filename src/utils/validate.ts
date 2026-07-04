/**
 * Input validation for values that cross a process or filesystem boundary.
 */

/**
 * A theme name is safe when it contains only letters, digits, spaces,
 * dots, underscores, and hyphens, starts with an alphanumeric, and has
 * no ".." sequence. This covers every name vibeSpot itself produces
 * (kebab-case slugs from setup, `_`-sanitized marketplace dir names)
 * while rejecting shell metacharacters and path traversal.
 *
 * Defense-in-depth: subprocesses receive the name as a literal argv
 * entry (runFile / startJobSafe), so this validation is the second
 * layer — it also protects the Windows path, where PATH resolution of
 * .cmd shims still involves a shell.
 */
export function isSafeThemeName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) &&
    !name.includes("..")
  );
}

export function assertSafeThemeName(name: string): void {
  if (!isSafeThemeName(name)) {
    throw new Error(
      "Theme name contains unsupported characters. Use letters, numbers, spaces, dots, underscores, and hyphens."
    );
  }
}
