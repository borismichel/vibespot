/**
 * Storage module — public API.
 *
 * Usage:
 *   import { getStorage, initStorage } from "../storage/index.js";
 *   await initStorage("filesystem"); // or "postgres" with connection string
 *   const storage = getStorage();
 */

export type { StorageAdapter, FileEntry, ModuleOnDisk } from "./types.js";
export { FileSystemStorageAdapter } from "./fs-adapter.js";
export { PostgresStorageAdapter } from "./pg-adapter.js";

import type { StorageAdapter } from "./types.js";
import { FileSystemStorageAdapter } from "./fs-adapter.js";
import { PostgresStorageAdapter } from "./pg-adapter.js";

let _adapter: StorageAdapter | null = null;

export type StorageBackend = "filesystem" | "postgres";

export interface StorageConfig {
  backend: StorageBackend;
  postgresUrl?: string;
}

/**
 * Initialize the storage adapter. Call once at startup.
 */
export async function initStorage(config: StorageConfig): Promise<StorageAdapter> {
  if (config.backend === "postgres") {
    if (!config.postgresUrl) {
      throw new Error("PostgresStorageAdapter requires a postgresUrl");
    }
    // Dynamic import to avoid bundling pg when not needed
    const { default: pg } = await import("pg" as string);
    const pool = new pg.Pool({ connectionString: config.postgresUrl });
    _adapter = new PostgresStorageAdapter(pool);
  } else {
    _adapter = new FileSystemStorageAdapter();
  }
  return _adapter;
}

/**
 * Get the active storage adapter. Throws if not initialized.
 */
export function getStorage(): StorageAdapter {
  if (!_adapter) {
    // Default to filesystem for CLI mode (lazy init)
    _adapter = new FileSystemStorageAdapter();
  }
  return _adapter;
}

/**
 * Replace the adapter (for testing).
 */
export function setStorage(adapter: StorageAdapter): void {
  _adapter = adapter;
}
