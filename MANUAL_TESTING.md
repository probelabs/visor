# Manual Testing for Bash Configuration

This document explains how to manually validate the bash configuration feature.

## Quick Start

```bash
# Set your API key
export ANTHROPIC_API_KEY="your-key-here"

# Run the manual tests
npm run test:manual:bash
```

## What Gets Tested

The manual tests validate:

1. **Basic Bash Execution** - `allowBash: true` enables bash commands
2. **Custom Configuration** - `bashConfig` options are passed correctly
3. **Working Directory** - Custom `workingDirectory` is respected
4. **Default Behavior** - Bash is disabled when not configured

## Expected Output

When tests pass, you'll see:

```
⏭️  Skipping manual tests. Set RUN_MANUAL_TESTS=true to run.

Bash Configuration Manual Tests
  With API Key
    📝 Testing allowBash: true
    ✅ allowBash test completed
    📊 Result: { ... }
    ✓ should execute bash commands when allowBash is true (5000ms)

    📝 Testing allowBash with bashConfig
    ✅ bashConfig test completed
    📊 Result: { ... }
    ✓ should pass bashConfig options to ProbeAgent (5000ms)

    📝 Testing bashConfig.workingDirectory
    ✅ workingDirectory test completed
    📊 Result: { ... }
    ✓ should respect custom working directory (5000ms)

    📝 Testing without allowBash (default behavior)
    ✅ No bash test completed
    📊 Result: { ... }
    ✓ should work without bash when allowBash is not set (5000ms)

  Configuration Validation
    ✓ should accept allowBash boolean
    ✓ should accept bashConfig object
    ✓ should accept both allowBash and bashConfig
```

## Alternative: Test with Real Configuration

You can also test with a real Visor configuration file:

### 1. Create a test configuration

```yaml
# test-bash-config.yaml
version: "1.0"

ai_provider: anthropic
ai_model: claude-3-5-sonnet-20241022

steps:
  bash-test:
    type: ai
    prompt: |
      Please run these bash commands:
      1. echo "Hello from Visor bash config test"
      2. pwd
      3. ls -la

      Summarize what you found.
    ai:
      allowBash: true
      bashConfig:
        timeout: 10000
    on: ["manual"]
```

### 2. Run with Visor CLI

```bash
# Build first
npm run build

# Run the check
export ANTHROPIC_API_KEY="your-key-here"
./dist/cli-main.js --config test-bash-config.yaml --check bash-test --event manual
```

### 3. Expected Output

You should see the AI agent:
- Successfully execute bash commands
- Return results from `echo`, `pwd`, `ls`
- Provide a summary of findings

## Testing Different Configurations

### Test Custom Allow List

```yaml
ai:
  allowBash: true
  bashConfig:
    allow: ['git status', 'git log --oneline -5']
```

### Test Working Directory

```yaml
ai:
  allowBash: true
  bashConfig:
    workingDirectory: '/tmp'
```

### Test Timeout

```yaml
ai:
  allowBash: true
  bashConfig:
    timeout: 5000  # 5 seconds
```

## Troubleshooting

### Tests are skipped

Make sure you set `RUN_MANUAL_TESTS=true`:

```bash
RUN_MANUAL_TESTS=true npm run test:manual:bash
```

### API key not found

Set your API key before running:

```bash
export ANTHROPIC_API_KEY="your-key-here"
```

### Bash commands not working

1. Verify ProbeAgent version supports bash config (>= 0.6.0-rc164)
2. Check that `allowBash: true` is set
3. Verify the command is in the default allow list or your custom `allow` list
4. Check ProbeAgent logs with `debug: true`

## Cost Considerations

⚠️ **Warning**: These tests make real API calls to Anthropic and will incur costs. Each test run costs approximately $0.01-0.05 depending on the model and response length.

To minimize costs:
- Run tests only when needed
- Use a cheaper model for testing (claude-3-haiku)
- Keep prompts concise

## Debugging

Enable debug mode to see ProbeAgent interactions:

```yaml
ai:
  provider: anthropic
  debug: true  # Shows all tool calls and responses
  allowBash: true
```

This will show:
- Bash commands being executed
- Command outputs
- Tool call traces
- Token usage

## Next Steps

After manual validation:
1. Review test results
2. Check ProbeAgent logs
3. Verify bash commands executed correctly
4. Test with your specific use cases
5. Document any edge cases or issues
