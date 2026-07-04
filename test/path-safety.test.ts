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
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Template-file sinks in session/disk.ts (VIB-1912) — a poisoned persisted
// session must not turn `tpl.templateFile` / `tpl.id` into a write outside
// templates/ or a read outside the theme.
// ---------------------------------------------------------------------------

import { createSession, writeModulesToDisk, reloadActiveTemplateFromDisk } from "../src/server/session.js";
import type { TemplateEntry } from "../src/server/session/types.js";
import type { ModuleFiles } from "../src/ai/engine.js";

describe("session/disk template-file containment (VIB-1912)", () => {
  let wrapper = "";

  afterEach(() => {
    if (wrapper) rmSync(wrapper, { recursive: true, force: true });
    wrapper = "";
  });

  function makeTheme(): string {
    wrapper = mkdtempSync(join(tmpdir(), "vibespot-tpl-safety-"));
    const themePath = join(wrapper, "theme");
    mkdirSync(themePath, { recursive: true });
    return themePath;
  }

  function makeModule(name: string): ModuleFiles {
    return { moduleName: name, fieldsJson: "[]", metaJson: "{}", moduleHtml: "<div></div>", moduleCss: "" };
  }

  function makeTemplate(overrides: Partial<TemplateEntry>): TemplateEntry {
    return {
      id: "lp-main",
      label: "Main",
      pageType: "landing_page",
      templateFile: "templates/lp-main.html",
      modules: [makeModule("hero")],
      moduleOrder: ["hero"],
      sharedCss: "",
      sharedJs: "",
      template: "",
      messages: [],
      ...overrides,
    };
  }

  it("refuses an email templateFile that escapes templates/, still writes safe ones", () => {
    const themePath = makeTheme();
    const session = createSession(themePath, "tpl-safety");
    session.templates = [
      makeTemplate({
        id: "email-evil",
        contentMode: "email",
        pageType: "module_only",
        templateFile: "templates/../../email-canary.html",
      }),
      makeTemplate({
        id: "email-ok",
        contentMode: "email",
        pageType: "module_only",
        templateFile: "templates/email-ok.html",
      }),
    ];

    writeModulesToDisk();

    expect(existsSync(join(wrapper, "email-canary.html"))).toBe(false);
    expect(existsSync(join(themePath, "templates", "email-ok.html"))).toBe(true);
  });

  it("refuses page and blog-listing template ids with traversal sequences", () => {
    const themePath = makeTheme();
    const session = createSession(themePath, "tpl-safety");
    session.templates = [
      makeTemplate({ id: "../../page-canary", pageType: "blog_post" }),
    ];

    writeModulesToDisk();

    expect(existsSync(join(wrapper, "page-canary.html"))).toBe(false);
    expect(existsSync(join(wrapper, "page-canary-listing.html"))).toBe(false);
    expect(readdirSync(join(themePath, "templates")).filter((f) => f.endsWith(".html"))).toEqual([]);
  });

  it("does not read files outside the theme into session state on reload", () => {
    const themePath = makeTheme();
    writeFileSync(join(wrapper, "secret.txt"), "TOP-SECRET", "utf-8");
    const session = createSession(themePath, "tpl-safety");
    session.templates = [
      makeTemplate({ id: "t1", templateFile: "templates/../../secret.txt", moduleOrder: [], modules: [] }),
    ];
    session.activeTemplateId = "t1";

    reloadActiveTemplateFromDisk();

    expect(session.templates[0].template).toBe("");
  });
});
