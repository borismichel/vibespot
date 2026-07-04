/**
 * VIB-1935 — /api/setup/open must resume an existing session instead of
 * rescanning the theme from disk. Inline field edits live only in the
 * session store, so a rescan on URL reload (#/app/<theme>) silently
 * discarded them.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { afterAll, describe, expect, it, vi } from "vitest";

// Isolate ~/.vibespot/sessions into a temp home so the tests never touch (or
// depend on) the real user's session store. The store computes SESSIONS_DIR
// from homedir() at import time, so the path must be fixed before imports —
// hence one hoisted home for the whole file, with unique theme names per test.
// (Plain string concat: vi.hoisted runs before the import statements above.)
const state = vi.hoisted(() => ({
  home: `${process.env.TMPDIR || "/tmp"}/vibespot-setup-open-home-${process.pid}`,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => state.home };
});

// Keep the tests hermetic: no git subprocesses, no generation lock.
vi.mock("../src/server/project-git.js", () => ({
  isGitAvailable: () => false,
  ensureGitRepo: () => false,
  commitThemeState: () => null,
  commitTemplateState: () => null,
  getHistory: () => [],
  getTemplateHistory: () => [],
  rollbackToCommit: () => ({ ok: false }),
  rollbackTemplateToCommit: () => ({ ok: false }),
}));

vi.mock("../src/server/ai-handler.js", () => ({
  isGenerating: () => false,
}));

import { handleSetupOpenRoute } from "../src/server/routes/setup.js";
import {
  getSession,
  createSession,
  scanThemeFromDisk,
  saveSession,
  updateFieldValue,
  findLatestSessionIdForThemePath,
} from "../src/server/session.js";

const tempHome = state.home;
mkdirSync(tempHome, { recursive: true });

function makeTheme(name: string): string {
  const dir = join(tempHome, "themes", name);
  const modDir = join(dir, "modules", "hero.module");
  mkdirSync(modDir, { recursive: true });
  writeFileSync(join(dir, "theme.json"), JSON.stringify({ name, label: name }));
  writeFileSync(
    join(modDir, "fields.json"),
    JSON.stringify([{ name: "heading", type: "text", default: "Disk default" }], null, 2)
  );
  writeFileSync(join(modDir, "module.html"), "<h1>{{ module.heading }}</h1>");
  writeFileSync(join(modDir, "meta.json"), JSON.stringify({ label: "Hero" }));
  return dir;
}

function postSetupOpen(path: string): { status: number; body: any } {
  const req = new EventEmitter() as unknown as IncomingMessage;
  let status = 0;
  let raw = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(payload: string) {
      raw = payload;
    },
  } as unknown as ServerResponse;

  handleSetupOpenRoute(req, res);
  (req as unknown as EventEmitter).emit("data", Buffer.from(JSON.stringify({ path })));
  (req as unknown as EventEmitter).emit("end");

  return { status, body: JSON.parse(raw) };
}

function activeHeadingDefault(): unknown {
  const mod = getSession()?.modules.find((m) => m.moduleName === "hero");
  const fields = JSON.parse(mod!.fieldsJson);
  return fields[0].default;
}

function clearActiveSession(): void {
  // Simulate a server whose in-memory session moved on (or restarted) by
  // pointing the active session at a different theme.
  const otherTheme = makeThemeless("other-theme");
  createSession(otherTheme, "other-theme");
}

function makeThemeless(name: string): string {
  const dir = join(tempHome, "themes", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe("POST /api/setup/open (VIB-1935)", () => {
  it("scans fresh when no saved session exists for the theme path", () => {
    const themePath = makeTheme("fresh-theme");
    clearActiveSession();

    const { status, body } = postSetupOpen(themePath);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, themeName: "fresh-theme", resumed: false, moduleCount: 1 });
    expect(activeHeadingDefault()).toBe("Disk default");
  });

  it("resumes the saved session so inline field edits survive a URL reload", () => {
    const themePath = makeTheme("edited-theme");

    // First open: fresh scan, then an inline edit (as POST /api/field does).
    createSession(themePath, "edited-theme");
    scanThemeFromDisk(themePath);
    saveSession();
    updateFieldValue("hero", "heading", "Edited heading");
    saveSession();

    // URL reload: the active session is elsewhere (or the server restarted).
    clearActiveSession();
    const { status, body } = postSetupOpen(themePath);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, themeName: "edited-theme", resumed: true, moduleCount: 1 });
    expect(activeHeadingDefault()).toBe("Edited heading");
  });

  it("keeps the live in-memory session when reopening the already-active theme", () => {
    const themePath = makeTheme("active-theme");
    createSession(themePath, "active-theme");
    scanThemeFromDisk(themePath);
    saveSession();
    updateFieldValue("hero", "heading", "Live edit");
    const sessionId = getSession()!.id;

    const { status, body } = postSetupOpen(themePath);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, resumed: true });
    expect(getSession()!.id).toBe(sessionId);
    expect(activeHeadingDefault()).toBe("Live edit");
  });

  it("picks the most recently updated session when several exist for the path", () => {
    const themePath = makeTheme("multi-session");

    createSession(themePath, "multi-session");
    scanThemeFromDisk(themePath);
    getSession()!.updatedAt = 1000;
    saveSession();
    const olderId = getSession()!.id;

    createSession(themePath, "multi-session");
    scanThemeFromDisk(themePath);
    updateFieldValue("hero", "heading", "Newest edit");
    getSession()!.updatedAt = 2000;
    saveSession();
    const newerId = getSession()!.id;

    expect(findLatestSessionIdForThemePath(themePath)).toBe(newerId);
    expect(olderId).not.toBe(newerId);

    clearActiveSession();
    const { body } = postSetupOpen(themePath);
    expect(body.resumed).toBe(true);
    expect(activeHeadingDefault()).toBe("Newest edit");
  });
});
