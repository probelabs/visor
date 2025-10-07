#!/bin/bash

# Minimal ProbeAgent SDK test script - uses the same calls as visor

echo "================================================"
echo "Minimal ProbeAgent SDK Test"
echo "================================================"
echo ""
echo "This script tests the ProbeAgent SDK with the same"
echo "configuration and calls that visor uses internally."
echo ""
echo "Usage:"
echo "  ./test-probe.sh [test-type]        # Run with auto-detected provider"
echo "  ./test-probe.sh review             # Test code review with schema (default)"
echo "  ./test-probe.sh overview           # Test PR overview (plain markdown, no schema)"
echo "  ./test-probe.sh plain              # Test plain review without schema"
echo ""
echo "Environment variables:"
echo "  PROVIDER=google ./test-probe.sh    # Use Google AI"
echo "  PROVIDER=anthropic ./test-probe.sh # Use Anthropic Claude"
echo "  PROVIDER=openai ./test-probe.sh    # Use OpenAI"
echo "  DEBUG=true ./test-probe.sh         # Enable debug output"
echo "  TEST_SESSION_REUSE=true ./test-probe.sh  # Test session reuse"
echo ""
echo "Session reuse testing:"
echo "  node test-session-reuse.js         # Test session reuse specifically"
echo ""
echo "Required environment variables:"
echo "  - GOOGLE_API_KEY (for Google provider)"
echo "  - ANTHROPIC_API_KEY (for Anthropic provider)"
echo "  - OPENAI_API_KEY (for OpenAI provider)"
echo ""
echo "================================================"
echo ""

# Check if we have the required dependency
if ! npm ls @probelabs/probe > /dev/null 2>&1; then
    echo "❌ @probelabs/probe is not installed"
    echo "📦 Installing @probelabs/probe@^0.6.0-rc124..."
    npm install @probelabs/probe@^0.6.0-rc124
fi

# Get test type from command line argument (default: review)
TEST_TYPE=${1:-review}

# Check which script to run (TypeScript or JavaScript)
if [ -f "minimal-probe-test.ts" ] && command -v tsx > /dev/null 2>&1; then
    echo "🏃 Running TypeScript version with tsx (test type: $TEST_TYPE)..."
    tsx minimal-probe-test.ts "$TEST_TYPE"
elif [ -f "minimal-probe-test.ts" ] && command -v ts-node > /dev/null 2>&1; then
    echo "🏃 Running TypeScript version with ts-node (test type: $TEST_TYPE)..."
    ts-node minimal-probe-test.ts "$TEST_TYPE"
elif [ -f "minimal-probe-test.js" ]; then
    echo "🏃 Running JavaScript version (test type: $TEST_TYPE)..."
    node minimal-probe-test.js "$TEST_TYPE"
else
    echo "❌ No test script found!"
    echo "Please ensure minimal-probe-test.js or minimal-probe-test.ts exists"
    exit 1
fi
