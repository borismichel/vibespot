/**
 * Background process manager for long-running CLI operations
 * (tool installation, OAuth flows, etc.)
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessJob {
  id: string;
  command: string;
  description: string;
  status: "running" | "completed" | "failed";
  output: string;
  exitCode: number | null;
  startedAt: number;
  completedAt: number | null;
}

const jobs = new Map<string, ProcessJob>();

function _attachJobHandlers(child: ChildProcess, job: ProcessJob, timeout?: number): void {
  child.stdout?.on("data", (d: Buffer) => {
    job.output += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    job.output += d.toString();
  });

  child.on("close", (code) => {
    job.status = code === 0 ? "completed" : "failed";
    job.exitCode = code;
    job.completedAt = Date.now();
  });

  child.on("error", (err) => {
    job.status = "failed";
    job.output += `\nProcess error: ${err.message}`;
    job.completedAt = Date.now();
  });

  const t = timeout || 300_000;
  setTimeout(() => {
    if (job.status === "running") {
      child.kill();
      job.status = "failed";
      job.output += "\nProcess timed out";
      job.completedAt = Date.now();
    }
  }, t);
}

/**
 * Start a job safely using an argument array (no shell interpolation).
 * Preferred over the string overload to prevent command injection.
 */
export function startJobSafe(
  cmd: string,
  args: string[],
  description: string,
  opts?: { cwd?: string; env?: Record<string, string>; timeout?: number; stdin?: string }
): string {
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const job: ProcessJob = {
    id,
    command: `${cmd} ${args.join(" ")}`,
    description,
    status: "running",
    output: "",
    exitCode: null,
    startedAt: Date.now(),
    completedAt: null,
  };

  jobs.set(id, job);

  const child: ChildProcess = spawn(cmd, args, {
    cwd: opts?.cwd,
    stdio: [opts?.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    env: { ...process.env, ...opts?.env },
    // Windows needs shell to resolve .cmd/.bat from PATH; args array prevents injection
    shell: process.platform === "win32",
  });

  if (opts?.stdin && child.stdin) {
    child.stdin.write(opts.stdin);
    child.stdin.end();
  }

  _attachJobHandlers(child, job, opts?.timeout);
  return id;
}

export function startJob(
  command: string,
  description: string,
  opts?: { cwd?: string; env?: Record<string, string>; timeout?: number }
): string {
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const job: ProcessJob = {
    id,
    command,
    description,
    status: "running",
    output: "",
    exitCode: null,
    startedAt: Date.now(),
    completedAt: null,
  };

  jobs.set(id, job);

  const parts = command.split(" ");
  const child: ChildProcess = spawn(parts[0], parts.slice(1), {
    cwd: opts?.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...opts?.env },
    shell: true,
  });

  _attachJobHandlers(child, job, opts?.timeout);
  return id;
}

export function getJob(id: string): ProcessJob | undefined {
  return jobs.get(id);
}

export function cleanupOldJobs(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.completedAt && job.completedAt < cutoff) {
      jobs.delete(id);
    }
  }
}

// Clean up periodically
setInterval(cleanupOldJobs, 10 * 60 * 1000);

// ---------------------------------------------------------------------------
// Streaming jobs — same as regular jobs but also emit output chunks to listeners
// ---------------------------------------------------------------------------

export interface StreamingJob extends ProcessJob {
  listeners: Set<(chunk: string) => void>;
}

export function startStreamingJob(
  command: string,
  description: string,
  opts?: { cwd?: string; env?: Record<string, string>; timeout?: number }
): string {
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const job: StreamingJob = {
    id,
    command,
    description,
    status: "running",
    output: "",
    exitCode: null,
    startedAt: Date.now(),
    completedAt: null,
    listeners: new Set(),
  };

  jobs.set(id, job);

  const parts = command.split(" ");
  const child: ChildProcess = spawn(parts[0], parts.slice(1), {
    cwd: opts?.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...opts?.env },
    shell: true,
  });

  const emitChunk = (chunk: string) => {
    for (const listener of job.listeners) {
      try { listener(chunk); } catch { /* listener error — ignore */ }
    }
  };

  child.stdout?.on("data", (d: Buffer) => {
    const chunk = d.toString();
    job.output += chunk;
    emitChunk(chunk);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const chunk = d.toString();
    job.output += chunk;
    emitChunk(chunk);
  });

  child.on("close", (code) => {
    job.status = code === 0 ? "completed" : "failed";
    job.exitCode = code;
    job.completedAt = Date.now();
    job.listeners.clear();
  });

  child.on("error", (err) => {
    job.status = "failed";
    job.output += `\nProcess error: ${err.message}`;
    job.completedAt = Date.now();
    job.listeners.clear();
  });

  // Timeout safety net
  const timeout = opts?.timeout || 300_000;
  setTimeout(() => {
    if (job.status === "running") {
      child.kill();
      job.status = "failed";
      job.output += "\nProcess timed out";
      job.completedAt = Date.now();
      job.listeners.clear();
    }
  }, timeout);

  return id;
}

export function addJobListener(jobId: string, listener: (chunk: string) => void): void {
  const job = jobs.get(jobId);
  if (!job || !("listeners" in job)) return;

  const streamingJob = job as StreamingJob;

  // Send buffered output first
  if (streamingJob.output) {
    try { listener(streamingJob.output); } catch { /* ignore */ }
  }

  streamingJob.listeners.add(listener);
}

export function removeJobListener(jobId: string, listener: (chunk: string) => void): void {
  const job = jobs.get(jobId);
  if (!job || !("listeners" in job)) return;

  (job as StreamingJob).listeners.delete(listener);
}
