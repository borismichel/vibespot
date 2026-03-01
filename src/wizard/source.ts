import { readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { run } from "../utils/shell.js";
import { fileExists, readFile } from "../utils/fs.js";
import * as ui from "../prompts/prompter.js";
import { theme } from "../cli/theme.js";

export interface ComponentInfo {
  name: string;
  path: string;
  description: string;
}

export interface SourceAnalysis {
  sourceDir: string;
  wasCloned: boolean;
  components: ComponentInfo[];
  hasTailwind: boolean;
  cssVarCount: number;
  fonts: string[];
  interactions: string[];
}

function findComponents(dir: string): ComponentInfo[] {
  const components: ComponentInfo[] = [];

  // Common locations for landing page components
  const searchDirs = [
    join(dir, "src/components/landing"),
    join(dir, "src/components/sections"),
    join(dir, "src/components"),
    join(dir, "src/pages"),
    join(dir, "app/components"),
    join(dir, "components"),
  ];

  for (const searchDir of searchDirs) {
    if (!fileExists(searchDir)) continue;

    try {
      const files = readdirSync(searchDir);
      for (const file of files) {
        const filePath = join(searchDir, file);
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;

        const ext = extname(file);
        if (![".tsx", ".jsx"].includes(ext)) continue;

        // Skip utility/UI components
        const name = basename(file, ext);
        if (name.startsWith("ui") || name === "index") continue;

        // Read the file to extract a description
        const content = readFile(filePath);
        const desc = describeComponent(name, content);

        components.push({ name, path: filePath, description: desc });
      }
    } catch {
      // Directory read failed, skip
    }
  }

  return components;
}

function describeComponent(name: string, content: string): string {
  const hints: string[] = [];

  if (/carousel|slider|swiper|embla/i.test(content)) hints.push("carousel");
  if (/accordion|collapsible|expand/i.test(content)) hints.push("accordion");
  if (/form|submit|input.*email/i.test(content)) hints.push("form");
  if (/nav|navigation|menu/i.test(content)) hints.push("navigation");
  if (/hero|headline|tagline/i.test(content)) hints.push("hero");
  if (/footer|copyright/i.test(content)) hints.push("footer");
  if (/testimonial|quote|review/i.test(content)) hints.push("testimonials");
  if (/pricing|plan|tier/i.test(content)) hints.push("pricing");
  if (/faq|question.*answer/i.test(content)) hints.push("FAQ");
  if (/feature|benefit|advantage/i.test(content)) hints.push("features");
  if (/contact|get.in.touch/i.test(content)) hints.push("contact");
  if (/cta|call.to.action/i.test(content)) hints.push("CTA");
  if (/team|member|bio/i.test(content)) hints.push("team");

  if (hints.length === 0) {
    // Fallback: infer from component name
    const readable = name
      .replace(/Section$/, "")
      .replace(/([A-Z])/g, " $1")
      .trim();
    return readable;
  }

  return hints.join(", ");
}

function analyzeCSS(dir: string): { varCount: number; fonts: string[] } {
  const cssFiles = [
    join(dir, "src/index.css"),
    join(dir, "src/globals.css"),
    join(dir, "src/app/globals.css"),
    join(dir, "app/globals.css"),
  ];

  let varCount = 0;
  const fonts: string[] = [];

  for (const cssFile of cssFiles) {
    if (!fileExists(cssFile)) continue;

    const content = readFile(cssFile);
    const varMatches = content.match(/--[\w-]+:/g);
    if (varMatches) varCount += varMatches.length;

    const fontMatches = content.match(
      /font-family:\s*['"]([^'"]+)['"]/g
    );
    if (fontMatches) {
      for (const m of fontMatches) {
        const font = m.match(/['"]([^'"]+)['"]/)?.[1];
        if (font && !fonts.includes(font)) fonts.push(font);
      }
    }

    const importMatches = content.match(
      /@import\s+url\([^)]*fonts\.googleapis\.com[^)]*family=([^&)]+)/g
    );
    if (importMatches) {
      for (const m of importMatches) {
        const font = m.match(/family=([^&)]+)/)?.[1]?.replace(/\+/g, " ");
        if (font && !fonts.includes(font)) fonts.push(font);
      }
    }
  }

  return { varCount, fonts };
}

function detectInteractions(dir: string): string[] {
  const interactions: string[] = [];

  const hooksDir = join(dir, "src/hooks");
  if (fileExists(hooksDir)) {
    try {
      const hooks = readdirSync(hooksDir);
      for (const hook of hooks) {
        if (/scroll/i.test(hook)) interactions.push("Scroll animations");
        if (/intersection/i.test(hook)) interactions.push("Scroll animations");
      }
    } catch {
      // Ignore
    }
  }

  // Check landing components for patterns
  const componentDir = join(dir, "src/components/landing");
  if (fileExists(componentDir)) {
    try {
      const files = readdirSync(componentDir);
      for (const file of files) {
        if (!file.endsWith(".tsx") && !file.endsWith(".jsx")) continue;
        const content = readFile(join(componentDir, file));
        if (/carousel|embla|swiper/i.test(content) && !interactions.includes("Carousel"))
          interactions.push("Carousel");
        if (/accordion|collapsible/i.test(content) && !interactions.includes("Accordion"))
          interactions.push("Accordion");
        if (/typing|typewriter/i.test(content) && !interactions.includes("Typing animation"))
          interactions.push("Typing animation");
        if (/parallax|requestAnimationFrame/i.test(content) && !interactions.includes("Parallax"))
          interactions.push("Parallax");
      }
    } catch {
      // Ignore
    }
  }

  if (interactions.length === 0) {
    interactions.push("Scroll animations");
  }

  return interactions;
}

