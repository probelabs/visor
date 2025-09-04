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
```

That's it! Visor will automatically review your PRs.

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
| `overall-score` | Overall code quality score (0-100) |
| `total-issues` | Total number of issues found |
| `critical-issues` | Number of critical issues |
| `security-score` | Security analysis score |
| `performance-score` | Performance analysis score |
| `style-score` | Style analysis score |
| `architecture-score` | Architecture analysis score |
| `review-url` | URL to the review comment |

### Example Workflows

#### Basic Review
```yaml
name: PR Review
on: pull_request

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
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