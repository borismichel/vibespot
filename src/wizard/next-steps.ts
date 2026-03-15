import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { basename } from "node:path";
import * as ui from "../prompts/prompter.js";
import { theme } from "../cli/theme.js";
import { detectDataCenter } from "../utils/detect.js";
import { fileExists } from "../utils/fs.js";

export async function showNextSteps(opts: {
  portalId: string;
  sourceDir: string;
  themePath: string;
  wasCloned: boolean;
}): Promise<void> {
  const { portalId, sourceDir, themePath, wasCloned } = opts;
  await ui.intro("You're all set!");

  const dataCenter = detectDataCenter(portalId);
  const host =
    dataCenter === "eu1" ? "app-eu1.hubspot.com" : "app.hubspot.com";

  await ui.note(
    `Your React page has been converted and uploaded to HubSpot.\n` +
      `The theme and modules are now in your account, but you still\n` +
      `need to ${theme.bold("create a new landing page")} that uses them.\n\n` +
      `Next steps:\n\n` +
      `  ${theme.bold("1.")} Go to HubSpot ${theme.muted("→")} Content ${theme.muted("→")} Landing Pages ${theme.muted("→")} Create\n` +
      `  ${theme.bold("2.")} Choose your uploaded theme from the theme picker\n` +
      `  ${theme.bold("3.")} Select the landing page template that was just created\n` +
      `  ${theme.bold("4.")} Your converted modules will appear — drag them onto the page\n` +
      `  ${theme.bold("5.")} Click each section to edit text, images, and colors\n` +
      `  ${theme.bold("6.")} Upload images via File Manager ${theme.muted("(Settings → Files)")}\n` +
      `  ${theme.bold("7.")} Preview and publish!`,
    "What's next"
  );

  const openBrowser = await ui.confirm({
    message: "Open HubSpot Landing Pages in your browser?",
  });

  if (openBrowser) {
    const url = portalId
      ? `https://${host}/page-ui/${portalId}/management/pages/landing`
      : `https://${host}`;

    try {
      // Cross-platform browser open
      const platform = process.platform;
      if (platform === "darwin") {
        execFileSync("open", [url], { stdio: "ignore" });
      } else if (platform === "win32") {
        execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
      } else {
        execFileSync("xdg-open", [url], { stdio: "ignore" });
      }
      ui.logSuccess("Opening HubSpot Landing Pages...");
    } catch {
      ui.log(`Open this URL in your browser: ${theme.info(url)}`);
    }
  }

  // Offer to clean up local directories
  const dirsToClean: { path: string; label: string }[] = [];
  if (wasCloned && fileExists(sourceDir)) {
    dirsToClean.push({ path: sourceDir, label: `Cloned source (${basename(sourceDir)})` });
  }
  if (fileExists(themePath)) {
    dirsToClean.push({ path: themePath, label: `Theme directory (${basename(themePath)})` });
  }

  if (dirsToClean.length > 0) {
    const cleanup = await ui.confirm({
      message: "Clean up local working directories?",
    });

    if (cleanup) {
      for (const dir of dirsToClean) {
        try {
          rmSync(dir.path, { recursive: true, force: true });
          ui.logSuccess(`Removed ${dir.label}`);
        } catch {
          ui.logWarn(`Could not remove ${dir.label} — delete manually if needed.`);
        }
      }
    }
  }

  await ui.outro(`Thanks for using hub${theme.vibes("Vibes")}! ${theme.vibes("~")}`);
}
