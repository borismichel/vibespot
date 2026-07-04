import { join, basename } from "node:path";
import { runFile } from "../utils/shell.js";
import * as ui from "../prompts/prompter.js";
import { theme } from "../cli/theme.js";
import {
  parseUploadErrors,
  parseApiErrors,
  autoFixError,
  type UploadError,
} from "../server/auto-fix.js";
import { loadConfig, getHubSpotPak } from "../utils/config.js";
import { uploadTheme, deleteFile } from "../hubspot/uploader.js";

/** Count "Uploaded file" lines in hs cms upload output */
function countUploadedFiles(output: string): number {
  return (output.match(/^Uploaded file /gm) || []).length;
}

export async function runUpload(themePath: string): Promise<boolean> {
  await ui.intro("Uploading to HubSpot");

  const themeName = basename(themePath) || themePath;
  const config = loadConfig();
  const pak = getHubSpotPak();
  const useApi = config.hubspotUploadMode !== "cli" && !!pak;
  const s = await ui.spinner();

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    s.start(
      attempt === 1
        ? "Uploading theme..."
        : `Retrying upload (attempt ${attempt}/${MAX_RETRIES})...`
    );

    let errors: UploadError[] = [];
    let uploadedCount = 0;
    let success = false;

    if (useApi) {
      // API mode — parallel upload
      const result = await uploadTheme(pak!, themePath, themeName, {
        onFileComplete: () => { uploadedCount++; },
      });
      success = result.success;
      if (!success) {
        errors = parseApiErrors(result.errors);
      } else {
        uploadedCount = result.uploaded;
      }
    } else {
      // CLI mode — argv array, never a shell-interpolated string
      const result = runFile("hs", ["cms", "upload", themePath, themeName], {
        cwd: join(themePath, ".."),
      });
      const fullOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
      uploadedCount = countUploadedFiles(fullOutput);
      success = result.success;
      if (!success) {
        errors = parseUploadErrors(fullOutput);
      }
    }

    if (success) {
      s.stop(`All files uploaded! (${uploadedCount} files)`);
      await ui.outro("Upload complete!");
      return true;
    }

    if (uploadedCount > 0) {
      s.stop(`${uploadedCount} files uploaded, but some errors occurred`);
    } else {
      s.stop("Upload failed");
    }

    if (errors.length === 0) {
      ui.logError("Upload failed with unknown error.");

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
        const retry = await ui.confirm({ message: "Try uploading again?" });
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

    if (anyFixed && attempt < MAX_RETRIES) continue;

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
      s.start("Cleaning up stuck modules...");
      if (useApi) {
        try { await deleteFile(pak!, `${themeName}/modules`); } catch { /* ignore */ }
      } else {
        runFile("hs", ["cms", "delete", `${themeName}/modules`], { cwd: join(themePath, "..") });
      }
      s.stop("Cleaned up modules, retrying...");
    }
  }

  ui.logError("Upload failed after multiple attempts.");
  return false;
}
