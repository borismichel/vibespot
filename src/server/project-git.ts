/**
 * Per-project local git — auto-commits, version history, rollback.
 * All operations are local-only. Git is optional; if unavailable,
 * every function degrades gracefully (returns null / false / []).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "../utils/shell.js";

export interface GitCommitInfo {
  hash: string;       // short hash (7 chars)
  fullHash: string;   // full SHA
  message: string;    // first line of commit message
  timestamp: number;  // unix epoch ms
  date: string;       // ISO string for display
}

// ---------------------------------------------------------------------------
// Git availability (cached)
// ---------------------------------------------------------------------------

let gitAvailableCache: boolean | null = null;

export function isGitAvailable(): boolean {
  if (gitAvailableCache !== null) return gitAvailableCache;
  const result = run("git --version");
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
  const init = run("git init", { cwd: themePath });
  if (!init.success) {
    console.warn(`[project-git] git init failed in ${themePath}: ${init.stderr}`);
    return false;
  }

  // Create .gitignore
  writeGitIgnore(themePath);

  // Create .vibespot/ dir for chat persistence
  ensureVibeSpotDir(themePath);

  // Initial commit
  run("git add -A", { cwd: themePath });
  run('git commit -m "Initial theme"', { cwd: themePath });

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
  run("git add -A", { cwd: themePath });

  // Check if there are staged changes
  const diff = run("git diff --cached --quiet", { cwd: themePath });
  if (diff.success) return null; // exit 0 = nothing staged

  // Truncate message to 72 chars
  const truncated = message.length > 72
    ? message.slice(0, 69) + "..."
    : message;

  // Commit (use -- to prevent message from being interpreted as flags)
  const commitResult = run(`git commit -m "${truncated.replace(/"/g, '\\"')}"`, { cwd: themePath });
  if (!commitResult.success) {
    console.warn(`[project-git] commit failed: ${commitResult.stderr}`);
    return null;
  }

  // Get short hash
  const hashResult = run("git rev-parse --short HEAD", { cwd: themePath });
  return hashResult.success ? hashResult.stdout : null;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Get commit history (most recent first).
 */
export function getHistory(themePath: string, limit: number = 50): GitCommitInfo[] {
  if (!isGitAvailable()) return [];
  if (!existsSync(join(themePath, ".git"))) return [];

  const result = run(
    `git log --pretty=format:"%h|%H|%s|%at" -n ${limit}`,
    { cwd: themePath }
  );
  if (!result.success || !result.stdout.trim()) return [];

  const commits: GitCommitInfo[] = [];
  for (const line of result.stdout.split("\n")) {
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const timestamp = parseInt(parts[3], 10) * 1000;
    commits.push({
      hash: parts[0],
      fullHash: parts[1],
      message: parts[2],
      timestamp,
      date: new Date(timestamp).toISOString(),
    });
  }
  return commits;
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

  // Verify commit exists
  const verify = run(`git cat-file -t ${commitHash}`, { cwd: themePath });
  if (!verify.success || verify.stdout.trim() !== "commit") {
    return { success: false, error: `Commit ${commitHash} not found` };
  }

  // Get original commit message
  const msgResult = run(`git log --format="%s" -1 ${commitHash}`, { cwd: themePath });
  const origMessage = msgResult.success ? msgResult.stdout : commitHash;

  // Restore all files from that commit
  const checkout = run(`git checkout ${commitHash} -- .`, { cwd: themePath });
  if (!checkout.success) {
    return { success: false, error: `Checkout failed: ${checkout.stderr}` };
  }

  // Commit the rollback
  const rollbackMsg = `Rollback to: ${origMessage}`.slice(0, 72);
  run(`git commit -m "${rollbackMsg.replace(/"/g, '\\"')}"`, { cwd: themePath });

  return { success: true };
}
