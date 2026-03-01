import { theme } from "./theme.js";

const VERSION = "0.3.0";

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
  console.log(`  ${m("AI-powered HubSpot Landing Pages")}    ${theme.dim(`v${VERSION}`)}`);
  console.log();
}
