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
| `vibespot-darwin-arm64`  | macOS Apple Silicon |
| `vibespot-darwin-x64`    | macOS Intel        |
| `vibespot-linux-x64`     | Linux glibc x86_64 |
| `vibespot-linux-arm64`   | Linux glibc aarch64|
| `vibespot-windows-x64.exe` | Windows 64-bit   |

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

### Building binaries locally

```bash
bun install
bun scripts/build-binaries.ts          # all 5 targets → dist-bin/
bun scripts/build-binaries.ts linux-x64  # one target
```

The script regenerates `scripts/.generated/runtime-manifest.ts` (a static
list of every embedded asset) before each build. Output goes to `dist-bin/`.

### Runtime cache

On first run a binary extracts its embedded assets to
`~/.vibespot/runtime-assets/<version>/`. Subsequent runs of the same version
skip extraction. Override the cache location with `VIBESPOT_RUNTIME_CACHE`.

### What's not in scope (yet)

- Code signing (Apple Developer ID, Windows EV cert) — deferred per the
  [packaging analysis](/VIB/issues/VIB-446).
- Native installers (`.dmg`, `.msi`, `.pkg`).
- In-place auto-update — re-run the install script or `docker pull`.
