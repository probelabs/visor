#!/bin/bash
# Publish enterprise edition to npm with -ee version suffix.
#
# Usage: ./scripts/publish-ee.sh [--dry-run]
#
# This script:
# 1. Builds the EE version (includes enterprise code)
# 2. Temporarily sets version to X.Y.Z-ee
# 3. Publishes to npm with --tag ee
# 4. Restores the original version
#
# Install EE: npm install @probelabs/visor@ee

set -e

DRY_RUN=""
if [ "$1" == "--dry-run" ]; then
  DRY_RUN="--dry-run"
fi

# Get current version
VERSION=$(node -p "require('./package.json').version")
EE_VERSION="${VERSION}-ee"

echo "📦 Publishing enterprise edition v${EE_VERSION}..."

# Build EE version (includes enterprise code)
npm run clean 2>/dev/null || true
node scripts/generate-config-schema.js
npm run build:ee

# Temporarily set EE version (no git tag)
npm version "$EE_VERSION" --no-git-tag-version

# Restore version on exit (even on error)
restore_version() {
  npm version "$VERSION" --no-git-tag-version --allow-same-version 2>/dev/null || true
}
trap restore_version EXIT

# Publish with --ignore-scripts to skip prepublishOnly (we already built)
npm publish --tag ee --ignore-scripts $DRY_RUN

echo "✅ Published @probelabs/visor@${EE_VERSION}"
echo ""
echo "Install with:"
echo "  npm install @probelabs/visor@ee"
echo "  npx @probelabs/visor@ee"
