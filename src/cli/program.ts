import { Command } from "commander";
import { wizardCommand } from "../commands/wizard.js";
import { initCommand } from "../commands/init.js";
import { convertCommand } from "../commands/convert.js";
import { uploadCommand } from "../commands/upload.js";
import { doctorCommand } from "../commands/doctor.js";
import { vibeCommand } from "../commands/vibe.js";
import { marketplaceCheckCommand, marketplaceEditCommand } from "../commands/marketplace.js";
import { getVersion } from "../utils/fs.js";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("vibespot")
    .description(
      "AI-powered HubSpot CMS landing page builder"
    )
    .version(getVersion())
    .action(vibeCommand);

  program
    .command("wizard")
    .description("Classic CLI wizard — step-by-step conversion flow")
    .action(wizardCommand);

  program
    .command("init")
    .description("Check and install required tools")
    .action(initCommand);

  program
    .command("convert")
    .description("Convert a React project to HubSpot modules")
    .action(convertCommand);

  program
    .command("upload")
    .description("Upload theme to HubSpot")
    .action(uploadCommand);

  program
    .command("doctor")
    .description("Diagnose environment issues")
    .action(doctorCommand);

  const marketplace = program
    .command("marketplace")
    .description("Prepare a theme for HubSpot Marketplace submission");

  marketplace
    .command("check")
    .description("Audit the theme against Marketplace requirements")
    .option("-p, --path <path>", "Path to the theme directory")
    .option("--json", "Emit machine-readable JSON instead of formatted output")
    .option("--fix", "Apply auto-fixable findings before checking")
    .action((opts) => marketplaceCheckCommand(opts));

  marketplace
    .command("edit")
    .description("Edit Marketplace listing metadata (marketplace.json)")
    .option("-p, --path <path>", "Path to the theme directory")
    .action((opts) => marketplaceEditCommand(opts));

  return program;
}
