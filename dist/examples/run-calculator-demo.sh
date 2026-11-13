#!/bin/bash

# Interactive Calculator Demo Script
# This script demonstrates the calculator example using piped input

echo "╔═══════════════════════════════════════════╗"
echo "║   Visor Calculator Demo                  ║"
echo "║   Human Input + Memory + JavaScript      ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

echo "This demo will calculate: 42 + 7"
echo ""
echo "Running with piped input (non-interactive):"
echo "  First number: 42"
echo "  Second number: 7"
echo "  Operation: +"
echo ""
echo "Press Enter to run..."
read

# Note: This would work if visor was built and the checks run sequentially
# For now, this is a demonstration of how it would work

echo "Command that would run:"
echo ""
echo "  echo '42' | visor --config examples/calculator-config.yaml --check get-number1"
echo "  echo '7' | visor --config examples/calculator-config.yaml --check get-number2"
echo "  echo '+' | visor --config examples/calculator-config.yaml --check get-operation"
echo ""

echo "Or interactively:"
echo ""
echo "  visor --config examples/calculator-config.yaml"
echo ""

echo "This would prompt you for each input with a beautiful UI like:"
echo ""
echo "┌─────────────────────────────────────────┐"
echo "│ 💬 Human Input Required                 │"
echo "├─────────────────────────────────────────┤"
echo "│                                         │"
echo "│ Enter the first number:                 │"
echo "│                                         │"
echo "│ ┌─────────────────────────────────────┐ │"
echo "│ │ e.g., 42                            │ │"
echo "│ │                                     │ │"
echo "│ │ (Type your response and press Enter)│ │"
echo "│ └─────────────────────────────────────┘ │"
echo "│                                         │"
echo "└─────────────────────────────────────────┘"
echo ""
echo "> 42"
echo ""

echo "Then the result would be:"
echo ""
echo "╔════════════════════════════════════════╗"
echo "║          CALCULATION RESULT            ║"
echo "╠════════════════════════════════════════╣"
echo "║                                        ║"
echo "║  42 + 7 = 49                           ║"
echo "║                                        ║"
echo "╚════════════════════════════════════════╝"
echo ""

echo "✨ Once Visor is built, you can run the actual calculator with:"
echo ""
echo "  npm run build"
echo "  ./dist/cli-main.js --config examples/calculator-config.yaml"
echo ""
