import { spawn } from "node:child_process";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { AIEngine, GeneratedAssets, ModuleFiles } from "./engine.js";
import { getConversionGuide } from "./prompts.js";
import { readFile, fileExists } from "../utils/fs.js";

export class GeminiCLIEngine implements AIEngine {
  async convert(opts: {
    sourceDir: string;
    themePath: string;
    conversionGuide: string;
    onProgress: (step: string, detail: string) => void;
  }): Promise<GeneratedAssets> {
    const { sourceDir, themePath, onProgress } = opts;
    const guide = opts.conversionGuide || getConversionGuide();

    const prompt = this.buildFullPrompt(sourceDir, themePath, guide);

    onProgress("convert", "Running Gemini CLI (this may take a few minutes)...");

    // Use async spawn so the event loop stays free for spinner animation
    await new Promise<void>((resolve, reject) => {
      const child = spawn("gemini", ["-p", prompt], {
        cwd: themePath,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        shell: true,
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      child.on("error", (err) => reject(new Error(`Gemini CLI failed: ${err.message}`)));
      child.on("close", (code) => {
        if (code !== 0 && stderr && !stdout) {
          reject(new Error(`Gemini CLI failed: ${stderr}`));
        } else {
          resolve();
        }
      });

      setTimeout(() => {
        child.kill();
        reject(new Error("Gemini CLI timed out after 10 minutes"));
      }, 600_000);
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
