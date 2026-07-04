/**
 * Regression tests for VIB-1890 — shell/command injection.
 *
 * Every process launch must pass user-controlled values as literal argv
 * entries (no shell interpolation). These tests feed shell-metacharacter
 * payloads through the helpers and assert they stay inert: the payload
 * arrives as a literal string and no side-effect command executes.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runFile } from "../src/utils/shell.js";
import { isSafeThemeName } from "../src/utils/validate.js";
import { startJobSafe, startStreamingJob, getJob } from "../src/server/process-manager.js";

// Force the /api/setup/fetch route down its CLI branch (no PAK, CLI mode)
// and stub the subprocess launcher so the test never needs a real `hs`.
vi.mock("../src/utils/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({ hubspotUploadMode: "cli" }),
    getHubSpotPak: () => null,
  };
});
const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // Pass through by default so runFile/startJob* keep exercising the real
  // thing; the fetch-route tests only inspect calls targeting `hs`.
  execFileSyncMock.mockImplementation(actual.execFileSync as never);
  return { ...actual, execFileSync: execFileSyncMock };
});
import { handleSetupFetchRoute } from "../src/server/routes/setup.js";

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

describe("handleSetupFetchRoute (POST /api/setup/fetch, CLI branch)", () => {
  function fakeReq(body: string): IncomingMessage {
    const req = new EventEmitter();
    process.nextTick(() => {
      req.emit("data", Buffer.from(body));
      req.emit("end");
    });
    return req as unknown as IncomingMessage;
  }

  function fakeRes(): { res: ServerResponse; done: Promise<{ status: number; body: Record<string, unknown> }> } {
    let status = 0;
    let resolve!: (v: { status: number; body: Record<string, unknown> }) => void;
    const done = new Promise<{ status: number; body: Record<string, unknown> }>((r) => (resolve = r));
    const res = {
      headersSent: false,
      writeHead(s: number) { status = s; return res; },
      end(data?: string) { resolve({ status, body: data ? JSON.parse(data) : {} }); },
    };
    return { res: res as unknown as ServerResponse, done };
  }

  const hsCalls = () => execFileSyncMock.mock.calls.filter((c) => c[0] === "hs");

  afterEach(() => {
    execFileSyncMock.mockClear();
  });

  it("rejects unsafe theme names with 400 and spawns nothing", async () => {
    for (const p of payloads) {
      const { res, done } = fakeRes();
      handleSetupFetchRoute(fakeReq(JSON.stringify({ name: p })), res);
      const result = await done;
      expect(result.status).toBe(400);
      expect(String(result.body.error)).toMatch(/unsupported characters/);
      expect(hsCalls()).toHaveLength(0);
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("passes a safe theme name to hs as literal argv", async () => {
    execFileSyncMock.mockImplementationOnce(() => { throw new Error("hs not installed"); });
    const { res, done } = fakeRes();
    handleSetupFetchRoute(fakeReq(JSON.stringify({ name: "my-theme" })), res);
    const result = await done;
    expect(result.status).toBe(500);
    expect(hsCalls()).toHaveLength(1);
    const [cmd, args] = hsCalls()[0];
    expect(cmd).toBe("hs");
    expect(args.slice(0, 3)).toEqual(["cms", "fetch", "my-theme"]);
  });
});

describe("no unconditional shell spawns remain", () => {
  it("string-based startJob is gone from the process manager", async () => {
    const mod = await import("../src/server/process-manager.js");
    expect((mod as Record<string, unknown>).startJob).toBeUndefined();
  });
});
