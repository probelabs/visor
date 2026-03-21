#!/bin/bash
# Build OSS-only version of Visor (without enterprise code).
#
# Strategy: build inside an isolated temporary workspace, remove enterprise
# code only there, then copy dist/ back to the real repo. This avoids mutating
# tracked source files in the working tree.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/visor-oss-build-XXXXXX")"
BUILD_CLI_CMD="${VISOR_OSS_BUILD_CLI_CMD:-npm run build:cli}"
BUILD_SDK_CMD="${VISOR_OSS_BUILD_SDK_CMD:-npm run build:sdk}"

cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT INT TERM HUP

echo "📦 Building OSS in isolated workspace: $BUILD_DIR"

(
  cd "$ROOT_DIR"
  tar \
    --exclude='./.git' \
    --exclude='./node_modules' \
    --exclude='./dist' \
    --exclude='./coverage' \
    --exclude='./tmp' \
    --exclude='./.visor' \
    --exclude='./.enterprise-stash' \
    -cf - .
) | (
  cd "$BUILD_DIR"
  tar -xf -
)

if [ -d "$ROOT_DIR/node_modules" ] && [ ! -e "$BUILD_DIR/node_modules" ]; then
  ln -s "$ROOT_DIR/node_modules" "$BUILD_DIR/node_modules"
fi

rm -rf "$BUILD_DIR/src/enterprise"

(
  cd "$BUILD_DIR"
  bash -lc "$BUILD_CLI_CMD"
  bash -lc "$BUILD_SDK_CMD"
)

rm -rf "$ROOT_DIR/dist"
mkdir -p "$ROOT_DIR/dist"

(
  cd "$BUILD_DIR"
  tar -cf - dist
) | (
  cd "$ROOT_DIR"
  tar -xf -
)

echo "✅ OSS build complete (dist/index.js)"
