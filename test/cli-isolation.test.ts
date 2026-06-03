/**
 * Claude Code CLI context-isolation tests (VIB-1855).
 *
 * Guards the fix for the recurring "Prompt is too long" failure: vibeSpot must
 * own the spawned `claude` CLI's 200k context window instead of inheriting the
 * user's ambient MCP servers + project CLAUDE.md.
 */

import { describe, expect, it } from "vitest";
import {
  CLAUDE_ISOLATION_FLAGS,
  getIsolatedClaudeCwd,
  mapClaudeCliError,
} from "../src/server/ai-engines.js";

describe("Claude CLI isolation flags", () => {
  it("disables all ambient MCP servers via --strict-mcp-config", () => {
    // With no accompanying --mcp-config this means ZERO MCP servers, which is
    // the primary source of the context overflow (unbounded tool schemas).
    expect(CLAUDE_ISOLATION_FLAGS).toContain("--strict-mcp-config");
  });
});

describe("getIsolatedClaudeCwd", () => {
  it("returns a stable temp directory outside the user's project", () => {
    const a = getIsolatedClaudeCwd();
    const b = getIsolatedClaudeCwd();
    expect(a).toBe(b); // created once, reused
    expect(a).toMatch(/vibespot-claude-|tmp/i);
  });
});

describe("mapClaudeCliError", () => {
  it("maps the raw 'Prompt is too long' API string to a friendly, actionable message", () => {
    const raw = "API Error: 400 prompt is too long: 245000 tokens > 200000 maximum";
    const friendly = mapClaudeCliError(raw);
    expect(friendly).not.toBe(raw);
    expect(friendly).toMatch(/context window/i);
    expect(friendly).toMatch(/Anthropic API engine/i);
  });

  it("matches the bare 200000-limit variant", () => {
    expect(mapClaudeCliError("input length and max_tokens exceed context limit: 210000 > 200000"))
      .toMatch(/context window/i);
  });

  it("passes unrelated errors through unchanged", () => {
    const raw = "claude exited with code 1.\nStderr: ENOENT: command not found";
    expect(mapClaudeCliError(raw)).toBe(raw);
  });
});
