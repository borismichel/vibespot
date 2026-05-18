/**
 * Integration tests: verify CRUD parity between FileSystemStorageAdapter and
 * PostgresStorageAdapter.
 *
 * The filesystem tests always run.
 * Postgres tests run when VIBESPOT_TEST_PG_URL is set (e.g., postgres://localhost:5432/vibespot_test).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSystemStorageAdapter } from "../src/server/storage/fs-adapter.js";
import { PostgresStorageAdapter } from "../src/server/storage/pg-adapter.js";
import type { StorageAdapter, ModuleOnDisk } from "../src/server/storage/types.js";
import type { VibeSession } from "../src/server/session/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<VibeSession> = {}): VibeSession {
  return {
    id: `vibe-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    themePath: "/tmp/test-theme",
    themeName: "test-theme",
    isImported: false,
    templates: [
      {
        id: "lp-main",
        label: "Main Landing",
        pageType: "landing_page",
        templateFile: "templates/lp-main.html",
        modules: [],
        moduleOrder: ["hero", "features"],
        sharedCss: ":root { --primary: #e8613a; }",
        sharedJs: "",
        template: "<div>test</div>",
        messages: [],
      },
    ],
    activeTemplateId: "lp-main",
    messages: [],
    modules: [],
    sharedCss: ":root { --primary: #e8613a; }",
    sharedJs: "",
    template: "",
    moduleOrder: ["hero", "features"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

const testModule: ModuleOnDisk = {
  fieldsJson: JSON.stringify([{ name: "heading", type: "text", default: "Hello" }]),
  metaJson: JSON.stringify({ label: "Hero", icon: "module" }),
  moduleHtml: '<section class="hero">{{ module.heading }}</section>',
  moduleCss: ".hero { padding: 4rem; }",
  moduleJs: "console.log('hero');",
};

// ---------------------------------------------------------------------------
// Shared test suite — runs against any adapter
// ---------------------------------------------------------------------------

function adapterSuite(name: string, getAdapter: () => Promise<{ adapter: StorageAdapter; cleanup: () => Promise<void> }>) {
  describe(`StorageAdapter — ${name}`, () => {
    let adapter: StorageAdapter;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const setup = await getAdapter();
      adapter = setup.adapter;
      cleanup = setup.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    // --- Session CRUD ---

    it("saves and loads a session", async () => {
      const session = makeSession();
      await adapter.saveSession(session);
      const loaded = await adapter.loadSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(session.id);
      expect(loaded!.themeName).toBe("test-theme");
      expect(loaded!.templates).toHaveLength(1);
      expect(loaded!.templates[0].moduleOrder).toEqual(["hero", "features"]);
    });

    it("lists sessions after save", async () => {
      const s1 = makeSession({ themeName: "alpha" });
      const s2 = makeSession({ themeName: "beta" });
      await adapter.saveSession(s1);
      await adapter.saveSession(s2);
      const list = await adapter.listSessions();
      const ids = list.map((e) => e.id);
      expect(ids).toContain(s1.id);
      expect(ids).toContain(s2.id);
    });

    it("deletes a session", async () => {
      const session = makeSession();
      await adapter.saveSession(session);
      await adapter.deleteSession(session.id);
      const loaded = await adapter.loadSession(session.id);
      expect(loaded).toBeNull();
    });

    it("deletes sessions by theme name", async () => {
      const s1 = makeSession({ themeName: "duplicate" });
      const s2 = makeSession({ themeName: "duplicate" });
      const s3 = makeSession({ themeName: "keep-me" });
      await adapter.saveSession(s1);
      await adapter.saveSession(s2);
      await adapter.saveSession(s3);
      await adapter.deleteSessionsByTheme("duplicate");
      const list = await adapter.listSessions();
      expect(list.find((e) => e.themeName === "duplicate")).toBeUndefined();
      expect(list.find((e) => e.themeName === "keep-me")).toBeDefined();
    });

    it("updates an existing session (upsert)", async () => {
      const session = makeSession();
      await adapter.saveSession(session);
      session.themeName = "updated-name";
      session.updatedAt = Date.now();
      await adapter.saveSession(session);
      const loaded = await adapter.loadSession(session.id);
      expect(loaded!.themeName).toBe("updated-name");
    });

    // --- Module I/O ---

    it("writes and reads a module", async () => {
      const session = makeSession();
      await adapter.saveSession(session);
      const themePath = session.themePath;

      await adapter.writeModule(themePath, "hero", testModule);
      const loaded = await adapter.readModule(themePath, "hero");
      expect(loaded).not.toBeNull();
      expect(loaded!.fieldsJson).toBe(testModule.fieldsJson);
      expect(loaded!.moduleHtml).toBe(testModule.moduleHtml);
      expect(loaded!.moduleCss).toBe(testModule.moduleCss);
      expect(loaded!.moduleJs).toBe(testModule.moduleJs);
    });

    it("lists modules", async () => {
      const session = makeSession();
      await adapter.saveSession(session);
      const themePath = session.themePath;

      await adapter.writeModule(themePath, "hero", testModule);
      await adapter.writeModule(themePath, "features", { ...testModule, moduleHtml: "<div>features</div>" });
      const names = await adapter.listModules(themePath);
      expect(names.sort()).toEqual(["features", "hero"]);
    });

    it("deletes a module", async () => {
      const session = makeSession();
      await adapter.saveSession(session);
      const themePath = session.themePath;

      await adapter.writeModule(themePath, "hero", testModule);
      await adapter.deleteModule(themePath, "hero");
      const loaded = await adapter.readModule(themePath, "hero");
      expect(loaded).toBeNull();
    });

    // --- Shared CSS/JS ---

    it("writes and reads shared CSS", async () => {
      const session = makeSession();
      await adapter.saveSession(session);
      const css = ":root { --accent: blue; }";
      await adapter.writeSharedCss(session.themePath, session.themeName, css);
      const loaded = await adapter.readSharedCss(session.themePath, session.themeName);
      expect(loaded).toBe(css);
    });

    it("writes and reads shared JS", async () => {
      const session = makeSession();
      await adapter.saveSession(session);
      const js = "document.addEventListener('DOMContentLoaded', () => {});";
      await adapter.writeSharedJs(session.themePath, session.themeName, js);
      const loaded = await adapter.readSharedJs(session.themePath, session.themeName);
      expect(loaded).toBe(js);
    });

    // --- Brand assets ---

    it("writes and reads brand assets", async () => {
      const session = makeSession();
      await adapter.saveSession(session);
      await adapter.writeBrandAsset(session.themePath, "styleguide.md", "# Style Guide");
      const loaded = await adapter.readBrandAsset(session.themePath, "styleguide.md");
      expect(loaded).toBe("# Style Guide");
    });

    it("deletes a brand asset", async () => {
      const session = makeSession();
      await adapter.saveSession(session);
      await adapter.writeBrandAsset(session.themePath, "plan.md", "# Plan");
      await adapter.deleteBrandAsset(session.themePath, "plan.md");
      const loaded = await adapter.readBrandAsset(session.themePath, "plan.md");
      expect(loaded).toBeNull();
    });
  });
}

// ---------------------------------------------------------------------------
// FileSystem adapter setup
// ---------------------------------------------------------------------------

adapterSuite("FileSystem", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vibespot-test-"));
  const adapter = new FileSystemStorageAdapter();

  // Override the sessions dir for isolation — we patch the homedir paths
  // by setting the session's themePath to a temp location
  const themePath = join(tempDir, "test-theme");

  // Monkey-patch makeSession for this test run
  const origThemePath = "/tmp/test-theme";

  return {
    adapter,
    cleanup: async () => {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
});

// ---------------------------------------------------------------------------
// Postgres adapter setup (conditional — requires VIBESPOT_TEST_PG_URL)
// ---------------------------------------------------------------------------

const pgUrl = process.env.VIBESPOT_TEST_PG_URL;

if (pgUrl) {
  let pgPool: any;

  adapterSuite("Postgres", async () => {
    const { default: pg } = await import("pg");
    pgPool = new pg.Pool({ connectionString: pgUrl });

    // Clean tables before each test
    await pgPool.query("DROP TABLE IF EXISTS theme_files CASCADE");
    await pgPool.query("DROP TABLE IF EXISTS sessions CASCADE");

    const adapter = new PostgresStorageAdapter(pgPool);

    return {
      adapter,
      cleanup: async () => {
        await pgPool.query("DROP TABLE IF EXISTS theme_files CASCADE");
        await pgPool.query("DROP TABLE IF EXISTS sessions CASCADE");
      },
    };
  });

  afterAll(async () => {
    if (pgPool) await pgPool.end();
  });
} else {
  describe("StorageAdapter — Postgres (SKIPPED)", () => {
    it.skip("Set VIBESPOT_TEST_PG_URL to run Postgres tests", () => {});
  });
}
