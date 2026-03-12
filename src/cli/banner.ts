import { theme } from "./theme.js";
import { getVersion } from "../utils/fs.js";

export function printBanner() {
  const v = theme.vibes;
  const o = theme.accent; // HubSpot orange for "Spot"
  const m = theme.muted;

  // Block-pixel ASCII art: "vibe ≋ Spot"
  const lines = [
    `${v("██  ██ ██ █████  ▄▄▄▄▄")}${v(" ≋≋≋≋≋≋≋≋  ")}${o("▄▄▄▄▄ █████   ▄▄▄▄  ▀▀██▀▀")}`,
    `${v("██  ██ ██ ██  ██ ██   ")}${v("  ≋≋≋≋≋≋   ")}${o("██    ██  ██ ██  ██   ██  ")}`,
    `${v("██  ██ ██ █████  ████ ")}${v("   ≋≋≋≋    ")}${o("▀▀▀▄  █████  ██  ██   ██  ")}`,
    `${v(" █▄▄█▀ ██ ██  ██ ██   ")}${v("  ≋≋≋≋≋≋   ")}${o("   ██ ██     ██  ██   ██  ")}`,
    `${v("  ▀▀▀  ██ █████  ▀▀▀▀▀")}${v(" ≋≋≋≋≋≋≋≋  ")}${o("▀▀▀▀  ██      ▀▀▀▀    ██  ")}`,
  ];

  console.log();
  for (const line of lines) {
    console.log(`  ${line}`);
  }
  console.log();
  console.log(`  ${m("AI-powered HubSpot Landing Pages")}    ${theme.dim(`v${getVersion()}`)}`);
  console.log();
}
