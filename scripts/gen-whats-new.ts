/**
 * gen-whats-new.ts — release-workflow step (VIB-1885).
 *
 * Parses the current version's section out of CHANGELOG.md and writes
 * assets/whats-new.json, the content the "What's new" dialog shows once after
 * an upgrade. Run automatically as part of `npm run build` (so a published
 * package always ships content matching its version) and documented as an
 * explicit release step.
 *
 *   npm run whatsnew:gen        # regenerate assets/whats-new.json
 *
 * Defensive by design: any parse failure still writes a valid JSON file with an
 * empty `highlights` array (the server then reports `show:false`), so a build is
 * never blocked and the dialog never renders empty.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG_URL = "https://github.com/borismichel/vibespot/blob/main/CHANGELOG.md";
const MAX_HIGHLIGHTS = 5;
const MAX_BODY_CHARS = 200;

interface Highlight {
  title: string;
  body: string;
}
interface WhatsNew {
  version: string;
  date: string;
  changelogUrl: string;
  highlights: Highlight[];
}

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return String(pkg.version || "");
}

/** Strip markdown to plain text: links → text, drop code ticks / emphasis / issue refs. */
function clean(md: string): string {
  return md
    .replace(/\(\[[^\]]*\]\([^)]*\)\)/g, "") // (\[VIB-1883](/…)) issue-ref parenthetical
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/[`*_]/g, "")                    // code/emphasis marks
    .replace(/\s+/g, " ")
    .trim();
}

/** Trim a body to a sentence-ish, word-boundary snippet with an ellipsis. */
function snippet(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  const firstSentence = text.match(/^(.+?[.!?])(\s|$)/);
  if (firstSentence && firstSentence[1].length >= 40 && firstSentence[1].length <= MAX_BODY_CHARS) {
    return firstSentence[1];
  }
  const cut = text.slice(0, MAX_BODY_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/, "") + "…";
}

/** Extract the section body for `version` (or the first released section as a fallback). */
function extractSection(changelog: string, version: string): { date: string; body: string } | null {
  const lines = changelog.split("\n");
  // Match `## <version> — <date>` (em dash or hyphen, date optional).
  const headingRe = (v: string) =>
    new RegExp(`^##\\s+${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b\\s*[—-]?\\s*(.*)$`);
  let start = -1;
  let date = "";
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe(version));
    if (m) { start = i; date = m[1].trim(); break; }
  }
  // Fallback: first `## x.y.z` heading.
  if (start === -1) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^##\s+(\d+\.\d+\.\d+)\s*[—-]?\s*(.*)$/);
      if (m) { start = i; date = m[2].trim(); break; }
    }
  }
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\d/.test(lines[i])) break; // next version section
    body.push(lines[i]);
  }
  return { date, body: body.join("\n") };
}

/** Pull top-level `- **Title** … — body` bullets into highlights. */
function parseHighlights(sectionBody: string): Highlight[] {
  const out: Highlight[] = [];
  // Top-level bullets only (no leading indent), bold lead acts as the title.
  const bulletRe = /^- \*\*(.+?)\*\*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = bulletRe.exec(sectionBody)) !== null && out.length < MAX_HIGHLIGHTS) {
    const title = clean(m[1]);
    let rest = m[2];
    const dash = rest.indexOf(" — ");
    const bodyRaw = dash !== -1 ? rest.slice(dash + 3) : rest;
    const body = snippet(clean(bodyRaw));
    if (title) out.push({ title, body });
  }
  return out;
}

function main(): void {
  const version = readVersion();
  const out: WhatsNew = { version, date: "", changelogUrl: CHANGELOG_URL, highlights: [] };
  try {
    const changelogPath = join(ROOT, "CHANGELOG.md");
    if (existsSync(changelogPath) && version) {
      const changelog = readFileSync(changelogPath, "utf8");
      const section = extractSection(changelog, version);
      if (section) {
        out.date = section.date;
        out.highlights = parseHighlights(section.body);
      }
    }
  } catch (err) {
    console.warn(`[whatsnew] could not parse CHANGELOG, writing empty content: ${(err as Error).message}`);
  }
  const dest = join(ROOT, "assets", "whats-new.json");
  writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
  console.log(`[whatsnew] wrote ${dest} — v${out.version}, ${out.highlights.length} highlight(s)`);
}

main();
