import Anthropic from "@anthropic-ai/sdk";
import { join, basename } from "node:path";
import { readdirSync } from "node:fs";
import type { AIEngine, GeneratedAssets, ModuleFiles } from "./engine.js";
import {
  buildSystemPrompt,
  buildCssPrompt,
  buildJsPrompt,
  buildModulePrompt,
  buildTemplatePrompt,
} from "./prompts.js";
import { readFile, fileExists, writeFile, ensureDir } from "../utils/fs.js";
import { reportModelUsage } from "../server/langfuse.js";
import { mapAnthropicUsage } from "../server/pricing.js";

export class ClaudeAPIEngine implements AIEngine {
  private client: Anthropic;
  private model = "claude-sonnet-4-6";

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
    });
  }

  async convert(opts: {
    sourceDir: string;
    themePath: string;
    conversionGuide: string;
    onProgress: (step: string, detail: string) => void;
  }): Promise<GeneratedAssets> {
    const { sourceDir, themePath, conversionGuide, onProgress } = opts;
    const systemPrompt = buildSystemPrompt(conversionGuide);

    // Determine a page prefix from the source dir name
    const dirName = basename(sourceDir) || "page";
    const pagePrefix = dirName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 15);

    // Step 1: Generate shared CSS
    onProgress("css", "Analyzing design system...");
    const indexCss = this.findAndReadCSS(sourceDir);
    const tailwindConfig = this.findAndReadTailwind(sourceDir);

    const cssContent = await this.complete(
      systemPrompt,
      buildCssPrompt(indexCss, tailwindConfig, pagePrefix)
    );
    const cssPath = join(themePath, "css", `${pagePrefix}-theme.css`);
    writeFile(cssPath, cssContent);
    onProgress("css-done", `Created css/${pagePrefix}-theme.css`);

    // Step 2: Generate shared JS
    onProgress("js", "Creating shared JavaScript...");
    const hooksSource = this.findAndReadHooks(sourceDir);
    const interactiveSource = this.findInteractiveComponents(sourceDir);

    const jsContent = await this.complete(
      systemPrompt,
      buildJsPrompt(hooksSource, interactiveSource, pagePrefix)
    );
    const jsPath = join(themePath, "js", `${pagePrefix}-animations.js`);
    writeFile(jsPath, jsContent);
    onProgress("js-done", `Created js/${pagePrefix}-animations.js`);

    // Step 3: Generate modules
    onProgress("modules", "Building modules...");
    const components = this.findComponents(sourceDir);
    const modules: ModuleFiles[] = [];

    for (let i = 0; i < components.length; i++) {
      const comp = components[i];
      const moduleName = comp.name
        .replace(/Section$/, "")
        .replace(/([A-Z])/g, " $1")
        .trim();

      onProgress(
        "module",
        `Building ${moduleName}.module (${i + 1}/${components.length})...`
      );

      const source = readFile(comp.path);
      const response = await this.complete(
        systemPrompt,
        buildModulePrompt(source, moduleName, `See css/${pagePrefix}-theme.css`)
      );

      try {
        const parsed = JSON.parse(response);
        // A response missing fieldsJson/metaJson must not reach disk:
        // JSON.stringify(undefined) yields undefined and the writes below
        // throw after partial files exist (VIB-1894). Skip the module instead.
        const fieldsJson = typeof parsed.fieldsJson === "string"
          ? parsed.fieldsJson
          : parsed.fieldsJson != null
            ? JSON.stringify(parsed.fieldsJson, null, 2)
            : null;
        const metaJson = typeof parsed.metaJson === "string"
          ? parsed.metaJson
          : parsed.metaJson != null
            ? JSON.stringify(parsed.metaJson, null, 2)
            : null;
        if (!fieldsJson || !metaJson) {
          throw new Error("Response is missing fieldsJson or metaJson");
        }
        const mod: ModuleFiles = {
          moduleName,
          fieldsJson,
          metaJson,
          moduleHtml: parsed.moduleHtml || "",
          moduleCss: parsed.moduleCss || "",
          moduleJs: parsed.moduleJs || undefined,
        };

        // Write module files
        const modDir = join(themePath, "modules", `${moduleName}.module`);
        ensureDir(modDir);
        writeFile(join(modDir, "fields.json"), mod.fieldsJson);
        writeFile(join(modDir, "meta.json"), mod.metaJson);
        writeFile(join(modDir, "module.html"), mod.moduleHtml);
        writeFile(join(modDir, "module.css"), mod.moduleCss);
        if (mod.moduleJs) writeFile(join(modDir, "module.js"), mod.moduleJs);

        modules.push(mod);
        onProgress("module-done", `${moduleName}.module (${this.countFiles(mod)} files)`);
      } catch {
        onProgress("module-error", `Failed to parse ${moduleName} — skipping`);
      }
    }

    // Step 4: Generate template
    onProgress("template", "Creating page template...");
    const moduleNames = modules.map((m) => m.moduleName);
    const templateContent = await this.complete(
      systemPrompt,
      buildTemplatePrompt(moduleNames, dirName, pagePrefix)
    );

    const templatePath = join(
      themePath,
      "templates",
      `lp-${pagePrefix}.html`
    );
    writeFile(templatePath, templateContent);
    onProgress("template-done", `Created templates/lp-${pagePrefix}.html`);

    return {
      sharedCss: cssContent,
      sharedJs: jsContent,
      template: templateContent,
      modules,
    };
  }

  private async complete(system: string, user: string): Promise<string> {
    const startTime = new Date();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: [
        {
          type: "text",
          text: system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: user }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const text = textBlock?.text || "";

    reportModelUsage({
      engine: "anthropic-api",
      model: this.model,
      name: "react-conversion",
      input: { system, messages: [{ role: "user", content: user }] },
      output: text,
      usage: mapAnthropicUsage(response.usage),
      startTime,
      endTime: new Date(),
    });

    return text;
  }

  private findAndReadCSS(dir: string): string {
    const paths = [
      join(dir, "src/index.css"),
      join(dir, "src/globals.css"),
      join(dir, "src/app/globals.css"),
      join(dir, "app/globals.css"),
    ];
    for (const p of paths) {
      if (fileExists(p)) return readFile(p);
    }
    return "";
  }

  private findAndReadTailwind(dir: string): string {
    const paths = [
      join(dir, "tailwind.config.ts"),
      join(dir, "tailwind.config.js"),
      join(dir, "tailwind.config.mjs"),
    ];
    for (const p of paths) {
      if (fileExists(p)) return readFile(p);
    }
    return "";
  }

  private findAndReadHooks(dir: string): string {
    const hooksDir = join(dir, "src/hooks");
    if (!fileExists(hooksDir)) return "";
    try {
      return readdirSync(hooksDir)
        .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
        .map((f) => `// ${f}\n${readFile(join(hooksDir, f))}`)
        .join("\n\n");
    } catch {
      return "";
    }
  }

  private findInteractiveComponents(dir: string): string {
    const components = this.findComponents(dir);
    const interactive: string[] = [];

    for (const comp of components) {
      const content = readFile(comp.path);
      if (
        /carousel|accordion|typing|parallax|embla|swiper|collapsible/i.test(
          content
        )
      ) {
        interactive.push(`// ${comp.name}\n${content}`);
      }
    }

    return interactive.join("\n\n");
  }

  private findComponents(dir: string): { name: string; path: string }[] {
    const searchDirs = [
      join(dir, "src/components/landing"),
      join(dir, "src/components/sections"),
      join(dir, "src/components"),
    ];

    for (const searchDir of searchDirs) {
      if (!fileExists(searchDir)) continue;
      try {
        return readdirSync(searchDir)
          .filter(
            (f) =>
              (f.endsWith(".tsx") || f.endsWith(".jsx")) &&
              !f.startsWith("ui") &&
              f !== "index.tsx" &&
              f !== "index.jsx"
          )
          .map((f) => ({
            name: f.replace(/\.(tsx|jsx)$/, ""),
            path: join(searchDir, f),
          }));
      } catch {
        continue;
      }
    }

    return [];
  }

  private countFiles(mod: ModuleFiles): number {
    let count = 3; // fields.json, meta.json, module.html always present
    if (mod.moduleCss) count++;
    if (mod.moduleJs) count++;
    return count;
  }
}
