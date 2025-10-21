#!/bin/bash
# Test script to verify fail_if fix with simulated inputs

cd "$(dirname "$0")"

# Create a test file that will provide inputs programmatically
cat > /tmp/calc-test-inputs.txt << 'EOF'
10
5
+
EOF

# Run the calculator with inputs from file, capturing relevant output
exec 3</tmp/calc-test-inputs.txt
bun examples/calculator-sdk-real.ts <&3 2>&1 | grep -E "(fail_if debug|Running check:|Failed to evaluate|✔ Check complete: (store-operation|calculate))"

# Clean up
rm -f /tmp/calc-test-inputs.txt
