/**
 * Per-project local git — auto-commits, version history, rollback.
 * All operations are local-only. Git is optional; if unavailable,
 * every function degrades gracefully (returns null / false / []).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../utils/shell.js";

export interface GitCommitInfo {
  hash: string;       // short hash (7 chars)
  fullHash: string;   // full SHA
  message: string;    // first line of commit message
  timestamp: number;  // unix epoch ms
  date: string;       // ISO string for display
  changedFiles?: string[];   // file paths changed in this commit (relative to themePath)
  changedModules?: string[]; // unique module names extracted from changedFiles
}

// ---------------------------------------------------------------------------
// Git availability (cached)
// ---------------------------------------------------------------------------

/** Validate a git hash to prevent shell injection — must be hex only. */
function isValidHash(hash: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(hash);
}

let gitAvailableCache: boolean | null = null;

export function isGitAvailable(): boolean {
  if (gitAvailableCache !== null) return gitAvailableCache;
  const result = runGit(["--version"]);
  gitAvailableCache = result.success;
  return gitAvailableCache;
}

// ---------------------------------------------------------------------------
// Repo initialization
// ---------------------------------------------------------------------------

/**
 * Ensure a git repo exists in the theme directory.
 * Creates .gitignore, .vibespot/ dir, and initial commit if needed.
 * Safe to call multiple times (idempotent).
 */
export function ensureGitRepo(themePath: string): boolean {
  if (!isGitAvailable()) return false;

  // Already initialized
  if (existsSync(join(themePath, ".git"))) {
    ensureVibeSpotDir(themePath);
    return true;
  }

  // Init repo
  const init = runGit(["init"], { cwd: themePath });
  if (!init.success) {
    console.warn(`[project-git] git init failed in ${themePath}: ${init.stderr}`);
    return false;
  }

  // Create .gitignore
  writeGitIgnore(themePath);

  // Create .vibespot/ dir for chat persistence
  ensureVibeSpotDir(themePath);

  // Initial commit
  runGit(["add", "-A"], { cwd: themePath });
  runGit(["commit", "-m", "Initial theme"], { cwd: themePath });

  return true;
}

function ensureVibeSpotDir(themePath: string): void {
  const dir = join(themePath, ".vibespot");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeGitIgnore(themePath: string): void {
  const gitignorePath = join(themePath, ".gitignore");
  const lines = [".vibespot/", "node_modules/", ""];
  writeFileSync(gitignorePath, lines.join("\n"), "utf-8");
}

// ---------------------------------------------------------------------------
// Committing
// ---------------------------------------------------------------------------

/**
 * Stage all changes and commit with the given message.
 * Returns the short commit hash, or null if nothing to commit or error.
 */
export function commitThemeState(themePath: string, message: string): string | null {
  if (!isGitAvailable()) return null;
  if (!existsSync(join(themePath, ".git"))) return null;

  // Stage everything
  runGit(["add", "-A"], { cwd: themePath });

  // Check if there are staged changes
  const diff = runGit(["diff", "--cached", "--quiet"], { cwd: themePath });
  if (diff.success) return null; // exit 0 = nothing staged

  // Truncate message to 72 chars
  const truncated = message.length > 72
    ? message.slice(0, 69) + "..."
    : message;

  const commitResult = runGit(["commit", "-m", truncated], { cwd: themePath });
  if (!commitResult.success) {
    console.warn(`[project-git] commit failed: ${commitResult.stderr}`);
    return null;
  }

  // Get short hash
  const hashResult = runGit(["rev-parse", "--short", "HEAD"], { cwd: themePath });
  return hashResult.success ? hashResult.stdout : null;
}

/**
 * Stage only specific files and commit with a template-scoped message.
 * Used for per-template version history so rollback doesn't affect other templates.
 */
export function commitTemplateState(
  themePath: string,
  templateId: string,
  message: string,
  filePaths: string[]
): string | null {
  if (!isGitAvailable()) return null;
  if (!existsSync(join(themePath, ".git"))) return null;

  // Stage only the specified paths
  for (const fp of filePaths) {
    const fullPath = join(themePath, fp);
    if (existsSync(fullPath)) {
      runGit(["add", fp], { cwd: themePath });
    }
  }

  // Check if there are staged changes
  const diff = runGit(["diff", "--cached", "--quiet"], { cwd: themePath });
  if (diff.success) return null; // nothing staged

  // Build prefixed message: [templateId] user message
  const prefix = `[${templateId}] `;
  const maxMsg = 72 - prefix.length;
  const truncated = message.length > maxMsg
    ? message.slice(0, maxMsg - 3) + "..."
    : message;
  const fullMessage = prefix + truncated;

  const commitResult = runGit(["commit", "-m", fullMessage], { cwd: themePath });
  if (!commitResult.success) {
    console.warn(`[project-git] template commit failed: ${commitResult.stderr}`);
    return null;
  }

  const hashResult = runGit(["rev-parse", "--short", "HEAD"], { cwd: themePath });
  return hashResult.success ? hashResult.stdout : null;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Parse `git log --name-only` output (with our pipe-delimited header line per commit)
 * into commit info entries with changedFiles + extracted module names.
 */
function parseLogWithNames(stdout: string): GitCommitInfo[] {
  const commits: GitCommitInfo[] = [];
  let current: GitCommitInfo | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("COMMIT|")) {
      if (current) commits.push(current);
      const parts = line.slice("COMMIT|".length).split("|");
      if (parts.length < 4) { current = null; continue; }
      const timestamp = parseInt(parts[3], 10) * 1000;
      current = {
        hash: parts[0],
        fullHash: parts[1],
        message: parts[2],
        timestamp,
        date: new Date(timestamp).toISOString(),
        changedFiles: [],
        changedModules: [],
      };
    } else if (line && current) {
      current.changedFiles!.push(line);
    }
  }
  if (current) commits.push(current);

  // Derive unique changedModules from changedFiles (paths like modules/<name>.module/...).
  for (const c of commits) {
    if (!c.changedFiles) continue;
    const seen = new Set<string>();
    for (const fp of c.changedFiles) {
      const m = fp.match(/^modules\/([^/]+)\.module(?:\/|$)/);
      if (m) seen.add(m[1]);
    }
    c.changedModules = [...seen];
  }
  return commits;
}

