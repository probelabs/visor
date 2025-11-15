# Testing Quick Start Guide

This guide will help you quickly verify that your Slack bot implementation is working correctly.

## Prerequisites

- Node.js v18 or higher
- npm installed
- Git repository cloned

## Running Tests

### 1. Install Dependencies

```bash
npm install
```

This will install all required dependencies including `@slack/web-api`, `express`, and testing frameworks.

### 2. Run All Tests

```bash
npm test
```

This command runs:
- **Jest unit/integration/e2e tests** (~1742 tests)
- **YAML test suite** (27 test cases)

Expected output:
```
Test Suites: 4 skipped, 180 passed, 180 of 184 total
Tests:       32 skipped, 1742 passed, 1774 total
Time:        ~340s (5.7 minutes)
```

✅ **Success indicator**: All tests pass with exit code 0

### 3. Run Specific Test Suites

```bash
# Run only Slack integration tests
npm test -- tests/integration/slack-bot.test.ts

# Run only unit tests
npm test -- tests/unit/

# Run with coverage
npm run test:coverage

# Run in watch mode (for development)
npm run test:watch
```

## Verifying Slack Bot Functionality

### 1. Build the Project

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

### 2. Validate Configuration

Create a test configuration file `.visor.test.yaml`:

```yaml
version: '1.0'

http_server:
  enabled: true
  port: 8080

slack:
  endpoint: "/bots/slack/events"
  signing_secret: "${SLACK_SIGNING_SECRET}"
  bot_token: "${SLACK_BOT_TOKEN}"
  mentions: direct
  threads: required
  fetch:
    scope: thread
    max_messages: 40
    cache:
      ttl_seconds: 600
      max_threads: 200
  channel_allowlist: ["C*"]  # Allow all channels for testing

checks:
  slack-greeter:
    type: command
    command: echo
    args:
      - "Hello from Slack bot!"
```

### 3. Run Validation Command

```bash
# Without environment variables set (will show missing vars)
./dist/cli-main.js validate --config .visor.test.yaml

# Expected output:
# ✗ Configuration has errors
# Environment Variables:
#   ✗ SLACK_SIGNING_SECRET (missing)
#   ✗ SLACK_BOT_TOKEN (missing)
```

### 4. Set Environment Variables

```bash
export SLACK_SIGNING_SECRET="your_signing_secret_here"
export SLACK_BOT_TOKEN="xoxb-your-bot-token-here"
```

### 5. Validate Again

```bash
./dist/cli-main.js validate --config .visor.test.yaml

# Expected output:
# ✓ Configuration is valid
# Configuration Summary:
#   Endpoint: /bots/slack/events
#   Signing Secret: (configured)
#   Bot Token: (configured)
#   Max Messages: 40
#   Cache TTL: 600 seconds
#   Cache Size: 200 threads
```

### 6. Test API Connectivity (Optional)

```bash
./dist/cli-main.js validate --config .visor.test.yaml --check-api

# Expected output:
# ✓ Slack API connectivity test passed
# Bot User ID: U01234567
# Workspace: Your Workspace Name
```

## Test Scenarios Included

The test suite covers:

### Unit Tests
- ✅ Slack client operations (reactions, messages, threads)
- ✅ Webhook signature verification
- ✅ Event filtering and validation
- ✅ Bot context building and normalization
- ✅ Thread cache LRU operations
- ✅ Worker pool management
- ✅ Prompt state management

### Integration Tests
- ✅ Slack bot fixture loading
- ✅ Bot context injection into workflows
- ✅ Human-input provider Slack mode
- ✅ Multi-turn conversations
- ✅ Thread independence
- ✅ Reaction sequence validation
- ✅ Message assertions

### E2E Tests
- ✅ Complete webhook flow (receive → process → respond)
- ✅ Worker pool execution
- ✅ Cache hit/miss scenarios
- ✅ Error handling and recovery
- ✅ Graceful shutdown

## Common Issues and Solutions

### Issue: Tests fail with "Module not found"

**Solution:**
```bash
npm install
npm run build
```

### Issue: "SLACK_SIGNING_SECRET not set" during tests

**Solution:** This is expected! Tests use mock Slack environment. Only validation command requires real credentials.

### Issue: Build fails with TypeScript errors

**Solution:**
```bash
npm run clean
npm run build
```

### Issue: Some tests are skipped

**Solution:** This is intentional. Some tests are skipped in certain environments (32 skipped tests is normal).

### Issue: Tests timeout

**Solution:** Tests have a 10-minute timeout configured in user settings. If tests consistently timeout, check system performance.

## Continuous Integration

The test suite is designed to run in CI/CD pipelines:

```yaml
# Example GitHub Actions
- name: Install dependencies
  run: npm install

- name: Run tests
  run: npm test
  timeout-minutes: 10

- name: Build
  run: npm run build
```

## Next Steps

After tests pass:

1. **Read the setup guide:** `docs/slack-bot-setup.md`
2. **Create your Slack app** following the guide
3. **Configure your bot** with real credentials
4. **Deploy** with `visor --config .visor.yaml --http`
5. **Test in Slack** by mentioning your bot

## Test Output Explanation

### Successful Test Run

```
Test Suites: 4 skipped, 180 passed, 180 of 184 total
Tests:       32 skipped, 1742 passed, 1774 total
Snapshots:   0 total
Time:        340.123 s
```

- **180 passed suites**: All test files executed successfully
- **1742 passed tests**: All individual test cases passed
- **32 skipped tests**: Intentionally skipped (environment-specific or WIP)
- **Time**: Normal range is 5-7 minutes

### Failed Test Run

```
FAIL tests/integration/slack-bot.test.ts
  ● Slack bot fixture loading › should load simple mention fixture

    expect(received).toMatchObject(expected)

    Expected: {...}
    Received: {...}
```

If you see failures:
1. Check the specific test file mentioned
2. Look at the error message for details
3. Run that specific test: `npm test -- tests/integration/slack-bot.test.ts`
4. Check if recent changes broke the test
5. Review implementation vs test expectations

## Test Coverage

Generate coverage report:

```bash
npm run test:coverage
```

Expected coverage:
- **Statements:** ~85%+
- **Branches:** ~75%+
- **Functions:** ~80%+
- **Lines:** ~85%+

Coverage reports are generated in `coverage/` directory.

## Development Workflow

1. **Make changes** to source code in `src/`
2. **Run specific tests** for that module
3. **Verify no regressions** with `npm test`
4. **Build** with `npm run build`
5. **Test manually** if needed
6. **Commit** with confidence

## Getting Help

- **Test failures:** Check test output for specific error messages
- **Configuration issues:** Run `visor validate --config your-config.yaml`
- **API connectivity:** Use `--check-api` flag to test Slack connection
- **Setup questions:** See `docs/slack-bot-setup.md`
- **Troubleshooting:** See `docs/slack-bot-setup.md` Troubleshooting section

---

**Summary:** All 1742 tests passing = Your Slack bot implementation is working correctly! ✅
