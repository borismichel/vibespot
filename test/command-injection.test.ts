/**
 * Regression tests for VIB-1890 — shell/command injection.
 *
 * Every process launch must pass user-controlled values as literal argv
 * entries (no shell interpolation). These tests feed shell-metacharacter
 * payloads through the helpers and assert they stay inert: the payload
 * arrives as a literal string and no side-effect command executes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runFile } from "../src/utils/shell.js";
import { isSafeThemeName } from "../src/utils/validate.js";
import { startJobSafe, startStreamingJob, getJob } from "../src/server/process-manager.js";

const tmp = mkdtempSync(join(tmpdir(), "vibespot-inj-"));
const marker = join(tmp, "pwned");

// The classic payloads from the VIB-1890 report: command substitution,
// backticks, quote-breaking, and newline smuggling.
const payloads = [
  `x"; touch ${marker}; echo "`,
  `$(touch ${marker})`,
  "`touch " + marker + "`",
  `x\ntouch ${marker}\n`,
];

afterEach(() => {
  rmSync(marker, { force: true });
});

async function waitForJob(id: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const job = getJob(id);
    if (job && job.status !== "running") return job.output;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job did not complete in time");
}

describe("isSafeThemeName", () => {
  it("accepts names vibeSpot produces", () => {
    expect(isSafeThemeName("my-theme")).toBe(true);
    expect(isSafeThemeName("My-Company-Theme")).toBe(true);
    expect(isSafeThemeName("_marketplace_Theme")).toBe(false); // leading non-alphanumeric
    expect(isSafeThemeName("theme 2.0")).toBe(true);
    expect(isSafeThemeName("a_b-c.d")).toBe(true);
  });

  it("rejects shell metacharacters and traversal", () => {
    for (const p of payloads) expect(isSafeThemeName(p)).toBe(false);
    expect(isSafeThemeName("../evil")).toBe(false);
    expect(isSafeThemeName("a;b")).toBe(false);
    expect(isSafeThemeName("a|b")).toBe(false);
    expect(isSafeThemeName("a&b")).toBe(false);
    expect(isSafeThemeName("a'b")).toBe(false);
    expect(isSafeThemeName('a"b')).toBe(false);
    expect(isSafeThemeName("")).toBe(false);
  });
});

describe("runFile (wizard hs cms fetch/upload/delete path)", () => {
  it("passes metacharacter args literally and executes nothing", () => {
    for (const p of payloads) {
      const result = runFile(process.execPath, ["-e", "process.stdout.write(process.argv[1])", p]);
      expect(result.success).toBe(true);
      expect(result.stdout).toBe(p.trim());
      expect(existsSync(marker)).toBe(false);
    }
  });
});

describe("startJobSafe / startStreamingJob (server job manager)", () => {
  it("startJobSafe keeps a malicious theme name inert", async () => {
    for (const p of payloads) {
      const id = startJobSafe(
        process.execPath,
        ["-e", "process.stdout.write(process.argv[1])", p],
        "injection probe"
      );
      const output = await waitForJob(id);
      expect(output).toBe(p);
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("startStreamingJob keeps a malicious theme name inert", async () => {
    for (const p of payloads) {
      const id = startStreamingJob(
        process.execPath,
        ["-e", "process.stdout.write(process.argv[1])", p],
        "injection probe"
      );
      const output = await waitForJob(id);
      expect(output).toBe(p);
      expect(existsSync(marker)).toBe(false);
    }
  });
});

describe("no unconditional shell spawns remain", () => {
  it("string-based startJob is gone from the process manager", async () => {
    const mod = await import("../src/server/process-manager.js");
    expect((mod as Record<string, unknown>).startJob).toBeUndefined();
  });
});
