import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createSession } from "../src/server/session.js";
import { handleThemesRoute } from "../src/server/routes/themes.js";

let themePath = "";

afterEach(() => {
  if (themePath) rmSync(themePath, { recursive: true, force: true });
  themePath = "";
});

function makeThemePath(name: string): string {
  themePath = mkdtempSync(join(tmpdir(), `vibespot-theme-route-${name}-`));
  return themePath;
}

function getThemesPayload(): any {
  let statusCode = 0;
  let body = "";
  const res = {
    writeHead(status: number) {
      statusCode = status;
    },
    end(payload: string) {
      body = payload;
    },
  } as unknown as ServerResponse;

  handleThemesRoute("GET", {} as IncomingMessage, res);

  expect(statusCode).toBe(200);
  return JSON.parse(body);
}

describe("themes route", () => {
  it("marks natively-created active themes as not imported", () => {
    createSession(makeThemePath("native"), "native-theme");

    const payload = getThemesPayload();

    expect(payload.activeTheme).toMatchObject({
      themeName: "native-theme",
      isImported: false,
    });
  });

  it("exposes imported active themes for dashboard import analysis gating", () => {
    createSession(makeThemePath("imported"), "imported-theme", { isImported: true });

    const payload = getThemesPayload();

    expect(payload.activeTheme).toMatchObject({
      themeName: "imported-theme",
      isImported: true,
    });
  });
});
