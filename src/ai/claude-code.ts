import { spawn } from "node:child_process";
import { join, basename } from "node:path";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import type { AIEngine, GeneratedAssets, ModuleFiles } from "./engine.js";
import { getConversionGuide, getHubspotRules } from "./prompts.js";
import { readFile, fileExists } from "../utils/fs.js";

/** Boilerplate modules from `hs cms create website-theme` — used to distinguish AI-generated modules. */
const BOILERPLATE_MODULES = new Set([
  "button.module",
  "card.module",
  "menu.module",
  "pricing-card.module",
  "social-follow.module",
]);

/** Boilerplate templates from `hs cms create website-theme`. */
const BOILERPLATE_TEMPLATES = new Set([
  "about.html",
  "blog-index.html",
  "blog-post.html",
  "contact.html",
  "home.html",
  "hubdb.html",
  "landing-page.html",
  "pricing.html",
  "qa-test.html",
  "base.html",
]);

export class ClaudeCodeEngine implements AIEngine {
  private model?: string;
  private reported = new Set<string>();
  private moduleCount = 0;
  private expectedModules = 0;

  constructor(model?: string) {
    this.model = model;
  }

  async convert(opts: {
    sourceDir: string;
    themePath: string;
    conversionGuide: string;
    onProgress: (step: string, detail: string) => void;
  }): Promise<GeneratedAssets> {
    const { sourceDir, themePath, onProgress } = opts;
    const guide = opts.conversionGuide || getConversionGuide();

    // Reset progress tracking
    this.reported.clear();
    this.moduleCount = 0;
    this.expectedModules = 0;

    // Count source components to estimate expected modules
    const sourceComponents = this.countSourceComponents(sourceDir);

    // Snapshot existing files so we can detect what Claude actually created
    const existingModules = this.listModules(themePath);
    const existingCss = this.listDir(join(themePath, "css"));
    const existingJs = this.listDir(join(themePath, "js"));
    const existingTemplates = this.listDir(join(themePath, "templates"));

    // Build the prompt for Claude Code
    const prompt = this.buildFullPrompt(sourceDir, themePath, guide);

    onProgress("convert", `Starting Claude Code (${sourceComponents} source components found)...`);

    // Run Claude Code with real-time progress tracking
    let stdout = "";
    let stderr = "";

    // Poll the filesystem every 3s to show progress
    const progressInterval = setInterval(() => {
      this.reportProgress(themePath, existingModules, existingCss, existingJs, existingTemplates, onProgress);
    }, 3000);

    try {
      await new Promise<void>((resolve, reject) => {
        // Strip CLAUDECODE env var to allow running from inside a Claude Code session
        const env = { ...process.env };
        delete env.CLAUDECODE;

        const args = [
          "--print",
          "--max-turns", "50",
          "--allowedTools", "Read,Glob,Grep,Write,Edit,Bash",
        ];
        if (this.model) args.push("--model", this.model);

        const child = spawn("claude", args, {
          cwd: themePath,
          stdio: ["pipe", "pipe", "pipe"],
          env,
        });

        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

        child.on("error", (err) => reject(new Error(`Claude Code failed to start: ${err.message}`)));
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(
              `Claude Code exited with code ${code}.\n` +
              (stderr ? `Stderr: ${stderr.slice(0, 500)}\n` : "") +
              (stdout ? `Output: ${stdout.slice(0, 500)}` : "No output")
            ));
          } else {
            resolve();
          }
        });

        // Handle stdin errors (EPIPE if claude exits before prompt is fully written)
        child.stdin.on("error", () => {});

        // Send prompt via stdin and close
        child.stdin.write(prompt);
        child.stdin.end();

