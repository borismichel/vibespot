/**
 * File upload route — handles images (page assets) and documents (AI context).
 *
 * Images are copied to theme/assets/ and sent to AI as vision input.
 * Documents (PDF, DOCX, MD, TXT) are text-extracted for AI context only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createWriteStream, mkdirSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import Busboy from "busboy";
import { jsonResponse } from "../route-helpers.js";
import { getSession, addSessionAsset, type SessionAsset } from "../session.js";
import { log } from "../log.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const IMAGE_MIMES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/svg+xml",
  "image/webp", "image/gif",
]);

const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown", "text/plain",
]);

const SUPPORTED_MIMES = new Set([...IMAGE_MIMES, ...DOCUMENT_MIMES]);

// Browsers often report .md files as application/octet-stream or empty string
const EXT_MIME_MAP: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".markdown": "text/markdown",
};

function resolveMime(originalName: string, reportedMime: string): string {
  if (SUPPORTED_MIMES.has(reportedMime)) return reportedMime;
  const ext = originalName.slice(originalName.lastIndexOf(".")).toLowerCase();
  return EXT_MIME_MAP[ext] ?? reportedMime;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize a filename for safe filesystem use. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** Deduplicate filename if it already exists in the target directory. */
function deduplicateFilename(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const base = name.slice(0, -ext.length || undefined);
  let counter = 1;
  while (existsSync(join(dir, `${base}-${counter}${ext}`))) counter++;
  return `${base}-${counter}${ext}`;
}

/** Extract text from a PDF file using pdf-parse. */
async function extractPdfText(filePath: string): Promise<string> {
  const pdfParse = (await import("pdf-parse")).default;
  const buffer = readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

/** Extract text from a DOCX file using mammoth. */
async function extractDocxText(filePath: string): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

/** Read plain text or markdown file. */
function extractPlainText(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export function handleFileUploadRoute(req: IncomingMessage, res: ServerResponse): void {
  const session = getSession();
  if (!session) {
    jsonResponse(res, 400, { error: "No active session" });
    return;
  }

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    jsonResponse(res, 400, { error: "Expected multipart/form-data" });
    return;
  }

  const results: SessionAsset[] = [];
  const errors: string[] = [];
  let fileCount = 0;
  const writePromises: Promise<void>[] = [];

  const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE, files: 10 } });

  bb.on("file", (fieldname, fileStream, info) => {
    const { filename: originalName, mimeType: rawMime } = info;
    fileCount++;

    const mimeType = resolveMime(originalName, rawMime);
    if (!SUPPORTED_MIMES.has(mimeType)) {
      errors.push(`Unsupported file type: ${originalName} (${rawMime})`);
      fileStream.resume(); // drain the stream
      return;
    }

    const isImage = IMAGE_MIMES.has(mimeType);
    const sanitized = sanitizeFilename(originalName);
    const id = randomUUID();

    // Determine storage path
    let targetDir: string;
    let finalFilename: string;

    if (isImage) {
      // Images go to theme/assets/
      targetDir = join(session.themePath, "assets");
      mkdirSync(targetDir, { recursive: true });
      finalFilename = deduplicateFilename(targetDir, sanitized);
    } else {
      // Documents go to .vibespot/uploads/ (context only)
      targetDir = join(session.themePath, ".vibespot", "uploads");
      mkdirSync(targetDir, { recursive: true });
      finalFilename = `${id}-${sanitized}`;
    }

    const targetPath = join(targetDir, finalFilename);
    const writeStream = createWriteStream(targetPath);
    let fileSize = 0;
    let truncated = false;

    fileStream.on("data", (chunk: Buffer) => {
      fileSize += chunk.length;
    });

    fileStream.on("limit", () => {
      truncated = true;
      errors.push(`File too large (>10MB): ${originalName}`);
    });

    fileStream.pipe(writeStream);

    // Track each file write as a promise so we can await them all
    writePromises.push(new Promise<void>((resolve) => {
      writeStream.on("finish", () => {
        if (!truncated) {
          const asset: SessionAsset = {
            id,
            filename: finalFilename,
            originalName,
            type: isImage ? "image" : "document",
            usage: isImage ? "asset" : "context",
            mimeType,
            size: fileSize,
            addedAt: new Date().toISOString(),
          };
          results.push(asset);
          addSessionAsset(asset);
        }
        resolve();
      });
      writeStream.on("error", () => {
        errors.push(`Failed to write: ${originalName}`);
        resolve();
      });
    }));
  });

  bb.on("finish", async () => {
    // Wait for all file writes to complete before responding
    await Promise.all(writePromises);

    // Extract text from documents
    for (const asset of results) {
      if (asset.type === "document") {
        const filePath = join(session.themePath, ".vibespot", "uploads", asset.filename);
        try {
          if (asset.mimeType === "application/pdf") {
            asset.extractedText = await extractPdfText(filePath);
          } else if (asset.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
            asset.extractedText = await extractDocxText(filePath);
          } else {
            asset.extractedText = extractPlainText(filePath);
          }
          log.info("upload", `Extracted text from ${asset.originalName} (${asset.extractedText.length} chars)`);
        } catch (err) {
          log.warn("upload", `Failed to extract text from ${asset.originalName}: ${err}`);
          asset.extractedText = `[Could not extract text from ${asset.originalName}]`;
        }
      }
    }

    if (fileCount === 0) {
      jsonResponse(res, 400, { error: "No files uploaded" });
      return;
    }

    jsonResponse(res, 200, {
      files: results.map((a) => ({
        id: a.id,
        filename: a.filename,
        originalName: a.originalName,
        type: a.type,
        usage: a.usage,
        size: a.size,
      })),
      errors: errors.length > 0 ? errors : undefined,
    });
  });

  bb.on("error", (err) => {
    log.error("upload", `Busboy error: ${err}`);
    jsonResponse(res, 500, { error: "Upload failed" });
  });

  req.pipe(bb);
}

