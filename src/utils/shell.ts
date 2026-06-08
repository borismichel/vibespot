import {
  execSync,
  execFileSync,
  type ExecSyncOptions,
} from "node:child_process";

export interface ShellResult {
  stdout: string;
  stderr: string;
  success: boolean;
}

export function run(
  command: string,
  options: ExecSyncOptions = {}
): ShellResult {
  try {
    const stdout = execSync(command, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
      ...options,
    });
    return { stdout: stdout.toString().trim(), stderr: "", success: true };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = (e.stdout ?? "").toString().trim();
    const stderr = (e.stderr ?? "").toString().trim();
    return { stdout, stderr, success: false };
  }
}

/**
 * Run `git` with arguments passed as an array — never via a shell.
 * Use this for any git operation that takes user-controlled input
 * (commit messages, refs, file paths, URLs). Each entry in `args`
 * is forwarded as a literal argv to git, so shell metacharacters
 * cannot be interpreted.
 */
export function runGit(
  args: string[],
  options: ExecSyncOptions = {}
): ShellResult {
  try {
    const out = execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
      ...options,
    });
    return { stdout: out.toString().trim(), stderr: "", success: true };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = (e.stdout ?? "").toString().trim();
    const stderr = (e.stderr ?? "").toString().trim();
    return { stdout, stderr, success: false };
  }
}

export function runOrThrow(
  command: string,
  options: ExecSyncOptions = {}
): string {
  return execSync(command, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120_000,
    ...options,
  }).toString().trim();
}

export function runPassthrough(
  command: string,
  options: ExecSyncOptions = {}
): boolean {
  try {
    execSync(command, {
      stdio: "inherit",
      timeout: 300_000,
      ...options,
    });
    return true;
  } catch {
    return false;
  }
}
