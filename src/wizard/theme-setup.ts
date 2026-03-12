import { join } from "node:path";
import { run } from "../utils/shell.js";
import { fileExists, readFile, writeFile, ensureDir } from "../utils/fs.js";
import * as ui from "../prompts/prompter.js";
import { theme } from "../cli/theme.js";
import { loadConfig, getHubSpotPak } from "../utils/config.js";
import { createThemeScaffold } from "../hubspot/theme-scaffold.js";
import { fetchTheme } from "../hubspot/fetcher.js";

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

    const config = loadConfig();
    const pak = getHubSpotPak();

    if (config.hubspotUploadMode === "cli" || !pak) {
      // CLI fallback
      const result = run(`hs cms fetch "${themeName}" "${themePath}"`);
      if (!result.success) {
        s.stop("Fetch failed");
        ui.logError(
          `Could not fetch theme "${themeName}". Check the name in HubSpot Design Manager.`
        );
        process.exit(1);
      }
    } else {
      // API mode
      try {
        await fetchTheme(pak, themeName, themePath);
      } catch (err) {
        s.stop("Fetch failed");
        ui.logError(
          `Could not fetch theme "${themeName}": ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
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
    s.start("Creating theme...");

    try {
      createThemeScaffold(themePath, themeName);
    } catch (err) {
      s.stop("Creation failed");
      ui.logError(
        `Could not create theme "${themeName}": ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }

    s.stop(`Theme created: ${theme.dim(themePath)}`);
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
