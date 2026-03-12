/**
 * Theme fetcher — downloads an existing theme from HubSpot
 * via the CMS Source Code API v3. Replaces `hs cms fetch`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { getMetadata, downloadFile, type FileMetadata } from "./api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FetchThemeOptions {
  onFile?: (path: string) => void;
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// Recursive directory listing
// ---------------------------------------------------------------------------

/** Recursively list all files under a remote path. */
async function listFilesRecursive(pak: string, remotePath: string): Promise<string[]> {
  const meta = await getMetadata(pak, remotePath);
  if (!meta) return [];

  if (!meta.folder) return [meta.path || remotePath];

  const files: string[] = [];
  const rawChildren = meta.children || [];

  for (const child of rawChildren) {
    // HubSpot API returns children as plain strings (folder/file names) or as objects
    const childName = typeof child === "string" ? child : (child as FileMetadata).name;
    if (!childName) continue;
    const childPath = `${remotePath}/${childName}`;

    if (typeof child === "string") {
      // String children — need to fetch metadata to determine if folder or file
      files.push(...(await listFilesRecursive(pak, childPath)));
    } else {
      const childMeta = child as FileMetadata;
      if (childMeta.folder) {
        files.push(...(await listFilesRecursive(pak, childMeta.path || childPath)));
      } else {
        files.push(childMeta.path || childPath);
      }
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Parallel download
// ---------------------------------------------------------------------------

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
// Main fetch function
// ---------------------------------------------------------------------------

/**
 * Fetch (download) an entire theme from HubSpot to a local directory.
 */
export async function fetchTheme(
  pak: string,
  themeName: string,
  targetPath: string,
  opts: FetchThemeOptions = {},
): Promise<void> {
  const concurrency = opts.concurrency ?? 5;

  // List all files in the remote theme
  const remoteFiles = await listFilesRecursive(pak, themeName);

  if (remoteFiles.length === 0) {
    throw new Error(`Theme "${themeName}" not found on HubSpot or is empty`);
  }

  // Download all files in parallel
  mkdirSync(targetPath, { recursive: true });

  await parallelMap(remoteFiles, concurrency, async (remotePath) => {
    // Strip theme name prefix to get relative path
    const relativePath = remotePath.startsWith(themeName + "/")
      ? remotePath.slice(themeName.length + 1)
      : remotePath;

    const localPath = join(targetPath, relativePath);

    // Ensure directory exists
    mkdirSync(dirname(localPath), { recursive: true });

    // Download and write
    const content = await downloadFile(pak, remotePath);
    writeFileSync(localPath, content);

    opts.onFile?.(relativePath);
  });
}
