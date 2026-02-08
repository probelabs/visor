#!/bin/bash
# Build OSS-only version of Visor (without enterprise code).
#
# Strategy: temporarily move src/enterprise/ aside so ncc doesn't bundle it.
# The dynamic import in state-machine-execution-engine.ts is already wrapped
# in try/catch, so the missing module is handled gracefully at runtime.

set -e

ENTERPRISE_DIR="src/enterprise"
STASH_DIR=".enterprise-stash"

# Stash enterprise code
if [ -d "$ENTERPRISE_DIR" ]; then
  mv "$ENTERPRISE_DIR" "$STASH_DIR"
  echo "📦 Building OSS (enterprise code excluded)"
fi

# Ensure we restore even on error
restore() {
  if [ -d "$STASH_DIR" ]; then
    mv "$STASH_DIR" "$ENTERPRISE_DIR"
  fi
}
trap restore EXIT

# Run the standard build
npm run build:cli
npm run build:sdk

echo "✅ OSS build complete (dist/index.js)"
