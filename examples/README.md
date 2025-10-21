# Visor Examples

This directory contains SDK examples (programmatic usage) and configuration examples (YAML files).

## 🚀 SDK Examples (Programmatic Usage)

Use Visor from Node.js without shelling out.

### Running SDK Examples

```bash
# Build SDK first
npm run build:sdk

# Basic SDK examples
node examples/sdk-basic.mjs           # Minimal (5 lines)
node examples/sdk-cjs.cjs             # CommonJS
node examples/sdk-manual-config.mjs   # Manual config
node examples/sdk-comprehensive.mjs   # Complex with dependencies

# TypeScript (full type safety with SDK types)
npx tsc examples/sdk-typescript.ts --module esnext --target es2022 --moduleResolution bundler --esModuleInterop --skipLibCheck && node examples/sdk-typescript.js
```

### 🧮 Human-Input Calculator Examples

Interactive calculator demonstrating human-in-the-loop workflows:

```bash
# Interactive calculator with table output
bun examples/calculator-sdk-real.ts

# Calculator with JSON output (programmatic processing)
bun examples/calculator-sdk-json.ts

# Fully automated calculator (for testing/automation)
bun examples/calculator-sdk-automated.ts
bun examples/calculator-sdk-automated.ts 10 5 +  # With args

# YAML config version
./dist/index.js --config examples/calculator-config.yaml --message "10" --check get-number1
```

**Features demonstrated:**
- ✅ Human input via `human-input` check type
- ✅ Memory provider for state management
- ✅ JavaScript execution in memory provider
- ✅ Dependency chains with fail_if validation
- ✅ JSON output for programmatic processing
- ✅ Custom visualization in SDK scripts
- ✅ Suppressing stdout/stderr for clean JSON responses

See `docs/sdk.md` for full SDK documentation.

---

## 📝 Configuration Examples (YAML)

Example configurations demonstrating various Visor features and use cases.

## 📁 Files Overview

### Basic Examples
- **`quick-start-tags.yaml`** - Simple configuration showing basic tag usage
- **`visor-with-tags.yaml`** - Comprehensive configuration with all tag features
 - **`routing-basic.yaml`** - Failure routing with retry + goto ancestor
 - **`routing-on-success.yaml`** - on_success post-steps + single jump-back
 - **`routing-foreach.yaml`** - forEach remediation with run + retry
 - **`routing-dynamic-js.yaml`** - Dynamic routing via goto_js/run_js

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
steps:
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
steps:
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
### 4. Human Input Examples

Interactive workflows with human-in-the-loop:

```bash
# Basic human input patterns
visor --config examples/human-input-example.yaml

# Interactive calculator (demonstrates memory + JS + human input)
visor --config examples/calculator-config.yaml

# Run with inline message
visor --config examples/human-input-example.yaml --check approval-gate --message "yes"

# Run with file input (auto-detected)
echo "yes" > approval.txt
visor --config examples/human-input-example.yaml --check approval-gate --message approval.txt

# Run with piped input
echo "yes" | visor --config examples/human-input-example.yaml --check approval-gate
```

**Calculator Example:**
The calculator demonstrates a complete workflow:
1. Prompts for first number
2. Prompts for second number
3. Prompts for operation (+, -, *, /)
4. Stores values in memory
5. Calculates result using JavaScript
6. Displays formatted result

**SDK Usage:**

Two SDK examples are provided:

1. **`calculator-sdk-real.ts`** - Complete, runnable SDK example:
   - Real imports from Visor SDK
   - Config defined inline (no YAML needed)
   - Custom readline-based input hook
   - Full CheckExecutionEngine usage
   - Works in interactive or automated mode

   ```bash
   # Interactive mode
   ts-node examples/calculator-sdk-real.ts

   # Automated mode (for testing)
   ts-node examples/calculator-sdk-real.ts 42 7 +
   ```

2. **`calculator-sdk-example.ts`** - Documentation/template example:
   - Shows the structure and patterns
   - Includes comments and explanations
   - Generates YAML config for CLI usage

**SDK Pattern:**
```typescript
import { HumanInputCheckProvider } from '../src/providers/human-input-check-provider';
import { CheckExecutionEngine } from '../src/check-execution-engine';
import { VisorConfig } from '../src/types/config';

// Define config inline
const config: VisorConfig = {
  version: "1.0",
  checks: {
    "my-check": {
      type: "human-input",
      prompt: "Enter value:"
    }
  },
  output: { pr_comment: { format: "markdown", group_by: "check", collapse: false } }
};

// Set custom hook
HumanInputCheckProvider.setHooks({
  onHumanInput: async (request) => {
    return await myCustomHandler(request);
  }
});

// Run checks
const engine = new CheckExecutionEngine();
const results = await engine.executeChecks(prInfo, config, Object.keys(config.checks));
```

### 5. Failure Routing Examples

Run the examples directly from the repo root:

```bash
# Basic retry + goto ancestor
npx -y @probelabs/visor@latest --config examples/routing-basic.yaml --output table

# on_success: run notify and jump back once to re-run unit-tests
npx -y @probelabs/visor@latest --config examples/routing-on-success.yaml --output table

# forEach remediation: mark missing items then retry
npx -y @probelabs/visor@latest --config examples/routing-foreach.yaml --output table

# Dynamic routing with *_js hooks
npx -y @probelabs/visor@latest --config examples/routing-dynamic-js.yaml --output table
```

Notes:
- These examples create small temporary files in the repo (prefixed with `.visor_demo_`).
  Run `git clean -fdx` or delete the files manually to reset.
- The `routing` block supports `max_loops` and default retry policies; step-level settings override defaults.
- See `docs/failure-routing-rfc.md` for full semantics.