        // 30 min timeout
        setTimeout(() => {
          child.kill();
          reject(new Error("Claude Code timed out after 30 minutes"));
        }, 1_800_000);
      });
    } finally {
      clearInterval(progressInterval);
    }

    // Write full log to workspace for debugging
    const logPath = join(themePath, "..", "vibespot-conversion.log");
    try {
      const timestamp = new Date().toISOString();
      const logContent = [
        `=== vibeSpot Conversion Log ===`,
        `Timestamp: ${timestamp}`,
        `Source: ${sourceDir}`,
        `Theme: ${themePath}`,
        `Model: ${this.model || "default"}`,
        ``,
        `=== PROMPT SENT ===`,
        prompt.slice(0, 500) + "\n... (truncated, full guide follows)",
        ``,
        `=== CLAUDE CODE STDOUT ===`,
        stdout || "(empty)",
        ``,
        `=== CLAUDE CODE STDERR ===`,
        stderr || "(empty)",
        ``,
      ].join("\n");
      writeFileSync(logPath, logContent, "utf-8");
      onProgress("status", `Log written to ${basename(logPath)}`);
    } catch {
      // Non-critical — don't fail if log can't be written
    }

    onProgress("scan", "Scanning generated files...");

    // Scan the theme directory for what Claude Code created
    const result = this.scanGeneratedFiles(themePath);

    // Validate that new files were actually created
    const newModules = result.modules.filter(
      (m) => !existingModules.has(m.moduleName + ".module")
    );

    if (newModules.length === 0) {
      const outputPreview = stdout.slice(0, 1500) || "(no output)";
      const stderrPreview = stderr.slice(0, 500);
      throw new Error(
        "Claude Code did not create any new module files.\n\n" +
        "This usually means the model described the conversion instead of using Write tool to create files.\n\n" +
        "Possible causes:\n" +
        "  - Model didn't use Write tool (just printed text)\n" +
        "  - Claude Code hit a rate limit or API error\n" +
        "  - The source directory was not accessible\n\n" +
        `Source: ${opts.sourceDir}\n` +
        `Theme: ${themePath}\n` +
        (stderrPreview ? `\nStderr:\n${stderrPreview}\n` : "") +
        `\nClaude output:\n${outputPreview}`
      );
    }

    return result;
  }

  /** Poll filesystem and emit "created" events for newly detected files. */
  private reportProgress(
    themePath: string,
    existingModules: Set<string>,
    existingCss: Set<string>,
    existingJs: Set<string>,
    existingTemplates: Set<string>,
    onProgress: (step: string, detail: string) => void,
  ): void {
    let newItems = 0;

    // Check for new CSS files
    const currentCss = this.listDir(join(themePath, "css"));
    for (const f of currentCss) {
      if (existingCss.has(f) || !f.endsWith(".css")) continue;
      const key = `css:${f}`;
      if (!this.reported.has(key)) {
        this.reported.add(key);
        onProgress("created", `Shared CSS (${f})`);
        newItems++;
      }
    }

    // Check for new JS files
    const currentJs = this.listDir(join(themePath, "js"));
    for (const f of currentJs) {
      if (existingJs.has(f) || !f.endsWith(".js")) continue;
      const key = `js:${f}`;
      if (!this.reported.has(key)) {
        this.reported.add(key);
        onProgress("created", `Shared JS (${f})`);
        newItems++;
      }
    }

    // Try to detect expected module count from template file (once it exists)
    if (this.expectedModules === 0) {
      this.expectedModules = this.detectExpectedModules(themePath, existingTemplates);
    }

    // Check for new modules
    const currentModules = this.listModules(themePath);
    for (const mod of currentModules) {
      if (existingModules.has(mod)) continue;
      const key = `module:${mod}`;
      if (!this.reported.has(key)) {
        this.reported.add(key);
        this.moduleCount++;
        const counter = this.expectedModules > 0
          ? `[${this.moduleCount}/${this.expectedModules}]`
          : `[${this.moduleCount}]`;
        onProgress("created", `Module ${counter}: ${mod.replace(".module", "")}`);
        newItems++;
      }
    }

    // Check for new templates
    const currentTemplates = this.listDir(join(themePath, "templates"));
    for (const f of currentTemplates) {
      if (existingTemplates.has(f) || !f.endsWith(".html")) continue;
      const key = `template:${f}`;
      if (!this.reported.has(key)) {
        this.reported.add(key);
        onProgress("created", `Page template (${f})`);
        newItems++;
      }
    }

    // Update spinner status text (only if no new items were just logged)
    if (newItems === 0) {
      if (this.moduleCount > 0) {
        const of = this.expectedModules > 0 ? `/${this.expectedModules}` : "";
        onProgress("status", `${this.moduleCount}${of} modules created, conversion continuing...`);
      } else if (this.reported.size > 0) {
        onProgress("status", "Shared assets created, building modules...");
      } else {
        onProgress("status", "Claude Code is analyzing source files...");
      }
    }
  }

  private buildFullPrompt(
    sourceDir: string,
    themePath: string,
    guide: string
  ): string {
    return `You are converting a React landing page to native HubSpot CMS modules.

SOURCE DIRECTORY: ${sourceDir}
THEME DIRECTORY: ${themePath}

IMPORTANT — YOU MUST CREATE REAL FILES:
You have access to Write, Edit, Read, Glob, Grep, and Bash tools. You MUST use the Write tool to create each file. Do NOT just describe or list what files should be created — actually call the Write tool for every single file. If you do not call Write, no files will be created and the conversion will fail.

STEP-BY-STEP PROCESS:
1. Use Glob to find all .tsx/.jsx files in ${sourceDir}/src/
2. Use Read to read each component file and understand the page structure
3. Use Write to create a shared CSS file at ${themePath}/css/<name>-theme.css
   - Include CSS custom properties, design system variables, utility classes
   - Add theme-override countermeasures (.body-wrapper:has(), scoped !important overrides)
4. Use Write to create a shared JS file at ${themePath}/js/<name>-animations.js
   - Convert React hooks to vanilla JS (IntersectionObserver for scroll animations)
   - IIFE wrapper, DOMContentLoaded setup
5. For EACH visual section of the page, use Write to create ALL FOUR files:
   a. ${themePath}/modules/<name>.module/fields.json
      - Editable fields for the section content
      - NEVER use "textarea" type (use "text" instead)
      - NEVER use "name" as a field name (use "item_name" instead)
      - Add a "styles" group with "tab": "STYLE" containing color pickers
   b. ${themePath}/modules/<name>.module/meta.json
      - Must include: host_template_types: ["PAGE"], is_available_for_new_content: true
   c. ${themePath}/modules/<name>.module/module.html
      - HubL template that renders the section (convert JSX to HubL)
   d. ${themePath}/modules/<name>.module/module.css
      - REQUIRED — complete vanilla CSS for this section
      - Must include: layout, spacing, colors, typography, backgrounds, gradients, shadows, borders, hover effects, responsive breakpoints
      - Convert ALL Tailwind classes to BEM-style CSS. Do NOT skip this file.
6. Use Write to create a page template at ${themePath}/templates/lp-<name>.html
   - Annotation: templateType: page, isAvailableForNewContent: true
   - Extends "./layouts/base.html"
   - Sets template_css and template_js variables
   - Wraps modules in dnd_area with dnd_section containers
7. Read ${themePath}/templates/layouts/base.html and ensure it supports template_css and template_js variables

CSS QUALITY: The converted page must visually match the original React page. Every module.css must be self-contained with complete styling for that section.

Do NOT run hs upload — I will handle that separately.

HUBSPOT CMS RULES:
${getHubspotRules()}

CONVERSION GUIDE:
${guide}`;
  }

  private scanGeneratedFiles(themePath: string): GeneratedAssets {
    const result: GeneratedAssets = {
      sharedCss: "",
      sharedJs: "",
      template: "",
      modules: [],
    };

    // Find shared CSS (any non-boilerplate CSS in css/)
    const cssDir = join(themePath, "css");
    if (fileExists(cssDir)) {
      for (const file of readdirSync(cssDir)) {
        if (
          file.endsWith(".css") &&
          file !== "theme-overrides.css" &&
          file !== "main.css" &&
          file !== "style.css"
        ) {
          result.sharedCss = readFile(join(cssDir, file));
          break;
        }
      }
    }

    // Find shared JS (any non-boilerplate JS in js/)
    const jsDir = join(themePath, "js");
    if (fileExists(jsDir)) {
      for (const file of readdirSync(jsDir)) {
        if (
          file.endsWith(".js") &&
          file !== "main.js"
        ) {
          result.sharedJs = readFile(join(jsDir, file));
          break;
        }
      }
    }

    // Find new template (prefer lp-* or non-boilerplate templates)
    const templatesDir = join(themePath, "templates");
    if (fileExists(templatesDir)) {
      // First pass: look for lp-* templates (AI-generated naming convention)
      for (const file of readdirSync(templatesDir)) {
        if (file.startsWith("lp-") && file.endsWith(".html")) {
          result.template = readFile(join(templatesDir, file));
          break;
        }
      }
      // Second pass: any non-boilerplate template with dnd_area
      if (!result.template) {
        for (const file of readdirSync(templatesDir)) {
          if (
            file.endsWith(".html") &&
            !BOILERPLATE_TEMPLATES.has(file) &&
            !file.startsWith("system")
          ) {
            const content = readFile(join(templatesDir, file));
            if (content.includes("dnd_area")) {
              result.template = content;
              break;
            }
          }
        }
      }
      // Third pass: fall back to any template with dnd_area
      if (!result.template) {
        for (const file of readdirSync(templatesDir)) {
          if (
            file.endsWith(".html") &&
            !file.startsWith("system") &&
            file !== "base.html"
          ) {
            const content = readFile(join(templatesDir, file));
            if (content.includes("dnd_area")) {
              result.template = content;
              break;
            }
          }
        }
      }
    }

    // Scan modules/
    const modulesDir = join(themePath, "modules");
    if (fileExists(modulesDir)) {
      for (const entry of readdirSync(modulesDir)) {
        if (!entry.endsWith(".module")) continue;
        const modDir = join(modulesDir, entry);
        if (!statSync(modDir).isDirectory()) continue;

        const moduleFiles: ModuleFiles = {
          moduleName: entry.replace(".module", ""),
          fieldsJson: "",
          metaJson: "",
          moduleHtml: "",
          moduleCss: "",
        };

        const fj = join(modDir, "fields.json");
        if (fileExists(fj)) moduleFiles.fieldsJson = readFile(fj);

        const mj = join(modDir, "meta.json");
        if (fileExists(mj)) moduleFiles.metaJson = readFile(mj);

        const mh = join(modDir, "module.html");
        if (fileExists(mh)) moduleFiles.moduleHtml = readFile(mh);

        const mc = join(modDir, "module.css");
        if (fileExists(mc)) moduleFiles.moduleCss = readFile(mc);

        const mjs = join(modDir, "module.js");
        if (fileExists(mjs)) moduleFiles.moduleJs = readFile(mjs);

        // Only count modules that have at least fields.json and module.html
        if (moduleFiles.fieldsJson && moduleFiles.moduleHtml) {
          result.modules.push(moduleFiles);
        }
      }
    }

    return result;
  }

  /** List module directories in modules/ */
  private listModules(themePath: string): Set<string> {
    const modulesDir = join(themePath, "modules");
    if (!fileExists(modulesDir)) return new Set();
    return new Set(
      readdirSync(modulesDir).filter((e) => e.endsWith(".module"))
    );
  }

  /** List files in a directory */
  private listDir(dir: string): Set<string> {
    if (!fileExists(dir)) return new Set();
    return new Set(readdirSync(dir));
  }

  /** Detect expected module count from template file (counts dnd_module references) */
  private detectExpectedModules(themePath: string, existingTemplates: Set<string>): number {
    const templatesDir = join(themePath, "templates");
    if (!fileExists(templatesDir)) return 0;

    for (const file of readdirSync(templatesDir)) {
      if (existingTemplates.has(file)) continue;
      if (!file.endsWith(".html") || file === "base.html" || file.startsWith("system")) continue;

      try {
        const content = readFile(join(templatesDir, file));
        if (content.includes("dnd_area")) {
          const matches = content.match(/dnd_module/g);
          return matches ? matches.length : 0;
        }
      } catch {
        // Skip unreadable files
      }
    }
    return 0;
  }

  /** Count .tsx/.jsx component files in the source directory */
  private countSourceComponents(sourceDir: string): number {
    const srcDir = join(sourceDir, "src");
    if (!fileExists(srcDir)) return 0;
    return this.countComponentsRecursive(srcDir);
  }

  private countComponentsRecursive(dir: string): number {
    let count = 0;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory() && entry !== "node_modules" && entry !== ".git") {
          count += this.countComponentsRecursive(fullPath);
        } else if (/\.(tsx|jsx)$/.test(entry) && !entry.includes(".test.") && !entry.includes(".spec.")) {
          count++;
        }
      } catch {
        // Skip unreadable entries
      }
    }
    return count;
  }
}
