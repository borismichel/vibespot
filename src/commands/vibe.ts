/**
 * `vibespot vibe` — Vibe coding mode.
 * Immediately starts a local server and opens the browser.
 * All setup happens in the web UI — zero CLI prompts.
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

export async function vibeCommand(): Promise<void> {
  const accent = chalk.hex("#e8613a");
  const dim = chalk.dim;

  console.log("");
  console.log(accent("  v vibeSpot"));
  console.log(dim("  Starting...\n"));

  const uiDir = resolveUiDir();
  if (!uiDir) {
    console.error(chalk.red("  Could not find UI assets. Is the package installed correctly?"));
    process.exit(1);
  }

  const envPort = Number.parseInt(process.env.VIBESPOT_PORT || "", 10);
  const startPort = Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_PORT;
  const skipOpen = process.env.VIBESPOT_NO_OPEN === "1" || !process.stdout.isTTY;

  try {
    const { port, close } = await startServer({ port: startPort, uiDir });
    const url = `http://localhost:${port}`;

    console.log(accent(`  v ${url}`));
    console.log(dim("  Press Ctrl+C to stop\n"));

    if (!skipOpen) {
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
    }

    // Keep running until Ctrl+C
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        console.log(dim("\n  Saving session..."));
        saveSession();
        close();
        console.log(dim("  Goodbye!\n"));
        resolve();
        // Force exit after a short grace period — open connections
        // (WebSocket, keep-alive HTTP) can keep the process alive indefinitely.
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
