## 🏷️ Tag-Based Check Filtering

Visor supports tagging checks to create flexible execution profiles. This lets you run different sets of checks in different environments (e.g., lightweight checks locally, comprehensive checks in CI).

### How It Works

1. Tag your checks with descriptive labels
2. Filter execution using `--tags` and `--exclude-tags`
3. Dependencies adapt intelligently based on what’s included

Note on defaults
- If you do NOT provide any tag filter (no `--tags`/`--exclude-tags` and no `tag_filter` in config), Visor only runs untagged checks. Any check that has `tags: [...]` is skipped by default. This keeps day‑to‑day runs lightweight and makes tagged groups opt‑in.
- To run tagged checks, explicitly include their tags (for example, `--tags github,security`).

### Basic Configuration

```yaml
# .visor.yaml
version: "1.0"

steps:
  # Fast, local security check
  security-quick:
    type: ai
    prompt: "Quick security scan for common vulnerabilities"
    tags: ["local", "fast", "security"]
    on: [pr_opened, pr_updated]

  # Comprehensive security analysis (for CI)
  security-comprehensive:
    type: ai
    prompt: "Deep security analysis with full vulnerability scanning"
    tags: ["remote", "comprehensive", "security", "slow"]
    on: [pr_opened]

  # Performance check that runs everywhere
  performance:
    type: ai
    prompt: "Analyze performance issues"
    tags: ["local", "remote", "performance", "fast"]
    on: [pr_opened, pr_updated]

  # Experimental new check
  ai-architecture:
    type: ai
    prompt: "AI-powered architecture review"
    tags: ["experimental", "architecture", "slow"]
    on: [manual]

  # Report that depends on security checks
  security-report:
    type: noop
    tags: ["reporting", "local", "remote"]
    depends_on: [security-quick, security-comprehensive]
    on: [pr_opened, pr_updated]
```

### CLI Usage

```bash
# Run only fast, local checks (great for pre-commit hooks)
visor --tags local,fast

# Run comprehensive remote checks (for CI/CD)
visor --tags remote,comprehensive

# Run all security-related checks
visor --tags security

# Run everything except slow checks
visor --exclude-tags slow

# Run everything except experimental features
visor --exclude-tags experimental

# Combine filters: Run fast security checks only
visor --tags security,fast

# Run local checks but skip experimental ones
visor --tags local --exclude-tags experimental
```

### GitHub Action Usage

```yaml
name: Code Review with Tags
on: pull_request

jobs:
  # Fast checks on every push
  fast-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@v1
        with:
          tags: "local,fast"
          exclude-tags: "experimental"
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}

  # Comprehensive checks only on main branch PRs
  comprehensive-review:
    if: github.base_ref == 'main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@v1
        with:
          tags: "remote,comprehensive"
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

### Common Tag Patterns

| Tag | Purpose | Example Use |
|-----|---------|-------------|
| `local` | Checks suitable for local development | Pre-commit hooks, developer testing |
| `remote` | Checks designed for CI/CD environments | GitHub Actions, Jenkins |
| `fast` | Quick checks (< 30 seconds) | Rapid feedback loops |
| `slow` | Time-consuming checks | Nightly builds, release validation |
| `security` | Security-related checks | Security audits |
| `performance` | Performance analysis | Performance testing |
| `style` | Code style and formatting | Linting, formatting |
| `experimental` | Beta/testing features | Opt-in testing |
| `critical` | Must-pass checks | Release gates |
| `comprehensive` | Thorough analysis | Full PR reviews |

### Advanced Examples

#### Default behavior vs. explicit tags

By default (no tag filter provided), only untagged checks execute. To include tagged checks, specify them explicitly:

```bash
# Default (no flags): only untagged checks
visor

# Include github-tagged checks (e.g., GitHub operations)
visor --tags github

# Include multiple tag groups
visor --tags github,security
```

In the test runner, you can mirror this behavior with the tests DSL:

```yaml
# defaults/.visor.tests.yaml
tests:
  defaults:
    # Run GitHub-tagged checks during tests
    tags: "github"
```

#### Environment-Specific Execution

```yaml
# Development environment - fast feedback
development:
  extends: .visor.yaml
  tag_filter:
    include: ["local", "fast"]
    exclude: ["experimental"]

# Staging environment - balanced
staging:
  extends: .visor.yaml
  tag_filter:
    include: ["remote", "security", "performance"]
    exclude: ["experimental"]

# Production environment - comprehensive
production:
  extends: .visor.yaml
  tag_filter:
    include: ["remote", "comprehensive", "critical"]
```

#### Multi-Stage Pipeline

```yaml
# GitHub Actions workflow with progressive checks
name: Progressive Code Review
on: pull_request

jobs:
  stage-1-fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@v1
        with:
          tags: "fast,critical"
          fail-fast: "true"  # Stop if critical issues found

  stage-2-security:
    needs: stage-1-fast
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@v1
        with:
          tags: "security"
          exclude-tags: "fast"  # Run deeper security checks

  stage-3-comprehensive:
    needs: [stage-1-fast, stage-2-security]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@v1
        with:
          tags: "comprehensive"
          exclude-tags: "fast,security"  # Run remaining checks
```

#### Dependency-Aware Filtering

When using tags with dependencies, Visor intelligently handles missing dependencies:

```yaml
steps:
  data-validation:
    type: ai
    prompt: "Validate data structures"
    tags: ["local", "data"]

  api-validation:
    type: ai
    prompt: "Validate API contracts"
    tags: ["remote", "api"]

  integration-report:
    type: noop
    tags: ["reporting"]
    depends_on: [data-validation, api-validation]
    # When filtered by "local" tag, only uses data-validation
    # When filtered by "remote" tag, only uses api-validation
    # With no filter, uses both dependencies
```

### Tag Validation Rules

- Tags must start with an alphanumeric character
- Can contain letters, numbers, hyphens, and underscores
- Examples: `local`, `test-env`, `feature_flag`, `v2`
- Invalid: `-invalid`, `@special`, `tag with spaces`

### Best Practices

1. Use consistent naming conventions across your organization
2. Document your tag taxonomy in your team's wiki
3. Start simple: begin with `local`/`remote` or `fast`/`slow`
4. Avoid over-tagging to reduce confusion
5. Use tag combinations for fine-grained control
6. Test tag filters before deploying broadly
