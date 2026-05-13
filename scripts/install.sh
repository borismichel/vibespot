#!/usr/bin/env bash
# vibespot installer for Linux and macOS.
# Downloads the latest release binary for your platform and drops it into
# /usr/local/bin (or $VIBESPOT_INSTALL_DIR if set).
#
#   curl -fsSL https://raw.githubusercontent.com/borismichel/vibespot/main/scripts/install.sh | bash
#   curl -fsSL ...install.sh | VIBESPOT_VERSION=v1.4.0 bash       # pin a version
#   curl -fsSL ...install.sh | VIBESPOT_INSTALL_DIR=~/.local/bin bash  # no sudo
#
# Set VIBESPOT_REPO to install from a fork.

set -euo pipefail

REPO="${VIBESPOT_REPO:-borismichel/vibespot}"
INSTALL_DIR="${VIBESPOT_INSTALL_DIR:-/usr/local/bin}"
VERSION="${VIBESPOT_VERSION:-latest}"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
dim()    { printf '\033[2m%s\033[0m\n'  "$*"; }

detect_target() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    linux)  ;;
    darwin) ;;
    *) red "Unsupported OS: $os. Use Docker, or build from source."; exit 1 ;;
  esac
  case "$arch" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) red "Unsupported architecture: $arch"; exit 1 ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    red "Required command not found: $1"; exit 1
  fi
}

main() {
  require_cmd curl
  require_cmd chmod
  require_cmd mktemp

  local target asset url tmp dest
  target="$(detect_target)"
  asset="vibespot-${target}"

  if [ "$VERSION" = "latest" ]; then
    url="https://github.com/${REPO}/releases/latest/download/${asset}"
  else
    url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
  fi

  green "Downloading ${asset} from ${url}"
  tmp="$(mktemp -t vibespot.XXXXXX)"
  trap 'rm -f "$tmp"' EXIT

  if ! curl -fsSL "$url" -o "$tmp"; then
    red "Download failed. The release may not include ${asset} yet."
    red "See https://github.com/${REPO}/releases for available assets."
    exit 1
  fi

  chmod +x "$tmp"

  dest="${INSTALL_DIR%/}/vibespot"
  if [ -w "$(dirname "$dest")" ]; then
    mv "$tmp" "$dest"
  else
    yellow "Installing to ${dest} (requires sudo)"
    sudo mv "$tmp" "$dest"
  fi
  trap - EXIT

  green "Installed: ${dest}"
  dim "Run \`vibespot\` to launch the web UI, or \`vibespot --help\`."

  if ! command -v vibespot >/dev/null 2>&1; then
    yellow "${INSTALL_DIR} is not on your PATH. Add it to your shell profile:"
    yellow "    export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi
}

main "$@"
