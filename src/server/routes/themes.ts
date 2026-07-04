/**
 * Theme routes — list, switch, delete, rename themes.
 */

import { publicErrorMessage } from "../errors.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { jsonResponse, readBody } from "../route-helpers.js";
import {
  getSession,
  listSessions,
  loadSession,
  deleteSession,
  renameSession,
  duplicateSession,
  saveSession,
} from "../session.js";
import { WORKSPACE_DIR } from "./setup.js";

export function handleThemesRoute(method: string, req: IncomingMessage, res: ServerResponse): void {
  if (method === "GET") {
    const session = getSession();
    const sessions = listSessions()
      .sort((a, b) => b.updatedAt - a.updatedAt);

    jsonResponse(res, 200, {
      activeTheme: session
        ? { id: session.id, themeName: session.themeName, isImported: !!session.isImported }
        : null,
      sessions,
    });
    return;
  }

  if (method === "DELETE") {
    readBody(req, (body) => {
      try {
        const { sessionId, deleteFiles } = JSON.parse(body);
        deleteSession(sessionId, deleteFiles);
        jsonResponse(res, 200, { ok: true });
      } catch (err) {
        jsonResponse(res, 500, { error: publicErrorMessage(err) });
      }
    });
    return;
  }

  jsonResponse(res, 405, { error: "Method not allowed" });
}

export function handleThemeSwitchRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { sessionId } = JSON.parse(body);
      const session = loadSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, { error: "Session not found" });
        return;
      }

      jsonResponse(res, 200, {
        ok: true,
        themeName: session.themeName,
        themePath: session.themePath,
      });
    } catch (err) {
      jsonResponse(res, 500, { error: publicErrorMessage(err) });
    }
  });
}

export function handleDeleteLocalThemeRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { themeName } = JSON.parse(body);
      if (!themeName || typeof themeName !== "string") {
        jsonResponse(res, 400, { error: "Theme name is required" });
        return;
      }
      if (/[\/\\]|\.\./.test(themeName) || themeName === "." || !themeName.replace(/[^a-z0-9]/gi, "")) {
        jsonResponse(res, 400, { error: "Invalid theme name" });
        return;
      }
      const themePath = join(WORKSPACE_DIR, themeName);
      if (!existsSync(themePath)) {
        jsonResponse(res, 404, { error: "Theme not found on disk" });
        return;
      }
      rmSync(themePath, { recursive: true, force: true });
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 500, { error: publicErrorMessage(err) });
    }
  });
}

export function handleRenameThemeRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { sessionId, newName } = JSON.parse(body);
      if (!sessionId || !newName || typeof newName !== "string") {
        jsonResponse(res, 400, { error: "sessionId and newName are required" });
        return;
      }
      const sanitized = newName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-|-$/g, "").replace(/-{2,}/g, "-");
      if (!sanitized) {
        jsonResponse(res, 400, { error: "Invalid name" });
        return;
      }
      const result = renameSession(sessionId, sanitized);
      if (result.ok) {
        jsonResponse(res, 200, { ok: true, newName: sanitized });
      } else {
        jsonResponse(res, 400, { error: result.error });
      }
    } catch (err) {
      jsonResponse(res, 500, { error: publicErrorMessage(err) });
    }
  });
}

export function handleDuplicateThemeRoute(req: IncomingMessage, res: ServerResponse): void {
  readBody(req, (body) => {
    try {
      const { sessionId } = JSON.parse(body);
      if (!sessionId) {
        jsonResponse(res, 400, { error: "sessionId is required" });
        return;
      }
      const result = duplicateSession(sessionId);
      if (result.ok) {
        jsonResponse(res, 200, { ok: true, newName: result.newName, newSessionId: result.newSessionId });
      } else {
        jsonResponse(res, 400, { error: result.error });
      }
    } catch (err) {
      jsonResponse(res, 500, { error: publicErrorMessage(err) });
    }
  });
}
