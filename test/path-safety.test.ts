/**
 * VIB-1891 — arbitrary-file-write hardening.
 *
 * 1. `kebabModuleName` / `resolveModuleDir` — AI-supplied module names are
 *    sanitized at the pipeline acceptance points and re-checked at every fs
 *    sink; a traversal name must never resolve outside `<theme>/modules/`.
 * 2. `resolveContainedPath` + `fetchTheme` — HubSpot server-supplied file
 *    listings must never write outside the fetch target dir (zip-slip).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  kebabModuleName,
  isSafePathSegment,
  resolveModuleDir,
  resolveContainedPath,
} from "../src/utils/path-safety.js";

describe("kebabModuleName", () => {
  it("keeps well-formed kebab names", () => {
    expect(kebabModuleName("hero")).toBe("hero");
    expect(kebabModuleName("trust-bar-2")).toBe("trust-bar-2");
  });

  it("coerces free-typed names", () => {
    expect(kebabModuleName("  Hero Section! ")).toBe("hero-section");
    expect(kebabModuleName("FAQ's")).toBe("faqs");
  });

  it("neutralizes traversal sequences", () => {
    expect(kebabModuleName("../../../home/user/.config/autostart/x")).toBe(
      "home-user-config-autostart-x",
    );
    expect(kebabModuleName("..")).toBe("");
    expect(kebabModuleName("a/b\\c")).toBe("a-b-c");
  });

  it("returns empty string for garbage", () => {
    expect(kebabModuleName("")).toBe("");
    expect(kebabModuleName("///")).toBe("");
    expect(kebabModuleName(undefined as unknown as string)).toBe("");
  });
});

describe("isSafePathSegment", () => {
  it("accepts plain names, including imported non-kebab ones", () => {
    expect(isSafePathSegment("hero")).toBe(true);
    expect(isSafePathSegment("Hero_Section")).toBe(true);
  });

  it("rejects separators, dot dirs, and null bytes", () => {
    expect(isSafePathSegment("a/b")).toBe(false);
    expect(isSafePathSegment("a\\b")).toBe(false);
    expect(isSafePathSegment("..")).toBe(false);
    expect(isSafePathSegment(".")).toBe(false);
    expect(isSafePathSegment("a\0b")).toBe(false);
    expect(isSafePathSegment("")).toBe(false);
  });
});

describe("resolveModuleDir", () => {
  const base = join(tmpdir(), "vibespot-theme", "modules");

  it("resolves safe names to a direct child of modules/", () => {
    expect(resolveModuleDir(base, "hero")).toBe(resolve(base, "hero.module"));
    // Imported HubSpot themes may have non-kebab dir names — still contained
    expect(resolveModuleDir(base, "Hero_Section")).toBe(resolve(base, "Hero_Section.module"));
  });

  it("throws on traversal and nesting", () => {
    expect(() => resolveModuleDir(base, "../evil")).toThrow(/Unsafe module name/);
    expect(() => resolveModuleDir(base, "../../home/user/.config/autostart/x")).toThrow();
    expect(() => resolveModuleDir(base, "a/b")).toThrow(/Unsafe module name/);
    expect(() => resolveModuleDir(base, "/etc/cron.d/x")).toThrow(/Unsafe module name/);
    expect(() => resolveModuleDir(base, "a\0b")).toThrow(/Unsafe module name/);
  });
});

describe("resolveContainedPath", () => {
  const base = join(tmpdir(), "vibespot-fetch-target");

  it("allows nested relative paths inside the target", () => {
    expect(resolveContainedPath(base, "modules/hero.module/module.html")).toBe(
      join(base, "modules/hero.module/module.html"),
    );
  });

  it("throws on paths escaping the target", () => {
    expect(() => resolveContainedPath(base, "../../evil.txt")).toThrow(/escapes/);
    expect(() => resolveContainedPath(base, "a/../../../evil.txt")).toThrow(/escapes/);
    expect(() => resolveContainedPath(base, "a\0b")).toThrow(/Unsafe path/);
  });

  it("keeps absolute-looking segments inside the target (join semantics)", () => {
    const p = resolveContainedPath(base, "/etc/passwd");
    expect(resolve(p).startsWith(resolve(base) + sep)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchTheme zip-slip (mocked HubSpot API)
// ---------------------------------------------------------------------------

vi.mock("../src/hubspot/api.js", () => ({
  getMetadata: vi.fn(),
  downloadFile: vi.fn(async () => "content"),
}));

import { fetchTheme } from "../src/hubspot/fetcher.js";
import { getMetadata } from "../src/hubspot/api.js";

describe("fetchTheme zip-slip guard", () => {
  let target: string;

  afterEach(() => {
    if (target && existsSync(target)) rmSync(target, { recursive: true, force: true });
  });

  it("refuses to write files whose remote path escapes the target dir", async () => {
    target = mkdtempSync(join(tmpdir(), "vibespot-fetch-"));
    const sibling = join(target, "..", "vibespot-zipslip-canary.txt");

    vi.mocked(getMetadata).mockResolvedValue({
      folder: true,
      path: "theme",
      name: "theme",
      children: [
        { folder: false, name: "evil", path: "theme/../../vibespot-zipslip-canary.txt" },
      ],
    } as never);

    await expect(fetchTheme("pak", "theme", target)).rejects.toThrow(/escapes/);
    expect(existsSync(sibling)).toBe(false);
  });

  it("still writes well-behaved theme files", async () => {
    target = mkdtempSync(join(tmpdir(), "vibespot-fetch-"));

    vi.mocked(getMetadata).mockResolvedValue({
      folder: true,
      path: "theme",
      name: "theme",
      children: [
        { folder: false, name: "module.html", path: "theme/modules/hero.module/module.html" },
      ],
    } as never);

    await fetchTheme("pak", "theme", target);
    expect(readdirSync(join(target, "modules", "hero.module"))).toContain("module.html");
  });
});
