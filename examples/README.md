# Visor Configuration Examples

This directory contains example configurations demonstrating various Visor features and use cases.

## 📁 Files Overview

### Basic Examples
- **`quick-start-tags.yaml`** - Simple configuration showing basic tag usage
- **`visor-with-tags.yaml`** - Comprehensive configuration with all tag features

### GitHub Actions Workflows
- **`github-workflow-with-tags.yml`** - Progressive code review workflow using tags

### Environment Configurations
- **`environments/visor.base.yaml`** - Base configuration with all check definitions
- **`environments/visor.dev.yaml`** - Development environment (fast, local checks)
- **`environments/visor.staging.yaml`** - Staging environment (balanced checks)
- **`environments/visor.prod.yaml`** - Production environment (comprehensive validation)

## 🚀 Quick Start

### 1. Basic Tag Usage

Start with the simple configuration:

```bash
# Copy the quick-start example
cp examples/quick-start-tags.yaml .visor.yaml

# Run local checks
visor --tags local,fast

# Run comprehensive checks
visor --tags remote,comprehensive
```

### 2. Environment-Based Configuration

Use different configurations for different environments:

```bash
# Development
visor --config examples/environments/visor.dev.yaml

# Staging
visor --config examples/environments/visor.staging.yaml

# Production
visor --config examples/environments/visor.prod.yaml
```

### 3. GitHub Actions Integration

Copy the workflow to your repository:

```bash
cp examples/github-workflow-with-tags.yml .github/workflows/code-review.yml
```

## 🏷️ Tag Strategy Guide

### Recommended Tag Taxonomy

#### Environment Tags
- `local` - Runs on developer machines
- `remote` - Runs in CI/CD
- `dev` - Development environment
- `staging` - Staging environment
- `prod` - Production environment

#### Speed Tags
- `fast` - Completes in < 30 seconds
- `slow` - Takes > 30 seconds
- `comprehensive` - Thorough but time-consuming

#### Category Tags
- `security` - Security-related checks
- `performance` - Performance analysis
- `quality` - Code quality and style
- `testing` - Test-related checks
- `documentation` - Documentation checks

#### Priority Tags
- `critical` - Must pass for deployment
- `optional` - Nice to have but not blocking
- `experimental` - Beta features

### Tag Combination Examples

```bash
# Fast security checks for local development
visor --tags local,fast,security

# All critical checks for production
visor --tags prod,critical

# Comprehensive review excluding experimental
visor --tags comprehensive --exclude-tags experimental

# Just the essentials
visor --tags critical,fast
```

## 📊 Execution Profiles

### Profile 1: Developer (Local)
```yaml
tag_filter:
  include: ["local", "fast"]
  exclude: ["slow", "experimental"]
```
- **Goal**: Quick feedback during development
- **Runtime**: < 1 minute
- **Use Case**: Pre-commit hooks, local testing

### Profile 2: Pull Request (CI)
```yaml
tag_filter:
  include: ["remote", "critical"]
  exclude: ["experimental"]
```
- **Goal**: Validate changes before merge
- **Runtime**: 2-5 minutes
- **Use Case**: GitHub Actions on PR

### Profile 3: Pre-Production (Staging)
```yaml
tag_filter:
  include: ["staging", "comprehensive"]
  exclude: ["experimental", "optional"]
```
- **Goal**: Thorough validation before production
- **Runtime**: 5-10 minutes
- **Use Case**: Staging deployment pipeline

### Profile 4: Production Release
```yaml
tag_filter:
  include: ["prod", "critical", "comprehensive"]
  exclude: ["experimental"]
```
- **Goal**: Maximum confidence for production
- **Runtime**: 10+ minutes
- **Use Case**: Production deployment gate

## 🔧 Advanced Patterns

### Pattern 1: Progressive Enhancement

Start with fast checks and progressively run more comprehensive ones:

```yaml
# Stage 1: Critical issues (fail fast)
visor --tags critical,fast --fail-fast

# Stage 2: Security scan (if stage 1 passes)
visor --tags security --exclude-tags fast

# Stage 3: Comprehensive review (if all pass)
visor --tags comprehensive --exclude-tags security,critical
```

### Pattern 2: Conditional Execution

Run checks based on file changes:

```yaml
checks:
  frontend-checks:
    tags: ["frontend", "conditional"]
    on: [pr_opened]
    if: "filesChanged.some(f => f.endsWith('.tsx'))"

  backend-checks:
    tags: ["backend", "conditional"]
    on: [pr_opened]
    if: "filesChanged.some(f => f.endsWith('.py'))"
```

### Pattern 3: Dependency Chains with Tags

```yaml
checks:
  quick-scan:
    tags: ["local", "fast"]

  deep-scan:
    tags: ["remote", "slow"]
    depends_on: [quick-scan]  # Only if quick-scan is included

  report:
    tags: ["reporting"]
    depends_on: [quick-scan, deep-scan]  # Uses whatever ran
```

## 🎯 Best Practices

1. **Start Simple**: Begin with `local`/`remote` or `fast`/`slow`
2. **Be Consistent**: Use the same tags across all projects
3. **Document Tags**: Maintain a tag glossary in your docs
4. **Review Regularly**: Audit and update tags as needs change
5. **Measure Impact**: Track execution times and adjust tags accordingly

## 💡 Tips

- Use `visor --help` to see all available options
- Combine `--tags` and `--exclude-tags` for precise control
- Set default `tag_filter` in config to avoid repetition
- Use environment-specific configs with `extends` for DRY principles
- Test tag filters with `--debug` to see which checks run

## 📚 Further Reading

- [Main README](../README.md) - Complete Visor documentation
- [Configuration Guide](../docs/configuration.md) - Detailed config options
- [GitHub Actions Guide](../docs/github-actions.md) - CI/CD integration