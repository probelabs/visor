#!/bin/bash

# Release script for @probelabs/visor
# Usage: ./scripts/release.sh [patch|minor|major|prerelease]

set -e

VERSION_TYPE=${1:-patch}

echo "🚀 Preparing release..."

# Ensure we're on main branch
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "master" ]; then
  echo "❌ Error: You must be on main/master branch to release"
  exit 1
fi

# Ensure working directory is clean
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Error: Working directory is not clean. Please commit or stash changes."
  exit 1
fi

# Pull latest changes
echo "📥 Pulling latest changes..."
git pull origin "$BRANCH"

# Run tests
echo "🧪 Running tests..."
npm test

# Build the project
echo "🔨 Building project..."
npm run build

# Bump version
echo "📝 Bumping version ($VERSION_TYPE)..."
npm version "$VERSION_TYPE" -m "chore: release v%s"

# Get the new version
VERSION=$(node -p "require('./package.json').version")

# Push changes and tags
echo "📤 Pushing changes and tags..."
git push origin "$BRANCH"
git push origin "v$VERSION"

echo "✅ Release v$VERSION initiated!"
echo "🔄 GitHub Actions will now publish to npm"
echo ""
echo "📦 Once published, install with:"
echo "   npx -y visor@latest"
echo ""
echo "🔗 Check release status at:"
echo "   https://github.com/probelabs/visor/actions"