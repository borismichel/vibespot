/**
 * Behavioral coverage for the /api/brand-assets POST route (VIB-1899).
 *
 * The route now accepts two content types:
 *   - multipart/form-data (file uploads from ui/dashboard.js) — streamed via
 *     Busboy with a 1 MB cap, text-only (NUL-byte + UTF-8 validation)
 *   - application/json ({type, content}) — the pre-existing path, still used
 *     by the humanify toggle and paste-based flows
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockSession: Record<string, unknown> | null = null;
const saveSession = vi.fn();

vi.mock("../src/server/session.js", () => ({
  getSession: () => mockSession,
  saveSession: (...args: unknown[]) => saveSession(...args),
  getOrderedModules: vi.fn(() => []),
  getActiveTemplate: vi.fn(() => null),
  setActiveTemplate: vi.fn(),
  addTemplate: vi.fn(),
  removeTemplate: vi.fn(),
  cloneTemplate: vi.fn(),
  getModuleLibrary: vi.fn(() => []),
  renameTemplate: vi.fn(),
  reorderTemplates: vi.fn(),
}));

vi.mock("../src/server/log.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { handleBrandAssetsRoute } = await import("../src/server/routes/templates.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes() {
  let status = 0;
  let body: any;
  let resolve: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  const res = {
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => {
      try { body = JSON.parse(b ?? "{}"); } catch { body = b; }
      resolve();
    },
  } as unknown as ServerResponse;
  return { res, done, result: () => ({ status, body }) };
}

function makeReq(headers: Record<string, string>, payload: Buffer): IncomingMessage {
  const readable = new Readable({ read() {} }) as unknown as IncomingMessage;
  (readable as any).headers = headers;
  (readable as any).method = "POST";
  process.nextTick(() => {
    (readable as any).push(payload);
    (readable as any).push(null);
  });
  return readable;
}

const BOUNDARY = "----vibespotTestBoundary";

function multipartBody(type: string, filename: string, content: Buffer): Buffer {
  const head =
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${type}\r\n` +
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n`;
  const tail = `\r\n--${BOUNDARY}--\r\n`;
  return Buffer.concat([Buffer.from(head), content, Buffer.from(tail)]);
}

function multipartReq(type: string, filename: string, content: Buffer): IncomingMessage {
  const body = multipartBody(type, filename, content);
  return makeReq(
    { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, "content-length": String(body.length) },
    body,
  );
}

function jsonReq(payload: unknown): IncomingMessage {
  const body = Buffer.from(JSON.stringify(payload));
  return makeReq(
    { "content-type": "application/json", "content-length": String(body.length) },
    body,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let themeDir: string;

beforeEach(() => {
  themeDir = mkdtempSync(join(tmpdir(), "vibespot-brand-"));
  mockSession = { themePath: themeDir, themeName: "test-theme", updatedAt: 0 };
  saveSession.mockClear();
});

afterEach(() => {
  rmSync(themeDir, { recursive: true, force: true });
  mockSession = null;
});

describe("brand-assets multipart upload", () => {
  it("accepts a UTF-8 markdown file and persists it", async () => {
    const { res, done, result } = makeRes();
    handleBrandAssetsRoute("POST", multipartReq("styleguide", "guide.md", Buffer.from("# Brand\n\nPrimary: #ff0000\n")), res);
    await done;

    expect(result().status).toBe(200);
    expect(result().body.ok).toBe(true);
    expect((mockSession as any).brandAssets.styleguide).toContain("# Brand");
    const written = join(themeDir, ".vibespot", "styleguide.md");
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf8")).toContain("Primary: #ff0000");
    expect(saveSession).toHaveBeenCalled();
  });

  it("rejects binary content (NUL bytes, e.g. UTF-16 or a mis-picked binary)", async () => {
    const { res, done, result } = makeRes();
    // "hello" encoded as UTF-16LE — every other byte is NUL
    handleBrandAssetsRoute("POST", multipartReq("brandvoice", "voice.txt", Buffer.from("hello", "utf16le")), res);
    await done;

    expect(result().status).toBe(400);
    expect(result().body.error).toMatch(/plain text/i);
    expect((mockSession as any).brandAssets?.brandvoice).toBeUndefined();
  });

  it("rejects invalid UTF-8", async () => {
    const { res, done, result } = makeRes();
    handleBrandAssetsRoute("POST", multipartReq("brandvoice", "voice.md", Buffer.from([0xff, 0xfe, 0x41, 0x42, 0xc3])), res);
    await done;

    expect(result().status).toBe(400);
  });

  it("rejects files over the 1 MB cap with 413", async () => {
    const { res, done, result } = makeRes();
    const big = Buffer.alloc(1024 * 1024 + 10, 0x61); // 'a'
    handleBrandAssetsRoute("POST", multipartReq("styleguide", "big.md", big), res);
    await done;

    expect(result().status).toBe(413);
    expect((mockSession as any).brandAssets?.styleguide).toBeUndefined();
  });

  it("rejects an unknown asset type", async () => {
    const { res, done, result } = makeRes();
    handleBrandAssetsRoute("POST", multipartReq("evil", "x.md", Buffer.from("hi")), res);
    await done;

    expect(result().status).toBe(400);
    expect(result().body.error).toMatch(/Invalid type/);
  });

  it("rejects a multipart request with no file part", async () => {
    const { res, done, result } = makeRes();
    const body = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="type"\r\n\r\nstyleguide\r\n--${BOUNDARY}--\r\n`,
    );
    const req = makeReq(
      { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, "content-length": String(body.length) },
      body,
    );
    handleBrandAssetsRoute("POST", req, res);
    await done;

    expect(result().status).toBe(400);
    expect(result().body.error).toMatch(/file is required/);
  });
});

describe("brand-assets JSON path (unchanged behavior)", () => {
  it("still accepts {type, content} JSON", async () => {
    const { res, done, result } = makeRes();
    handleBrandAssetsRoute("POST", jsonReq({ type: "themeContext", content: "Context here" }), res);
    await done;

    expect(result().status).toBe(200);
    expect((mockSession as any).brandAssets.themeContext).toBe("Context here");
    expect(existsSync(join(themeDir, ".vibespot", "theme-context.md"))).toBe(true);
  });

  it("still handles the humanify toggle", async () => {
    const { res, done, result } = makeRes();
    handleBrandAssetsRoute("POST", jsonReq({ type: "humanify", content: "on" }), res);
    await done;

    expect(result().status).toBe(200);
    expect((mockSession as any).brandAssets.humanify).toBe(true);
  });

  it("404s with no active session", async () => {
    mockSession = null;
    const { res, done, result } = makeRes();
    handleBrandAssetsRoute("POST", jsonReq({ type: "styleguide", content: "x" }), res);
    await done;

    expect(result().status).toBe(404);
  });
});