/**
 * Get commit history (most recent first), including the list of files changed
 * in each commit so the UI can show "what changed" without an extra round-trip.
 */
export function getHistory(themePath: string, limit: number = 50): GitCommitInfo[] {
  if (!isGitAvailable()) return [];
  if (!existsSync(join(themePath, ".git"))) return [];
  const safeLimit = Number.isInteger(limit) && limit > 0 && limit < 1000 ? limit : 50;

  const result = runGit(
    ["log", "--name-only", "--pretty=format:COMMIT|%h|%H|%s|%at", "-n", String(safeLimit)],
    { cwd: themePath }
  );
  if (!result.success || !result.stdout.trim()) return [];

  return parseLogWithNames(result.stdout);
}

/**
 * Get commit history filtered to a specific template (by commit message prefix).
 */
export function getTemplateHistory(
  themePath: string,
  templateId: string,
  limit: number = 50
): GitCommitInfo[] {
  if (!isGitAvailable()) return [];
  if (!existsSync(join(themePath, ".git"))) return [];
  const safeLimit = Number.isInteger(limit) && limit > 0 && limit < 1000 ? limit : 50;

  const grepPattern = `\\[${templateId}\\]`;
  const result = runGit(
    ["log", `--grep=${grepPattern}`, "--name-only", "--pretty=format:COMMIT|%h|%H|%s|%at", "-n", String(safeLimit)],
    { cwd: themePath }
  );
  if (!result.success || !result.stdout.trim()) return [];

  return parseLogWithNames(result.stdout);
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Restore theme files to a specific commit's state.
 * Creates a new commit ("Rollback to: <original message>") to keep linear history.
 * Does NOT touch .vibespot/ (gitignored) — chat is preserved.
 */
export function rollbackToCommit(
  themePath: string,
  commitHash: string
): { success: boolean; error?: string } {
  if (!isGitAvailable()) return { success: false, error: "Git not available" };
  if (!existsSync(join(themePath, ".git"))) return { success: false, error: "Not a git repo" };

  if (!isValidHash(commitHash)) return { success: false, error: "Invalid commit hash" };

  // Verify commit exists
  const verify = runGit(["cat-file", "-t", commitHash], { cwd: themePath });
  if (!verify.success || verify.stdout.trim() !== "commit") {
    return { success: false, error: `Commit ${commitHash} not found` };
  }

  // Get original commit message
  const msgResult = runGit(["log", "--format=%s", "-1", commitHash], { cwd: themePath });
  const origMessage = msgResult.success ? msgResult.stdout : commitHash;

  // Restore all files from that commit
  const checkout = runGit(["checkout", commitHash, "--", "."], { cwd: themePath });
  if (!checkout.success) {
    return { success: false, error: `Checkout failed: ${checkout.stderr}` };
  }

  // Commit the rollback
  const rollbackMsg = `Rollback to: ${origMessage}`.slice(0, 72);
  runGit(["commit", "-m", rollbackMsg], { cwd: themePath });

  return { success: true };
}

/**
 * Restore only specific template files to a commit's state.
 * Other templates' files are left untouched.
 */
export function rollbackTemplateToCommit(
  themePath: string,
  templateId: string,
  commitHash: string,
  filePaths: string[]
): { success: boolean; error?: string } {
  if (!isGitAvailable()) return { success: false, error: "Git not available" };
  if (!existsSync(join(themePath, ".git"))) return { success: false, error: "Not a git repo" };

  if (!isValidHash(commitHash)) return { success: false, error: "Invalid commit hash" };

  // Verify commit exists
  const verify = runGit(["cat-file", "-t", commitHash], { cwd: themePath });
  if (!verify.success || verify.stdout.trim() !== "commit") {
    return { success: false, error: `Commit ${commitHash} not found` };
  }

  // Get original commit message
  const msgResult = runGit(["log", "--format=%s", "-1", commitHash], { cwd: themePath });
  const origMessage = msgResult.success ? msgResult.stdout : commitHash;

  // Restore only the specified paths from that commit
  let restored = 0;
  for (const fp of filePaths) {
    const checkout = runGit(["checkout", commitHash, "--", fp], { cwd: themePath });
    if (checkout.success) restored++;
  }

  if (restored === 0) {
    return { success: false, error: "No files could be restored from that commit" };
  }

  // Stage and commit the scoped rollback
  runGit(["add", "-A"], { cwd: themePath });
  const prefix = `[${templateId}] `;
  const rollbackMsg = `${prefix}Rollback to: ${origMessage}`.slice(0, 72);
  runGit(["commit", "-m", rollbackMsg], { cwd: themePath });

  return { success: true };
}
