# Manual Tests

This directory contains manual tests that require real API keys and make actual API calls. These tests are skipped by default in CI/CD.

## Running Manual Tests

### Prerequisites

Set the required environment variables:

```bash
export ANTHROPIC_API_KEY="your-api-key-here"
export RUN_MANUAL_TESTS=true
```

### Run Bash Configuration Tests

```bash
# Run all manual tests
npm test -- tests/manual/bash-config-manual.test.ts

# Or use the helper script
npm run test:manual:bash
```

## Test Coverage

### `bash-config-manual.test.ts`

Tests the bash command execution configuration with real ProbeAgent calls:

1. **allowBash: true** - Validates basic bash execution with default safe commands
2. **bashConfig options** - Tests custom allow/deny lists and timeout
3. **workingDirectory** - Verifies custom working directory is respected
4. **Default behavior** - Confirms bash is disabled by default

## Notes

- These tests make real API calls and may incur costs
- Tests are automatically skipped unless `RUN_MANUAL_TESTS=true`
- Each test has a 60-second timeout
- Debug mode is enabled to show ProbeAgent interactions

## Expected Output

When tests pass, you should see:

```
📝 Testing allowBash: true
✅ allowBash test completed
📊 Result: { overallScore: 100, ... }

📝 Testing allowBash with bashConfig
✅ bashConfig test completed
📊 Result: { overallScore: 100, ... }

📝 Testing bashConfig.workingDirectory
✅ workingDirectory test completed
📊 Result: { overallScore: 100, ... }

📝 Testing without allowBash (default behavior)
✅ No bash test completed
📊 Result: { overallScore: 100, ... }
```
