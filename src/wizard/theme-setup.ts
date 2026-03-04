import { join } from "node:path";
import { readdirSync, renameSync } from "node:fs";
import { run, runPassthrough } from "../utils/shell.js";
import { fileExists, readFile, writeFile, ensureDir } from "../utils/fs.js";
import * as ui from "../prompts/prompter.js";
import { theme } from "../cli/theme.js";

export interface ThemeInfo {
  themePath: string;
  themeName: string;
}

export async function setupTheme(): Promise<ThemeInfo> {
  await ui.intro("HubSpot Theme Setup");

  const choice = await ui.select({
    message: "Do you have an existing HubSpot theme?",
    options: [
      {
        value: "fetch" as const,
        label: "Fetch my existing theme from HubSpot",
        hint: "downloads your current theme",
      },
      {
        value: "create" as const,
        label: "Start fresh (HubSpot Boilerplate)",
        hint: "creates a new starter theme",
      },
    ],
  });

  let themeName: string;
  let themePath: string;

  const workspaceDir = join(process.cwd(), "workspace");
  ensureDir(workspaceDir);

  if (choice === "fetch") {
    themeName = await ui.text({
      message: "What's your theme name in HubSpot?",
      placeholder: "My-Company-Theme",
      validate: (v) =>
        v.trim() ? undefined : "Theme name is required",
    });

    themePath = join(workspaceDir, themeName);

    const s = await ui.spinner();
    s.start("Fetching theme from HubSpot...");

    const result = run(`hs cms fetch "${themeName}" "${themePath}"`);
    if (!result.success) {
      s.stop("Fetch failed");
      ui.logError(
        `Could not fetch theme "${themeName}". Check the name in HubSpot Design Manager.`
      );
      ui.logError('Run `hs cms list /` to see available themes.');
      process.exit(1);
    }

    s.stop(`Theme fetched: ${theme.dim(themePath)}`);
  } else {
    themeName = await ui.text({
      message: "Name for your new theme:",
      placeholder: "my-theme",
      defaultValue: "my-theme",
    });

    themePath = join(workspaceDir, themeName);

    const s = await ui.spinner();
    s.start("Creating theme from boilerplate...");

    // Snapshot cwd contents before hs create to detect what it creates
    const cwdBefore = new Set(readdirSync(process.cwd()));

    // hs create always creates in process.cwd(), ignoring execSync cwd
    const result = run(`hs cms create website-theme "${themeName}"`);

    // Find the created directory — hs create may use exact name or a variant
    let createdAt = join(process.cwd(), themeName);
    if (!fileExists(createdAt)) {
      // Fallback: find any new directory that appeared in cwd
      const cwdAfter = readdirSync(process.cwd());
      const newDir = cwdAfter.find((e) => !cwdBefore.has(e) && fileExists(join(process.cwd(), e)));
      if (newDir) {
        createdAt = join(process.cwd(), newDir);
      }
    }

    if (!result.success || !fileExists(createdAt)) {
      s.stop("Creation failed");
      const errMsg = result.stderr || result.stdout || "";
      ui.logError(
        `Could not create theme "${themeName}".` +
        (errMsg ? `\n${errMsg.slice(0, 300)}` : "") +
        "\nTry running manually: hs cms create website-theme my-theme"
      );
      process.exit(1);
    }

    // Move from cwd into workspace/
    if (createdAt !== themePath) {
      renameSync(createdAt, themePath);
    }

    s.stop(`Theme created: ${theme.dim(themePath)}`);

    // Rename theme label from "CMS theme boilerplate" to the user's chosen name
    const themeJsonPath = join(themePath, "theme.json");
    if (fileExists(themeJsonPath)) {
      try {
        const themeJson = JSON.parse(readFile(themeJsonPath));
        themeJson.label = themeName;
        writeFile(themeJsonPath, JSON.stringify(themeJson, null, 2) + "\n");
        ui.logSuccess(`Theme label set to "${themeName}"`);
      } catch {
        ui.logWarn("Could not update theme.json label — you can rename it manually in HubSpot.");
      }
    }
  }

  // Validate and patch
  await ui.intro("Checking theme compatibility");

  const baseHtmlPath = join(themePath, "templates/layouts/base.html");
  if (!fileExists(baseHtmlPath)) {
    ui.logError(
      `base.html not found at ${baseHtmlPath}. Your theme may have a different structure.`
    );
    process.exit(1);
  }
  ui.logSuccess("base.html found");

  // Check for template_css and template_js support
  let baseHtml = readFile(baseHtmlPath);
  let patched = false;

  if (!baseHtml.includes("template_css")) {
    ui.logWarn("Missing template_css support in base.html");

    // Find the line with require_css for theme-overrides or the last require_css
    const cssInsertPoint =
      baseHtml.indexOf("theme-overrides.css") !== -1
        ? baseHtml.indexOf(
            "{{",
            baseHtml.lastIndexOf("\n", baseHtml.indexOf("theme-overrides.css"))
          )
        : baseHtml.lastIndexOf("require_css");

    if (cssInsertPoint > 0) {
      const insertBefore = baseHtml.lastIndexOf("\n", cssInsertPoint);
      const block = `\n  {% if template_css %}\n    {{ require_css(get_asset_url(template_css)) }}\n  {% endif %}`;
      baseHtml =
        baseHtml.slice(0, insertBefore) + block + baseHtml.slice(insertBefore);
      patched = true;
    }
  } else {
    ui.logSuccess("template_css support");
  }

  if (!baseHtml.includes("template_js")) {
    ui.logWarn("Missing template_js support in base.html");

    // Find the line with require_js for main.js or the last require_js
    const jsLine = baseHtml.indexOf("require_js");
    if (jsLine > 0) {
      const lineEnd = baseHtml.indexOf("\n", jsLine);
      // Find the end of the require_js line (including closing tags)
      const nextLine = baseHtml.indexOf("\n", lineEnd + 1);
      const block = `\n  {% if template_js %}\n    {{ require_js(get_asset_url(template_js)) }}\n  {% endif %}`;
      const insertAt =
        baseHtml.indexOf("}}", jsLine) + 2 + baseHtml.slice(baseHtml.indexOf("}}", jsLine) + 2).indexOf("\n") + 1;
      baseHtml =
        baseHtml.slice(0, baseHtml.indexOf("\n", baseHtml.indexOf("}}", jsLine) + 2)) +
        block +
        baseHtml.slice(baseHtml.indexOf("\n", baseHtml.indexOf("}}", jsLine) + 2));
      patched = true;
    }
  } else {
    ui.logSuccess("template_js support");
  }

  if (patched) {
    const s = await ui.spinner();
    s.start("Patching base.html...");
    writeFile(baseHtmlPath, baseHtml);
    s.stop("base.html patched with template_css/template_js support");
  }

  // Check .hsignore
  const hsignorePath = join(themePath, ".hsignore");
  if (fileExists(hsignorePath)) {
    const hsignore = readFile(hsignorePath);
    if (!hsignore.includes("docs/")) {
      writeFile(hsignorePath, hsignore + "\ndocs/\n");
      ui.logSuccess("Added docs/ to .hsignore");
    }
  } else {
    writeFile(hsignorePath, "docs/\n*.md\nnode_modules/\n.git\n");
    ui.logSuccess("Created .hsignore");
  }

  await ui.outro("Theme ready!");

  return { themePath, themeName };
}
