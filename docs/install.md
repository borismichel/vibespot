# Installing vibespot

vibespot ships three ways. Pick the one that fits your environment.

| Method | Best for | Needs Node? | Auto-updates |
|--------|----------|-------------|--------------|
| [npm](#1-npm--source) | Existing Node toolchain, contributing | Yes (18+) | `npm i -g vibespot@latest` |
| [Docker / compose](#2-docker) | Hosting customers, production EU deploy | No | `docker pull` |
| [Single-file binary](#3-single-file-binary) | Quick local install, no Node | No | re-run install script |

If you just want to try vibespot on your laptop and don't already have Node
installed, the binary is the fastest path. See parent issue
[VIB-446](/VIB/issues/VIB-446) for the packaging decision matrix.

## 1. npm / source

```bash
npx vibespot                  # one-off
npm install -g vibespot       # global
```

Requires Node.js 18 or newer. The first run opens
<http://localhost:4200> where you finish setup.

## 2. Docker

For a single-container quick start:

```bash
docker run --rm -p 4200:4200 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  ghcr.io/borismichel/vibespot:latest
```

For a production deployment with Caddy (TLS), Postgres, and the auth-gate
slot, use the bundled `docker-compose.yml`. Full guide:
[docs/docker.md](./docker.md). Source: [VIB-450](/VIB/issues/VIB-450).

## 3. Single-file binary

Built with [`bun build --compile`](https://bun.com/docs/bundler/executables).
Each binary contains the Bun runtime, the vibespot JavaScript bundle, and
all packaged assets (UI, starter templates, plan templates, CHANGELOG,
guides). Roughly 70–100 MB per platform. No Node, no npm, no
post-install steps.

### macOS / Linux — one-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/borismichel/vibespot/main/scripts/install.sh | bash
```

The installer detects your OS/arch, downloads the matching binary from the
latest GitHub Release, marks it executable, and drops it into
`/usr/local/bin/vibespot` (uses `sudo` if needed). Override the target dir
with `VIBESPOT_INSTALL_DIR`, or pin a version with `VIBESPOT_VERSION`:

```bash
curl -fsSL https://raw.githubusercontent.com/borismichel/vibespot/main/scripts/install.sh \
  | VIBESPOT_INSTALL_DIR="$HOME/.local/bin" VIBESPOT_VERSION=v1.4.0 bash
```

### Manual download

Releases live at
<https://github.com/borismichel/vibespot/releases>. Each tagged release
ships these assets:

| Asset | Platform |
|-------|----------|
| `vibespot-darwin-arm64`     | macOS Apple Silicon (bare CLI)        |
| `vibespot-darwin-x64`       | macOS Intel (bare CLI)                |
| `vibespot-linux-x64`        | Linux glibc x86_64                    |
| `vibespot-linux-arm64`      | Linux glibc aarch64                   |
| `vibespot-windows-x64.exe`  | Windows 64-bit (icon + version info)  |
| `vibeSpot-macos.app.zip`    | macOS universal (arm64 + x64) `.app` for Finder |

```bash
# macOS Apple Silicon example
curl -fsSL -o vibespot \
  https://github.com/borismichel/vibespot/releases/latest/download/vibespot-darwin-arm64
chmod +x vibespot
./vibespot --version
```

On macOS Gatekeeper will block the unsigned binary the first time it runs.
Until we sign releases (deferred — see [VIB-446](/VIB/issues/VIB-446)),
allow it via **System Settings → Privacy & Security → "Open Anyway"**, or
strip the quarantine attribute:

```bash
xattr -d com.apple.quarantine ./vibespot
```

Windows SmartScreen will show a similar prompt — click **More info → Run
anyway**.

### macOS `.app` bundle (universal)

`vibeSpot-macos.app.zip` is a Finder-friendly bundle for users who'd rather
not touch a terminal. The binary inside is a **universal Mach-O** (arm64 +
x86_64 fused with `lipo`), so the same `.app` runs natively on both Apple
Silicon and Intel Macs.

```bash
# Download, unzip, drag into Applications, run.
curl -fsSL -O \
  https://github.com/borismichel/vibespot/releases/latest/download/vibeSpot-macos.app.zip
ditto -x -k vibeSpot-macos.app.zip ~/Applications/
open ~/Applications/vibeSpot.app
```

Double-clicking the `.app` starts the local server in the background
(`LSUIElement=true`, no dock icon) and the default browser opens at
<http://localhost:4200>. To stop it, quit via Activity Monitor (search for
`vibespot`) or kill the process from a terminal.

Bundle layout:

```
vibeSpot.app/
  Contents/
    Info.plist           # CFBundleIdentifier com.borismichel.vibespot
    PkgInfo              # APPL????
    MacOS/vibespot       # universal binary (arm64 + x86_64)
    Resources/vibespot.icns
```

The bundle is **ad-hoc signed** (`codesign --sign -`). It is not signed
with an Apple Developer ID and not notarized, so Gatekeeper still prompts
on first launch — same xattr / "Open Anyway" workaround as the bare CLI.
Real Developer ID signing + notarization remains deferred per
[VIB-446](/VIB/issues/VIB-446).

### Icon and platform metadata

The Windows `.exe` carries the vibeSpot icon plus product/publisher/
version metadata in its PE resource section (Bun's `--windows-icon` and
friends, applied only to the windows-x64 target). The source asset lives at
`assets/icon/vibespot.png` (512×512 RGBA); `assets/icon/vibespot.ico` is the
multi-resolution Windows container generated from it (16/32/48/64/128/256).

The macOS `.app` bundle carries the icon as `Contents/Resources/vibespot.icns`
(multi-resolution: 16/32/64/128/256/512/1024 plus the `@2x` variants),
generated from the same source PNG. Bare Mach-O CLI binaries can't carry
icons natively — the icon only surfaces inside the `.app` wrapper.

Linux ELF binaries also can't carry icons natively — those need a
`.desktop` file in `/usr/share/applications/` plus PNGs in
`/usr/share/icons/hicolor/<size>/apps/`. Linux desktop integration remains
deferred per the [packaging analysis](/VIB/issues/VIB-446).

### Building binaries locally

```bash
bun install
bun scripts/build-binaries.ts          # all 5 targets → dist-bin/
bun scripts/build-binaries.ts linux-x64  # one target
```

The script regenerates `scripts/.generated/runtime-manifest.ts` (a static
list of every embedded asset) before each build. Output goes to `dist-bin/`.
The `--windows-icon` flag is honored only when the build host is Windows
(Bun limitation); CI's `windows-2022` runner handles this in
`binaries.yml`.

To package the macOS `.app` bundle locally (must run on macOS — needs
`lipo`, `ditto`, and `codesign`):

```bash
bun scripts/build-binaries.ts darwin-arm64 darwin-x64
bun scripts/build-macos-app.ts \
  --arm64 dist-bin/vibespot-darwin-arm64 \
  --x64   dist-bin/vibespot-darwin-x64 \
  --version "$(node -p "require('./package.json').version")" \
  --out   dist-bin/vibeSpot-macos.app.zip
```

### Runtime cache

On first run a binary extracts its embedded assets to
`~/.vibespot/runtime-assets/<version>/`. Subsequent runs of the same version
skip extraction. Override the cache location with `VIBESPOT_RUNTIME_CACHE`.

### What's not in scope (yet)

- Code signing (Apple Developer ID, Windows EV cert) — deferred per the
  [packaging analysis](/VIB/issues/VIB-446). The `.app` is ad-hoc signed
  only, which still triggers Gatekeeper on first launch.
- Notarization for macOS distribution outside the App Store.
- `.dmg` disk image (we ship a zipped `.app` instead).
- `.msi` / `.pkg` native installers.
- Linux `.desktop` files / `/usr/share/icons/` integration.
- In-place auto-update — re-run the install script or `docker pull`.
