#!/usr/bin/env bash
set -euo pipefail

IMAGE="ghcr.io/borismichel/vibespot"
VERSION=$(node -p "require('./package.json').version")
SHA=$(git rev-parse --short HEAD)

MULTI_ARCH=false
SMOKE=false
DRY_RUN=false

usage() {
  cat <<EOF
Usage: scripts/docker-publish.sh [OPTIONS]

Build and push the vibespot Docker image to GHCR.
Replaces the CI docker-image workflow while Actions minutes are exhausted.

Options:
  --multi-arch   Build for linux/amd64 + linux/arm64 (default: amd64 only)
  --smoke        Run smoke test before pushing
  --dry-run      Build and tag but do not push
  --help         Show this help

Tags applied:
  $IMAGE:latest
  $IMAGE:v<version>          (from package.json)
  $IMAGE:sha-<short-sha>     (current commit)

Prerequisites:
  - Docker (with buildx for --multi-arch)
  - gh CLI authenticated (used for GHCR login)
EOF
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --multi-arch) MULTI_ARCH=true ;;
    --smoke)      SMOKE=true ;;
    --dry-run)    DRY_RUN=true ;;
    --help)       usage ;;
    *) echo "Unknown option: $arg"; usage ;;
  esac
done

echo "==> vibespot Docker publish"
echo "    version : $VERSION"
echo "    sha     : $SHA"
echo "    multi   : $MULTI_ARCH"
echo "    dry-run : $DRY_RUN"
echo ""

echo "==> Authenticating with GHCR"
echo "$(gh auth token)" | docker login ghcr.io -u borismichel --password-stdin

TAGS="-t $IMAGE:latest -t $IMAGE:v$VERSION -t $IMAGE:sha-$SHA"

if [ "$MULTI_ARCH" = true ]; then
  docker buildx create --use --name vibespot-builder 2>/dev/null || true

  if [ "$DRY_RUN" = true ]; then
    echo "==> Building multi-arch (dry-run, no push)"
    docker buildx build --platform linux/amd64,linux/arm64 $TAGS --load . 2>/dev/null \
      || docker buildx build --platform linux/amd64,linux/arm64 $TAGS .
  else
    echo "==> Building + pushing multi-arch"
    docker buildx build --platform linux/amd64,linux/arm64 $TAGS --push .
  fi
else
  echo "==> Building single-arch (amd64)"
  docker build $TAGS .

  if [ "$SMOKE" = true ]; then
    echo "==> Running smoke test"
    docker rm -f vibespot-smoke 2>/dev/null || true
    docker run -d --name vibespot-smoke -p 4200:4200 "$IMAGE:latest"

    echo "    Waiting for healthz..."
    for i in $(seq 1 30); do
      if curl -fsS http://127.0.0.1:4200/healthz > /dev/null 2>&1; then
        echo "    healthz OK after ${i}s"
        break
      fi
      sleep 1
      if [ "$i" = "30" ]; then
        echo "    healthz never came up"
        docker logs vibespot-smoke
        docker rm -f vibespot-smoke
        exit 1
      fi
    done

    STARTERS=$(curl -fsS http://127.0.0.1:4200/api/starters | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).starters.length")
    echo "    starters: $STARTERS"
    if [ "$STARTERS" -lt 5 ]; then
      echo "    FAIL: expected >= 5 starters"
      docker logs vibespot-smoke
      docker rm -f vibespot-smoke
      exit 1
    fi

    echo "    Smoke test passed"
    docker rm -f vibespot-smoke
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "==> Dry run — skipping push"
  else
    echo "==> Pushing to GHCR"
    docker push "$IMAGE:latest"
    docker push "$IMAGE:v$VERSION"
    docker push "$IMAGE:sha-$SHA"
  fi
fi

echo ""
echo "==> Done"
[ "$DRY_RUN" = false ] && echo "    Published: $IMAGE:v$VERSION / sha-$SHA / latest"
[ "$DRY_RUN" = true ]  && echo "    Built locally (not pushed): $IMAGE:v$VERSION / sha-$SHA / latest"
