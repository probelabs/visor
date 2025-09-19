#!/bin/bash

# Test script for configuration extends feature
set -e

echo "Testing Visor configuration extends feature..."
echo "============================================"

# Build the project first
echo ""
echo "Building the project..."
cd ../..
npm run build

echo ""
echo "Test 1: Loading team-config.yaml (extends from base-config.yaml)"
echo "-----------------------------------------------------------------"
../../dist/cli-main.js --config repo/test-extends/team-config.yaml --check all --output json | jq '.config | {version, ai_provider, ai_model, checks: .checks | keys}'

echo ""
echo "Test 2: Loading project-config.yaml (extends from default and team-config.yaml)"
echo "-------------------------------------------------------------------------------"
../../dist/cli-main.js --config repo/test-extends/project-config.yaml --check all --output json | jq '.config | {version, max_parallelism, checks: .checks | keys}'

echo ""
echo "Test 3: Testing with --no-remote-extends flag"
echo "----------------------------------------------"
../../dist/cli-main.js --config repo/test-extends/team-config.yaml --check all --output json --no-remote-extends | jq '.config | {version, checks: .checks | length}'

echo ""
echo "Test 4: Creating a config that extends from default"
echo "---------------------------------------------------"
cat > repo/test-extends/extends-default.yaml << EOF
version: "1.0"
extends: default

checks:
  custom-check:
    type: ai
    prompt: "Custom analysis"
    on: [pr_opened]
EOF

../../dist/cli-main.js --config repo/test-extends/extends-default.yaml --check all --output json | jq '.config.checks | keys | length'

echo ""
echo "Test 5: Override check with empty 'on' array to disable it"
echo "----------------------------------------------------------"
cat > repo/test-extends/disable-check.yaml << EOF
version: "1.0"
extends: ./base-config.yaml

checks:
  security:
    type: ai
    prompt: "Security check"
    on: []  # This disables the security check
EOF

../../dist/cli-main.js --config repo/test-extends/disable-check.yaml --check all --output json | jq '.config.checks | keys'

echo ""
echo "✅ All tests completed successfully!"