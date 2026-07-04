/**
 * `vibespot email` — Email template generation mode.
 * Starts the same local server as vibe mode but with email content type pre-selected.
 */

import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __owndir = dirname(fileURLToPath(import.meta.url));
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { startServer } from "../server/server.js";
import { saveSession } from "../server/session.js";

const DEFAULT_PORT = 4200;

export async function emailCommand(): Promise<void> {
  const accent = chalk.hex("#e8613a");
  const dim = chalk.dim;

  console.log("");
  console.log(accent("  v vibeSpot — Email Mode"));
  console.log(dim("  Starting...\n"));

  const uiDir = resolveUiDir();
  if (!uiDir) {
    console.error(chalk.red("  Could not find UI assets. Is the package installed correctly?"));
    process.exit(1);
  }

  try {
    const { port, host, authToken, close } = await startServer({ port: DEFAULT_PORT, uiDir, contentMode: "email" });
    const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
    const url = `http://${displayHost}:${port}${authToken ? `/?token=${authToken}` : ""}`;

    console.log(accent(`  v ${url}`));
    if (authToken) {
      console.log(dim("  Access requires this exact URL — the token is your auth secret."));
    }
    console.log(dim("  Email template mode — Press Ctrl+C to stop\n"));

    try {
      if (process.platform === "darwin") {
        execFileSync("open", [url], { stdio: "ignore" });
      } else if (process.platform === "win32") {
        execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
      } else {
        execFileSync("xdg-open", [url], { stdio: "ignore" });
      }
    } catch {
      // Browser open failed — user can open manually
    }

    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        console.log(dim("\n  Saving session..."));
        saveSession();
        close();
        console.log(dim("  Goodbye!\n"));
        resolve();
        setTimeout(() => process.exit(0), 500);
      });
    });
  } catch (err) {
    console.error(chalk.red(`  Failed to start: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

function resolveUiDir(): string | null {
  const candidates = [
    join(__owndir, "../../ui"),
    join(__owndir, "../ui"),
    join(process.cwd(), "ui"),
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }

  return null;
}
