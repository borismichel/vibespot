/**
 * Shared engine for "simple" CLI converters (Codex CLI, Gemini CLI) — the
 * engines that pipe one prompt via stdin and then scan the theme directory
 * for whatever the CLI wrote (VIB-1902).
 *
 * The subprocess itself runs through the maintained `spawnCLI` helper
 * (`src/server/ai-engines.ts`), so timer cleanup, strict exit-code handling,
 * stdin backpressure, and abort semantics stay in one place instead of
 * drifting per engine. Claude Code keeps its own engine (`claude-code.ts`) —
 * it genuinely differs (filesystem progress polling, conversion log,
 * new-module validation).
 */

import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { AIEngine, GeneratedAssets, ModuleFiles } from "./engine.js";
import { getConversionGuide } from "./prompts.js";
import { readFile, fileExists } from "../utils/fs.js";
import { spawnCLI } from "../server/ai-engines.js";

export interface SimpleCLIEngineConfig {
  /** Binary to spawn (resolved from PATH). */
  binary: string;
  /** Static CLI args — the prompt always goes via stdin. */
  args: string[];
  /** Spinner line shown while the CLI runs. */
  progressMessage: string;
  timeoutMs: number;
}

export class SimpleCLIEngine implements AIEngine {
  constructor(private readonly config: SimpleCLIEngineConfig) {}

  async convert(opts: {
    sourceDir: string;
    themePath: string;
    conversionGuide: string;
    onProgress: (step: string, detail: string) => void;
  }): Promise<GeneratedAssets> {
    const { sourceDir, themePath, onProgress } = opts;
    const guide = opts.conversionGuide || getConversionGuide();

    const prompt = this.buildFullPrompt(sourceDir, themePath, guide);

    onProgress("convert", this.config.progressMessage);

    await spawnCLI(this.config.binary, this.config.args, prompt, undefined, this.config.timeoutMs, undefined, {
      cwd: themePath,
      // Windows needs shell to resolve .cmd shims from PATH; args are static
      shell: process.platform === "win32",
    });

    onProgress("scan", "Scanning generated files...");

    return this.scanGeneratedFiles(themePath);
  }

  private buildFullPrompt(
    sourceDir: string,
    themePath: string,
    guide: string
  ): string {
    return `Read the conversion guide below, then convert the React landing page at ${sourceDir} into native HubSpot CMS modules for the theme at ${themePath}.

INSTRUCTIONS:
1. Analyze all .tsx/.jsx components in the React source
2. Create a shared CSS file in css/ with design system variables, utilities, and theme-override countermeasures
3. Create a shared JS file in js/ for scroll animations and interactive features
4. For each visual section, create a HubSpot module in modules/ with fields.json, meta.json, module.html, module.css
5. Add a styles group with "tab": "STYLE" and color pickers to each module
6. Create a page template in templates/ that assembles all modules
7. Make sure base.html supports template_css and template_js variables

CONVERSION GUIDE:
${guide}

Do NOT run hs upload — I will handle that separately.
Create all files directly in the theme directory.`;
  }

  private scanGeneratedFiles(themePath: string): GeneratedAssets {
    const result: GeneratedAssets = {
      sharedCss: "",
      sharedJs: "",
      template: "",
      modules: [],
    };

    const cssDir = join(themePath, "css");
    if (fileExists(cssDir)) {
      for (const file of readdirSync(cssDir)) {
        if (
          (file.includes("theme") || file.includes("page")) &&
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

    const jsDir = join(themePath, "js");
    if (fileExists(jsDir)) {
      for (const file of readdirSync(jsDir)) {
        if (
          (file.includes("animation") || file.includes("page")) &&
          file.endsWith(".js") &&
          file !== "main.js"
        ) {
          result.sharedJs = readFile(join(jsDir, file));
          break;
        }
      }
    }

    const templatesDir = join(themePath, "templates");
    if (fileExists(templatesDir)) {
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

        if (moduleFiles.fieldsJson && moduleFiles.moduleHtml) {
          result.modules.push(moduleFiles);
        }
      }
    }

    return result;
  }
}
