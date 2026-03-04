import { join, basename } from "node:path";
import { run } from "../utils/shell.js";
import * as ui from "../prompts/prompter.js";
import { theme } from "../cli/theme.js";
import {
  parseUploadErrors,
  autoFixError,
  type UploadError,
} from "../server/auto-fix.js";

/** Count "Uploaded file" lines in hs cms upload output */
function countUploadedFiles(output: string): number {
  return (output.match(/^Uploaded file /gm) || []).length;
}

export async function runUpload(themePath: string): Promise<boolean> {
  await ui.intro("Uploading to HubSpot");

  const themeName = basename(themePath) || themePath;
  const s = await ui.spinner();

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    s.start(
      attempt === 1
        ? "Uploading theme..."
        : `Retrying upload (attempt ${attempt}/${MAX_RETRIES})...`
    );

    const result = run(`hs cms upload "${themePath}" "${themeName}"`, {
      cwd: join(themePath, ".."),
    });

    // Combine stdout + stderr — hs cms upload logs success lines and errors to both
    const fullOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const uploadedCount = countUploadedFiles(fullOutput);

    if (result.success) {
      s.stop(`All files uploaded! (${uploadedCount} files)`);
      await ui.outro("Upload complete!");
      return true;
    }

    // Parse errors from combined output
    const errors = parseUploadErrors(fullOutput);

    // If files were uploaded despite errors, tell the user
    if (uploadedCount > 0) {
      s.stop(`${uploadedCount} files uploaded, but some errors occurred`);
    } else {
      s.stop("Upload failed");
    }

    if (errors.length === 0) {
      // Unknown error — show raw output
      ui.logError(`Upload error:\n${fullOutput.slice(0, 500)}`);

      if (uploadedCount > 0) {
        ui.logWarn(
          "Most files uploaded successfully. The theme may already be usable in HubSpot.\n" +
          "You can check your HubSpot Design Manager to verify."
        );
        const proceed = await ui.confirm({
          message: "Continue anyway (theme is likely uploaded)?",
          initialValue: true,
        });
        if (proceed) return true;
      }

      if (attempt < MAX_RETRIES) {
        const retry = await ui.confirm({
          message: "Try uploading again?",
        });
        if (!retry) break;
        continue;
      }
      break;
    }

    // Try to auto-fix known errors
    let anyFixed = false;
    for (const error of errors) {
      if (error.fixable) {
        const fixed = autoFixError(themePath, error);
        if (fixed) {
          ui.logSuccess(`Auto-fixed: ${error.message}`);
          anyFixed = true;
        } else {
          ui.logWarn(`Could not auto-fix: ${error.message}`);
        }
      } else {
        ui.logError(error.message);
      }
    }

    if (anyFixed && attempt < MAX_RETRIES) {
      // Retry after fixes
      continue;
    }

    // If files were uploaded, offer to continue despite errors
    if (uploadedCount > 0) {
      ui.logWarn(
        `${uploadedCount} files uploaded successfully despite errors.\n` +
        "The theme may work — check HubSpot Design Manager."
      );
      const proceed = await ui.confirm({
        message: "Continue anyway?",
        initialValue: true,
      });
      if (proceed) return true;
    }

    if (!anyFixed) {
      // Try removing stuck modules as last resort
      s.start("Cleaning up stuck modules...");
      run(`hs cms delete "${themeName}/modules"`, {
        cwd: join(themePath, ".."),
      });
      s.stop("Cleaned up modules, retrying...");
    }
  }

  ui.logError(
    "Upload failed after multiple attempts. Try running `hs cms upload` manually to see detailed errors."
  );
  return false;
}
