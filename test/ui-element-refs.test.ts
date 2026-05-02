/**
 * UI Element Reference Validator
 *
 * Validates that every getElementById / querySelector("#id") call in ui/*.js
 * either references an ID that exists in ui/index.html OR is inside a function
 * that dynamically creates the element (innerHTML / createElement pattern).
 *
 * Run: npx tsx test/ui-element-refs.test.ts
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const UI_DIR = join(import.meta.dirname, "..", "ui");
const HTML_PATH = join(UI_DIR, "index.html");

// ─── Extract static IDs from HTML ───────────────────────────────────────────

function extractHtmlIds(html: string): Set<string> {
  const ids = new Set<string>();
  const re = /\bid=["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) ids.add(m[1]);
  return ids;
}

// ─── Extract JS element references ──────────────────────────────────────────

interface JsRef {
  file: string;
  line: number;
  id: string;
  hasNullGuard: boolean;
  context: string; // the full line for diagnostics
}

function extractJsRefs(filePath: string, source: string): JsRef[] {
  const refs: JsRef[] = [];
  const lines = source.split("\n");
  const fileName = filePath.split("/").pop()!;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // getElementById("x")
    const getById = /getElementById\(["']([^"']+)["']\)(\??)\./g;
    let m: RegExpExecArray | null;
    while ((m = getById.exec(line))) {
      refs.push({
        file: fileName,
        line: lineNum,
        id: m[1],
        hasNullGuard: m[2] === "?",
        context: line.trim(),
      });
    }

    // querySelector("#x") — extract the ID portion
    const qs = /querySelector\(["']#([a-zA-Z0-9_-]+)["']\)(\??)\./g;
    while ((m = qs.exec(line))) {
      refs.push({
        file: fileName,
        line: lineNum,
        id: m[1],
        hasNullGuard: m[2] === "?",
        context: line.trim(),
      });
    }
  }

  return refs;
}

// ─── Detect dynamically-created IDs ─────────────────────────────────────────
// If an ID appears in an innerHTML template string in the same file,
// it's likely created dynamically and safe to reference.

function extractDynamicIds(source: string): Set<string> {
  const ids = new Set<string>();
  const re = /id=(?:\\?["'])([^"'\\]+)(?:\\?["'])/g;
  let m: RegExpExecArray | null;
  // Only check inside template literals and string concatenation (innerHTML patterns)
  const templateBlocks = source.match(/`[^`]*`|innerHTML\s*=\s*["'][^;]+/g) || [];
  for (const block of templateBlocks) {
    while ((m = re.exec(block))) ids.add(m[1]);
  }
  return ids;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function validate(): { errors: string[]; warnings: string[]; totalRefs: number; jsFileCount: number; htmlIdCount: number } {
  const html = readFileSync(HTML_PATH, "utf-8");
  const htmlIds = extractHtmlIds(html);

  const jsFiles = readdirSync(UI_DIR).filter((f) => f.endsWith(".js"));

  const errors: string[] = [];
  const warnings: string[] = [];
  let totalRefs = 0;

  for (const jsFile of jsFiles) {
    const filePath = join(UI_DIR, jsFile);
    const source = readFileSync(filePath, "utf-8");
    const refs = extractJsRefs(filePath, source);
    const dynamicIds = extractDynamicIds(source);

    totalRefs += refs.length;

    for (const ref of refs) {
      const existsInHtml = htmlIds.has(ref.id);
      const isDynamic = dynamicIds.has(ref.id);

      if (!existsInHtml && !isDynamic) {
        if (ref.hasNullGuard) {
          warnings.push(
            `  WARN  ${ref.file}:${ref.line} — "#${ref.id}" not in HTML (null-guarded, won't crash but is dead code)`
          );
        } else {
          errors.push(
            `  FAIL  ${ref.file}:${ref.line} — "#${ref.id}" not in HTML and NO null guard → will crash if reached`
          );
        }
      }
    }
  }

  return { errors, warnings, totalRefs, jsFileCount: jsFiles.length, htmlIdCount: htmlIds.size };
}

// ─── Vitest / Standalone mode ───────────────────────────────────────────────

if (process.env.VITEST) {
  const { describe, it, expect } = await import("vitest");
  describe("UI Element Reference Validator", () => {
    it("all JS element references point to existing HTML IDs", () => {
      const { errors, warnings } = validate();
      if (warnings.length > 0) {
        console.log("Warnings (dead code):", warnings);
      }
      expect(errors, errors.join("\n")).toHaveLength(0);
    });
  });
} else {
  const { errors, warnings, totalRefs, jsFileCount, htmlIdCount } = validate();

  console.log("\n  UI Element Reference Validator");
  console.log("  ─────────────────────────────\n");
  console.log(`  Scanned ${jsFileCount} JS files, ${totalRefs} element references, ${htmlIdCount} HTML IDs\n`);

  if (errors.length > 0) {
    console.log("  ERRORS (will crash at runtime):\n");
    for (const e of errors) console.log(e);
    console.log();
  }

  if (warnings.length > 0) {
    console.log("  WARNINGS (dead code — element not in HTML but null-guarded):\n");
    for (const w of warnings) console.log(w);
    console.log();
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log("  ✓ All element references are valid\n");
  }

  const exitCode = errors.length > 0 ? 1 : 0;
  console.log(`  Result: ${errors.length} errors, ${warnings.length} warnings`);
  console.log(`  Exit code: ${exitCode}\n`);

  process.exit(exitCode);
}
