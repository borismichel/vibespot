import { printBanner } from "../cli/banner.js";
import { setupSource } from "../wizard/source.js";
import { setupTheme } from "../wizard/theme-setup.js";
import { runConversion } from "../wizard/conversion.js";
import { loadConfig } from "../utils/config.js";
import * as ui from "../prompts/prompter.js";

export async function convertCommand(): Promise<void> {
  printBanner();

  const config = loadConfig();

  if (!config.aiEngine) {
    ui.logError(
      "AI engine not configured. Run `vibespot init` first or use the full wizard with `vibespot`."
    );
    process.exit(1);
  }

  const source = await setupSource();
  const themeInfo = await setupTheme();

  await runConversion({
    aiEngine: config.aiEngine,
    sourceDir: source.sourceDir,
    themePath: themeInfo.themePath,
  });
}
