/**
 * Behavioral coverage for src/utils/build-check.ts (VIB-1939).
 *
 * Strategy: build a fake package root in a temp dir with a `dist/index.js` and
 * a `src/` tree, control mtimes with utimesSync, and assert the staleness
 * verdict. No real package layout, no subprocess.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBuildStaleness, warnIfBuildStale } from "../src/utils/build-check.js";

let root: string;

/** Set a file's atime/mtime to `epochSeconds`. */
function setMtime(path: string, epochSeconds: number): void {
  utimesSync(path, epochSeconds, epochSeconds);
}

const T0 = 1_700_000_000; // fixed base instant (seconds)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vib1939-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed({ dist = true, src = true }: { dist?: boolean; src?: boolean } = {}): void {
  if (dist) {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.js"), "// bundle");
  }
  if (src) {
    mkdirSync(join(root, "src", "server"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "// entry");
    writeFileSync(join(root, "src", "server", "server.ts"), "// server");
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "vibespot", version: "1.5.0" }));
}

describe("checkBuildStaleness", () => {
  it("flags a build older than the pulled source", () => {
    seed();
    setMtime(join(root, "dist", "index.js"), T0);
    setMtime(join(root, "package.json"), T0);
    setMtime(join(root, "src", "index.ts"), T0);
    // A pulled source file is newer than the build.
    setMtime(join(root, "src", "server", "server.ts"), T0 + 3600);

    const result = checkBuildStaleness(root);
    expect(result.stale).toBe(true);
    expect(result.reason).toBe("stale");
    expect(result.newestSrcPath).toBe(join(root, "src", "server", "server.ts"));
  });

  it("treats a freshly built dist as up to date", () => {
    seed();
    setMtime(join(root, "src", "index.ts"), T0);
    setMtime(join(root, "src", "server", "server.ts"), T0);
    setMtime(join(root, "package.json"), T0);
    // Build happened after the source changed.
    setMtime(join(root, "dist", "index.js"), T0 + 3600);

    const result = checkBuildStaleness(root);
    expect(result.stale).toBe(false);
    expect(result.reason).toBe("fresh");
  });

  it("does not fire within the same-second slack window", () => {
    seed();
    setMtime(join(root, "dist", "index.js"), T0);
    setMtime(join(root, "package.json"), T0);
    setMtime(join(root, "src", "index.ts"), T0);
    setMtime(join(root, "src", "server", "server.ts"), T0); // equal mtime

    expect(checkBuildStaleness(root).stale).toBe(false);
  });

  it("skips npm-installed layouts that ship dist but no src", () => {
    seed({ src: false });
    setMtime(join(root, "dist", "index.js"), T0);
    const result = checkBuildStaleness(root);
    expect(result.stale).toBe(false);
    expect(result.reason).toBe("no-src");
  });

  it("skips when the build has never been produced", () => {
    seed({ dist: false });
    const result = checkBuildStaleness(root);
    expect(result.stale).toBe(false);
    expect(result.reason).toBe("no-dist");
  });

  it("counts a newer package.json (version bump) as stale", () => {
    seed();
    setMtime(join(root, "dist", "index.js"), T0);
    setMtime(join(root, "src", "index.ts"), T0);
    setMtime(join(root, "src", "server", "server.ts"), T0);
    setMtime(join(root, "package.json"), T0 + 3600);

    expect(checkBuildStaleness(root).stale).toBe(true);
  });
});

describe("warnIfBuildStale", () => {
  it("is a no-op in a dev run (running from source, no override)", () => {
    // Called with no override: this test file runs via tsx from src/, so the
    // module resolves under src/ and short-circuits as a dev run.
    const lines: string[] = [];
    expect(warnIfBuildStale((m) => lines.push(m))).toBe(false);
    expect(lines).toHaveLength(0);
  });
});