// ---------------------------------------------------------------------------
// Get uploaded asset data (for AI context)
// ---------------------------------------------------------------------------

export interface UploadedFileContext {
  id: string;
  filename: string;
  originalName: string;
  type: "image" | "document";
  usage: "asset" | "context";
  /** Base64-encoded image data (for vision API) */
  base64?: string;
  mimeType: string;
  /** Extracted text content (for documents) */
  extractedText?: string;
  /** Asset path for get_asset_url() references */
  assetPath?: string;
}

/** Load full context for uploaded files by their IDs. */
export function getFileContexts(fileIds: string[]): UploadedFileContext[] {
  const session = getSession();
  if (!session?.assets) return [];

  return fileIds
    .map((id) => {
      const asset = session.assets!.find((a) => a.id === id);
      if (!asset) return null;

      const ctx: UploadedFileContext = {
        id: asset.id,
        filename: asset.filename,
        originalName: asset.originalName,
        type: asset.type,
        usage: asset.usage,
        mimeType: asset.mimeType,
      };

      if (asset.type === "image") {
        // Load base64 for vision API
        const imgPath = join(session.themePath, "assets", asset.filename);
        if (existsSync(imgPath)) {
          ctx.base64 = readFileSync(imgPath).toString("base64");
        }
        ctx.assetPath = `${session.themeName}/assets/${asset.filename}`;
      } else if (asset.type === "document") {
        // Load extracted text
        ctx.extractedText = asset.extractedText;
      }

      return ctx;
    })
    .filter((c): c is UploadedFileContext => c !== null);
}

/** Get the asset manifest (list of all image assets) for the AI system prompt. */
export function getAssetManifest(): string[] {
  const session = getSession();
  if (!session?.assets) return [];
  return session.assets
    .filter((a) => a.type === "image" && a.usage === "asset")
    .map((a) => a.filename);
}
