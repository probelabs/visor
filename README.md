<div align="center">
  <img src="site/visor.png" alt="Visor Logo" width="200" />
  
  # Visor - AI-Powered Code Review
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue)](https://www.typescriptlang.org/)
  [![Node](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
  [![License](https://img.shields.io/badge/license-MIT-blue)]()
  
  **Intelligent code analysis for GitHub Pull Requests**
</div>

---

## 🚀 Quick Start

### As GitHub Action (Recommended)

Create `.github/workflows/code-review.yml`:

```yaml
name: Code Review
on: pull_request

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./  # or: gates-ai/visor-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
        env:
          # Choose one AI provider (see AI Configuration below)
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
          # ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          # OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

That's it! Visor will automatically review your PRs with AI-powered analysis.

### As CLI Tool

```bash
# Build the project
npm install
npm run build

# Run analysis
./dist/cli-main.js --check all

# Output as JSON
./dist/cli-main.js --check security --output json

# Use custom config
./dist/cli-main.js --config custom.yaml
```

## ✨ Features

- **Automated PR Reviews** - Analyzes code changes and posts review comments
- **Multiple Check Types** - Security, performance, style, and architecture analysis
- **Flexible Output** - Table, JSON, Markdown, or SARIF format
- **PR Commands** - Trigger reviews with `/review` comments
- **GitHub Integration** - Creates check runs, adds labels, posts comments

## 💬 PR Comment Commands

Add comments to your PR to trigger Visor:

- `/review` - Run all checks
- `/review --check security` - Run security checks only
- `/review --check performance` - Run performance checks only
- `/review --help` - Show available commands

## 📋 CLI Usage

```bash
visor [options]

Options:
  -c, --check <type>    Check type: security, performance, style, architecture, all
                        Can be used multiple times: --check security --check style
  -o, --output <format> Output format: table, json, markdown, sarif
                        Default: table
  --config <path>       Path to configuration file
                        Default: visor.config.yaml
  --version            Show version
  --help               Show help

Examples:
  visor --check all                    # Run all checks
  visor --check security --output json # Security check with JSON output
  visor --check style --check performance # Multiple specific checks
```

## 🤖 AI Configuration

Visor uses AI-powered code analysis to provide intelligent review feedback. Configure one of the following providers:

### Supported AI Providers

| Provider | Environment Variable | Recommended Models |
|----------|---------------------|-------------------|
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.0-flash-exp` (default), `gemini-1.5-pro` |
| Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-3-opus`, `claude-3-sonnet` |
| OpenAI GPT | `OPENAI_API_KEY` | `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo` |

### Setting Up API Keys

#### For GitHub Actions
Add your API key as a repository secret:
1. Go to Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add one of: `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`
4. (Optional) Add `AI_MODEL_NAME` to specify a model

#### For Local Development
Set environment variables:
```bash
# Using Google Gemini
export GOOGLE_API_KEY="your-api-key"
export MODEL_NAME="gemini-2.0-flash-exp"

# Using Anthropic Claude
export ANTHROPIC_API_KEY="your-api-key"
export MODEL_NAME="claude-3-sonnet"

# Using OpenAI GPT
export OPENAI_API_KEY="your-api-key"
export MODEL_NAME="gpt-4"
```

### Getting API Keys

- **Google Gemini**: [Get API Key](https://makersuite.google.com/app/apikey) (Free tier available)
- **Anthropic Claude**: [Get API Key](https://console.anthropic.com/)
- **OpenAI GPT**: [Get API Key](https://platform.openai.com/api-keys)

### Fallback Behavior

If no API key is configured, Visor will fall back to basic pattern-matching analysis:
- Keyword detection for security issues (e.g., `eval`, `innerHTML`)
- Simple performance checks (nested loops, large files)
- Basic style validation

For best results, configure an AI provider for intelligent, context-aware code review.

## 🧠 Advanced AI Features

### XML-Formatted Analysis
Visor now uses structured XML formatting when sending data to AI providers, enabling more precise and context-aware analysis:

```xml
<pull_request>
  <metadata>
    <title>Add user authentication</title>
    <author>developer</author>
    <files_changed_count>3</files_changed_count>
  </metadata>
  <description>
    This PR implements JWT-based authentication
  </description>
  <full_diff>
    --- src/auth.ts
    +++ src/auth.ts
    @@ -1,3 +1,10 @@
    +import jwt from 'jsonwebtoken';
    ...
  </full_diff>
</pull_request>
```

### Incremental Commit Analysis
When new commits are pushed to a PR, Visor performs incremental analysis:
- **Full Analysis**: Reviews the entire PR on initial creation
- **Incremental Analysis**: On new commits, focuses only on the latest changes
- **Smart Updates**: Updates existing review comments instead of creating duplicates

### Intelligent Comment Management
- **Unique Comment IDs**: Each PR gets a unique review comment that persists across updates
- **Collision Detection**: Prevents conflicts when multiple reviews run simultaneously
- **Context-Aware Updates**: Comments are updated with relevant context (PR opened, updated, synchronized)

## 🔧 Pluggable Architecture

Visor features a pluggable provider system for extensibility:

### Supported Check Types
- **AI Provider**: Intelligent analysis using LLMs (Google Gemini, Anthropic Claude, OpenAI GPT)
- **Tool Provider**: Integration with external tools (ESLint, Prettier, SonarQube)
- **Script Provider**: Custom shell scripts and commands
- **Webhook Provider**: External service integration via HTTP calls

### Adding Custom Providers
```typescript
// Custom provider implementation
export class CustomCheckProvider extends CheckProvider {
  getName(): string {
    return 'custom-security-scan';
  }
  
  async execute(prInfo: PRInfo, config: CheckProviderConfig): Promise<ReviewSummary> {
    // Your custom analysis logic
    return {
      issues: [...],
      suggestions: [...]
    };
  }
}

// Register your provider
CheckProviderRegistry.getInstance().registerProvider(new CustomCheckProvider());
```

## ⚙️ Configuration

Create `visor.config.yaml` in your project root:

```yaml
# visor.config.yaml
version: 1.0

# Project metadata
project:
  name: "My Project"
  description: "My awesome project"
  language: "typescript"    # primary language
  frameworks:               # frameworks in use
    - "react"
    - "nodejs"

# Analysis configuration  
analysis:
  # File patterns to include/exclude
  include:
    - "src/**/*"           # Include all files in src
    - "lib/**/*"           # Include all files in lib
  exclude:
    - "node_modules/**"    # Exclude node_modules
    - "dist/**"           # Exclude build output
    - "**/*.test.ts"      # Exclude test files
  
  # Limits
  maxFileSize: 500000      # Max file size in bytes (500KB)
  maxFiles: 1000          # Max number of files to analyze

# Check-specific settings
checks:
  security:
    enabled: true          # Enable/disable this check
    severity: warning      # Minimum severity: info, warning, error, critical
    rules:                 # Specific rules to apply
      - detect-secrets
      - xss-prevention
      - sql-injection
  
  performance:
    enabled: true
    severity: info
    rules:
      - complexity-analysis
      - memory-leaks
      - algorithm-efficiency
  
  style:
    enabled: true
    severity: info
    extends: "eslint:recommended"  # Extend from ESLint config
    rules:
      - naming-conventions
      - formatting
  
  architecture:
    enabled: true
    severity: warning
    rules:
      - circular-dependencies
      - design-patterns

# Thresholds for pass/fail
thresholds:
  minScore: 70            # Minimum overall score (0-100)
  maxIssues: 100         # Maximum total issues
  maxCriticalIssues: 0   # Maximum critical issues

# Output settings
reporting:
  format: markdown        # Default output format
  verbose: false         # Show detailed output
  includeFixSuggestions: true  # Include fix suggestions
  groupByFile: true      # Group issues by file
```

## 🎯 GitHub Action Reference

### Inputs

| Input | Description | Default | Required |
|-------|-------------|---------|----------|
| `github-token` | GitHub token for API access | `${{ github.token }}` | Yes |
| `auto-review` | Auto-review on PR open/update | `true` | No |
| `checks` | Checks to run (comma-separated) | `all` | No |
| `output-format` | Output format | `markdown` | No |
| `config-path` | Path to config file | `visor.config.yaml` | No |
| `comment-on-pr` | Post review as PR comment | `true` | No |
| `create-check` | Create GitHub check run | `true` | No |
| `add-labels` | Add quality labels to PR | `true` | No |
| `fail-on-critical` | Fail if critical issues found | `false` | No |
| `min-score` | Minimum score to pass (0-100) | `0` | No |

### Outputs

| Output | Description |
|--------|-------------|
| `review-score` | Overall code quality score (0-100) |
| `total-issues` | Total number of issues found |
| `critical-issues` | Number of critical issues |
| `auto-review-completed` | Whether auto-review was completed (true/false) |
| `pr-action` | The PR action that triggered the review (opened/synchronize/edited) |
| `incremental-analysis` | Whether incremental analysis was used (true/false) |
| `issues-found` | Total number of issues found (alias for total-issues) |
| `review-url` | URL to the review comment |

### Example Workflows

#### Basic Review with Incremental Analysis
```yaml
name: PR Review
on:
  pull_request:
    types: [opened, synchronize, edited]  # Enable incremental analysis on new commits

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          auto-review: true  # Enable automatic review
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
          MODEL_NAME: gemini-2.0-flash-exp
```

#### Security Focus with SARIF Upload
```yaml
name: Security Scan
on: [push, pull_request]

jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Visor Security Scan
        uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          checks: security
          output-format: sarif
      
      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v2
        if: always()
        with:
          sarif_file: visor-results.sarif
```

#### Quality Gate
```yaml
name: Quality Gate
on: pull_request

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          min-score: 80
          fail-on-critical: true
```

#### Command-Triggered Review
```yaml
name: Manual Review
on:
  issue_comment:
    types: [created]

jobs:
  review:
    if: |
      github.event.issue.pull_request &&
      startsWith(github.event.comment.body, '/review')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## 📊 Output Formats

### Table (Default)
```
╔════════════════════════════════════════════════════════════════╗
║                      Analysis Summary                          ║
╠════════════════════════════════════════════════════════════════╣
║ Overall Score: 85/100         Issues Found: 12                ║
╟────────────────────────────────────────────────────────────────╢
║ ✓ Security:     92/100    ⚠ Performance:  78/100             ║
║ ✓ Style:        88/100    ✓ Architecture: 82/100             ║
╚════════════════════════════════════════════════════════════════╝
```

### JSON
```json
{
  "summary": {
    "overallScore": 85,
    "totalIssues": 12,
    "criticalIssues": 1
  },
  "issues": [
    {
      "file": "src/api.ts",
      "line": 45,
      "severity": "critical",
      "category": "security",
      "message": "Potential SQL injection"
    }
  ]
}
```

### SARIF
Compatible with GitHub Security tab and other SARIF consumers.

## 🛠️ Development

### Setup
```bash
# Clone and install
git clone https://github.com/your-org/visor.git
cd visor
npm install

# Build
npm run build

# Test
npm test
```

### Project Structure
```
visor/
├── src/
│   ├── cli-main.ts         # CLI entry point
│   ├── index.ts            # GitHub Action entry
│   ├── reviewer.ts         # Core review logic
│   └── output-formatters.ts # Output formatting
├── tests/                  # Test suites
├── .github/workflows/      # GitHub workflows
├── action.yml             # Action metadata
└── visor.config.yaml      # Default config
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build TypeScript |
| `npm test` | Run tests |
| `npm run test:watch` | Test watch mode |
| `npm run test:coverage` | Coverage report |

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a PR

## 📄 License

MIT License - see [LICENSE](LICENSE) file

---

<div align="center">
  Made with ❤️ by <a href="https://probelabs.com">Probe Labs</a>
</div>