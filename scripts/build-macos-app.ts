/**
 * Pack the darwin-arm64 and darwin-x64 bare binaries into a single universal
 * `vibeSpot.app` bundle and zip it with `ditto` so the resulting archive
 * preserves macOS metadata (extended attributes, symlinks, resource forks).
 *
 * Must run on macOS — uses `lipo`, `codesign --remove-signature`, and
 * `ditto`, none of which exist on Linux. The .github/workflows/binaries.yml
 * job that consumes this runs on macos-14.
 *
 *   bun scripts/build-macos-app.ts \
 *     --arm64 dist-bin/vibespot-darwin-arm64 \
 *     --x64   dist-bin/vibespot-darwin-x64 \
 *     --version 1.4.2 \
 *     --out   dist-bin/vibeSpot.app.zip
 *
 * The resulting .app is unsigned. Gatekeeper friction (Apple Developer ID
 * signing + notarization) is deferred per VIB-446.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

interface Args {
  arm64: string;
  x64: string;
  version: string;
  out: string;
  appName: string;
  bundleId: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Partial<Args> = {
    appName: "vibeSpot",
    bundleId: "com.borismichel.vibespot",
  };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    const val = args[i + 1];
    (out as Record<string, string>)[key] = val;
  }
  for (const required of ["arm64", "x64", "version", "out"] as const) {
    if (!out[required]) {
      console.error(`Missing required --${required}`);
      process.exit(1);
    }
  }
  return out as Args;
}

function run(cmd: string, args: string[]): void {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`exit ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

function plist(args: Args): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${args.bundleId}</string>
  <key>CFBundleName</key>
  <string>${args.appName}</string>
  <key>CFBundleDisplayName</key>
  <string>${args.appName}</string>
  <key>CFBundleExecutable</key>
  <string>vibespot</string>
  <key>CFBundleIconFile</key>
  <string>vibespot</string>
  <key>CFBundleVersion</key>
  <string>${args.version}</string>
  <key>CFBundleShortVersionString</key>
  <string>${args.version}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleSignature</key>
  <string>????</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>Copyright © ${new Date().getFullYear()} Boris Michel</string>
</dict>
</plist>
`;
}

function main(): void {
  if (process.platform !== "darwin") {
    console.error("scripts/build-macos-app.ts must run on macOS (needs lipo, ditto, codesign).");
    process.exit(1);
  }
  const args = parseArgs();
  const repoRoot = resolve(import.meta.dirname, "..");
  const icns = join(repoRoot, "assets", "icon", "vibespot.icns");
  if (!existsSync(icns)) {
    console.error(`Missing icon: ${icns}`);
    process.exit(1);
  }

  const stage = join(repoRoot, "dist-bin", ".macos-stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const universalBin = join(stage, "vibespot-universal");
  run("lipo", ["-create", "-output", universalBin, args.arm64, args.x64]);
  // Bun emits ad-hoc signatures on Apple Silicon outputs. After lipo the
  // signature is invalid for the fused binary, so strip it; a freshly
  // unsigned fat Mach-O is what we want until proper Developer ID signing
  // lands.
  spawnSync("codesign", ["--remove-signature", universalBin], { stdio: "inherit" });

  const appRoot = join(stage, `${args.appName}.app`);
  const macosDir = join(appRoot, "Contents", "MacOS");
  const resourcesDir = join(appRoot, "Contents", "Resources");
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });

  cpSync(universalBin, join(macosDir, "vibespot"));
  chmodSync(join(macosDir, "vibespot"), 0o755);
  cpSync(icns, join(resourcesDir, "vibespot.icns"));
  writeFileSync(join(appRoot, "Contents", "Info.plist"), plist(args));
  writeFileSync(join(appRoot, "Contents", "PkgInfo"), "APPL????");

  // Ad-hoc sign the app so Gatekeeper at least recognizes it as signed
  // locally; this doesn't suppress the unsigned-developer prompt but
  // prevents "damaged app" errors on some macOS releases.
  run("codesign", ["--force", "--deep", "--sign", "-", appRoot]);

  mkdirSync(dirname(args.out), { recursive: true });
  rmSync(args.out, { force: true });
  // `ditto -c -k --sequesterRsrc --keepParent` is the canonical way to
  // pack a .app into a Finder-friendly zip on macOS.
  run("ditto", [
    "-c", "-k", "--sequesterRsrc", "--keepParent",
    appRoot, args.out,
  ]);

  const size = statSync(args.out).size;
  console.log(`\nWrote ${args.out} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

main();
