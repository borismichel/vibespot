/**
 * Re-export shim — session logic lives in session/ directory.
 * Kept for ESM import compatibility (NodeNext resolves ./session.js to file, not session/index.js).
 */
export * from "./session/index.js";
