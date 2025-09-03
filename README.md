# Gates - AI-Powered GitHub Action

A GitHub Action built with TypeScript and Octokit featuring AI-powered PR review capabilities and comment-based commands.

## Features

- **AI-Powered PR Reviews**: Automated code analysis with security, performance, and style checks
- **Comment Commands**: Interactive commands like `/review`, `/status`, `/help`
- **Automatic PR Reviews**: Optional auto-review on PR open events
- **Multiple Analysis Modes**: Focus on security, performance, or comprehensive analysis
- **Built with TypeScript and Octokit**
- **Comprehensive test suite** using Jest with E2E testing via mock-github and act-js

## Usage

### Basic Repository Information
```yaml
- name: Get Repository Info
  uses: ./
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    owner: 'octocat'
    repo: 'Hello-World'
```

### PR Review Bot
```yaml
name: PR Review Bot
on:
  pull_request:
    types: [opened, synchronize]
  issue_comment:
    types: [created]

jobs:
  review:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request' || (github.event_name == 'issue_comment' && github.event.issue.pull_request)
    steps:
      - uses: actions/checkout@v4
      - name: PR Review Bot
        uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          auto-review: ${{ github.event_name == 'pull_request' && 'true' || 'false' }}
```

## Comment Commands

Use these commands in PR comments to trigger different actions:

- **`/review`** - Perform a comprehensive code review
- **`/review --focus=security`** - Focus on security issues
- **`/review --focus=performance`** - Focus on performance issues  
- **`/review --format=detailed`** - Get detailed analysis with all issues
- **`/status`** - Show PR status and metrics
- **`/help`** - Display available commands

## Inputs

- `github-token`: GitHub token for authentication (required)
- `owner`: Repository owner (optional, defaults to repository owner)
- `repo`: Repository name (optional, defaults to repository name)
- `auto-review`: Enable automatic PR review on PR open events (optional, default: false)

## Outputs

- `repo-name`: Name of the repository
- `repo-description`: Description of the repository
- `repo-stars`: Number of stars on the repository
- `review-score`: Overall review score (0-100) for PR reviews
- `issues-found`: Number of issues found during PR review
- `auto-review-completed`: Whether automatic PR review was completed

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

## PR Review Analysis

The AI reviewer analyzes:

### Security Issues
- Potential XSS vulnerabilities (`eval`, `innerHTML`)
- Input validation concerns
- Dangerous function usage

### Performance Issues
- Nested loops and O(n²) algorithms
- Large dataset processing
- Inefficient operations

### Style & Code Quality
- Naming conventions
- Formatting consistency
- Missing documentation

### Logic Issues
- Large file changes (>100 lines)
- Missing error handling
- Complex function logic

## Testing

This project includes comprehensive testing using:

- **Jest**: For unit testing
- **@kie/mock-github**: For mocking GitHub environments  
- **@kie/act-js**: For testing GitHub Actions locally
- **Multiple Act Scenarios**: Testing different event types and commands

Run the test suite:

```bash
npm test                 # All tests
npm run test:watch      # Watch mode
npm run test:coverage   # With coverage
npm test -- tests/scenarios/  # Only scenario tests
```

## Act Scenarios

The project includes multiple act.js scenarios for testing:

### Comment Commands (`tests/scenarios/comment-commands.test.ts`)
- Tests `/review`, `/status`, `/help` commands
- Validates command parsing and argument handling
- Mock GitHub comment events

### PR Events (`tests/scenarios/pr-events.test.ts`)
- Auto-review on PR opened
- PR synchronize events
- Auto-review enable/disable functionality

### Workflow Integration (`tests/scenarios/workflow-integration.test.ts`)
- Full workflow execution with act.js
- YAML configuration validation
- End-to-end action testing

## Project Structure

```
.
├── src/
│   ├── index.ts          # Main action entry point
│   ├── commands.ts       # Comment command parsing
│   ├── pr-analyzer.ts    # PR diff and file analysis
│   └── reviewer.ts       # AI-powered code review logic
├── tests/
│   ├── unit/             # Unit tests for each module
│   ├── scenarios/        # Act.js E2E test scenarios
│   ├── fixtures/         # Test data and sample files
│   ├── unit.test.ts      # Main integration tests
│   └── integration.test.ts # Basic integration tests
├── .github/
│   └── workflows/
│       ├── test.yml      # CI workflow
│       └── pr-review.yml # PR review bot workflow
├── action.yml            # GitHub Action metadata
├── tsconfig.json         # TypeScript configuration
├── jest.config.js        # Jest test configuration
└── package.json          # Dependencies and scripts
```