/**
 * Headless source analysis — called from the vibe server (no interactive prompts).
 * Clones the repo if it's a URL, then analyzes components.
 */
export function analyzeSource(input: string): SourceAnalysis {
  let sourceDir: string;
  let wasCloned = false;

  if (input.startsWith("http") || input.startsWith("git@")) {
    wasCloned = true;
    const repoName =
      basename(input.replace(/\.git$/, "")) || "react-source";
    sourceDir = join(process.cwd(), "workspace", repoName);

    if (!fileExists(sourceDir)) {
      const result = run(`git clone --depth 1 "${input}" "${sourceDir}"`);
      if (!result.success) {
        throw new Error(`Failed to clone ${input}: ${result.stderr}`);
      }
    }
  } else {
    sourceDir = input;
    if (!fileExists(sourceDir)) {
      throw new Error(`Directory not found: ${sourceDir}`);
    }
  }

  const components = findComponents(sourceDir);
  const hasTailwind =
    fileExists(join(sourceDir, "tailwind.config.ts")) ||
    fileExists(join(sourceDir, "tailwind.config.js"));
  const { varCount, fonts } = analyzeCSS(sourceDir);
  const interactions = detectInteractions(sourceDir);

  return {
    sourceDir,
    wasCloned,
    components,
    hasTailwind,
    cssVarCount: varCount,
    fonts,
    interactions,
  };
}

export async function setupSource(): Promise<SourceAnalysis> {
  await ui.intro("Source Project");

  const input = await ui.text({
    message: "GitHub URL or local path to your React project:",
    placeholder: "https://github.com/user/my-lovable-page",
    validate: (v) => {
      if (!v.trim()) return "Please enter a URL or path";
      return undefined;
    },
  });

  let sourceDir: string;
  let wasCloned = false;

  if (input.startsWith("http") || input.startsWith("git@")) {
    wasCloned = true;
    // Clone from GitHub
    const repoName =
      basename(input.replace(/\.git$/, "")) || "react-source";
    sourceDir = join(process.cwd(), "workspace", repoName);

    if (fileExists(sourceDir)) {
      // Already cloned from a previous run — reuse it
      ui.logSuccess(`Using existing clone: ${theme.dim(sourceDir)}`);
    } else {
      const s = await ui.spinner();
      s.start("Cloning repository...");

      const result = run(`git clone --depth 1 "${input}" "${sourceDir}"`);
      if (!result.success) {
        s.stop("Clone failed");
        ui.logError(
          `Failed to clone ${input}. Check the URL and your access permissions.`
        );
        process.exit(1);
      }

      s.stop(`Cloned to ${theme.dim(sourceDir)}`);
    }
  } else {
    sourceDir = input;
    if (!fileExists(sourceDir)) {
      ui.logError(`Directory not found: ${sourceDir}`);
      process.exit(1);
    }
    ui.logSuccess(`Using local source: ${theme.dim(sourceDir)}`);
  }

  // Analyze
  const s = await ui.spinner();
  s.start("Analyzing project structure...");

  const components = findComponents(sourceDir);
  const hasTailwind =
    fileExists(join(sourceDir, "tailwind.config.ts")) ||
    fileExists(join(sourceDir, "tailwind.config.js"));
  const { varCount, fonts } = analyzeCSS(sourceDir);
  const interactions = detectInteractions(sourceDir);

  s.stop(`Found ${components.length} landing page components`);

  if (components.length === 0) {
    ui.logWarn(
      "No components found. Make sure the React source has .tsx/.jsx files in src/components/"
    );
    process.exit(1);
  }

  // Show summary
  const componentList = components
    .map((c, i) => `  ${theme.dim(`${i + 1}.`)} ${theme.bold(c.name)} ${theme.muted(`— ${c.description}`)}`)
    .join("\n");

  const cssInfo = hasTailwind
    ? `Tailwind + custom CSS (${varCount} variables)`
    : `Custom CSS (${varCount} variables)`;
  const fontInfo = fonts.length > 0 ? fonts.join(", ") : "System fonts";
  const jsInfo = interactions.join(", ");

  await ui.note(
    `${componentList}\n\n  CSS:  ${cssInfo}\n  JS:   ${jsInfo}\n  Font: ${fontInfo}`,
    `${components.length} components detected`
  );

  const ok = await ui.confirm({ message: "Does this look right?" });
  if (!ok) {
    ui.logError("Please adjust your source directory and try again.");
    process.exit(0);
  }

  await ui.outro("Source analyzed!");

  return {
    sourceDir,
    wasCloned,
    components,
    hasTailwind,
    cssVarCount: varCount,
    fonts,
    interactions,
  };
}
