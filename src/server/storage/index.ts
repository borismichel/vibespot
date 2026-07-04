/**
 * Storage module — public API.
 *
 * Usage:
 *   import { getStorage, initStorage } from "../storage/index.js";
 *   await initStorage();
 *   const storage = getStorage();
 */

export type { StorageAdapter, FileEntry, ModuleOnDisk } from "./types.js";
export { FileSystemStorageAdapter } from "./fs-adapter.js";

import type { StorageAdapter } from "./types.js";
import { FileSystemStorageAdapter } from "./fs-adapter.js";

let _adapter: StorageAdapter | null = null;

/**
 * Initialize the storage adapter. Call once at startup.
 */
export async function initStorage(): Promise<StorageAdapter> {
  _adapter = new FileSystemStorageAdapter();
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
