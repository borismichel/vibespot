/**
 * Parallel theme uploader — walks a theme directory and uploads all files
 * to HubSpot via the CMS Source Code API v3.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { uploadFile, type HubSpotApiError, type UploadResult } from "./api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadFileError {
  file: string;
  status: number;
  message: string;
  category?: string;
  detail?: string;
}

export interface UploadThemeResult {
  success: boolean;
  uploaded: number;
  failed: number;
  total: number;
  errors: UploadFileError[];
}

export interface UploadThemeOptions {
  concurrency?: number;
  onFileStart?: (path: string) => void;
  onFileComplete?: (path: string) => void;
  onFileError?: (path: string, error: UploadFileError) => void;
  onProgress?: (completed: number, total: number) => void;
}

// ---------------------------------------------------------------------------
// Excluded directories
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".vibespot", ".DS_Store"]);

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** Recursively walk a directory and return all file paths. */
function walkDir(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".gitkeep") continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Parallel upload
// ---------------------------------------------------------------------------

/** Run async tasks with bounded concurrency. */
async function parallelMap<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Main upload function
// ---------------------------------------------------------------------------

/**
 * Upload an entire theme directory to HubSpot.
 * Files are uploaded in parallel with configurable concurrency.
 */
export async function uploadTheme(
  pak: string,
  themePath: string,
  themeName: string,
  opts: UploadThemeOptions = {},
): Promise<UploadThemeResult> {
  const concurrency = opts.concurrency ?? 5;

  // Discover all files
  const localFiles = walkDir(themePath);
  const total = localFiles.length;
  let uploaded = 0;
  let failed = 0;
  const errors: UploadFileError[] = [];

  await parallelMap(localFiles, concurrency, async (localPath) => {
    // Map local path to remote path: themeName/relative/path
    const rel = relative(themePath, localPath).replace(/\\/g, "/");
    const remotePath = `${themeName}/${rel}`;

    opts.onFileStart?.(rel);

    const result = await uploadFile(pak, remotePath, localPath);

    if (result.success) {
      uploaded++;
      opts.onFileComplete?.(rel);
    } else {
      failed++;
      const err: UploadFileError = {
        file: rel,
        status: result.error?.status || 0,
        message: result.error?.message || "Unknown error",
        category: result.error?.category,
        detail: result.error?.detail,
      };
      errors.push(err);
      opts.onFileError?.(rel, err);
    }

    opts.onProgress?.(uploaded + failed, total);
  });

  return {
    success: failed === 0,
    uploaded,
    failed,
    total,
    errors,
  };
}

/**
 * Delete a remote path (used for cleaning up stuck modules).
 */
export { deleteFile } from "./api.js";
