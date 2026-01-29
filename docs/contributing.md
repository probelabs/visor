# Contributing to Visor

Thank you for your interest in contributing to Visor! This guide provides
everything you need to get started with development, understand the codebase,
and submit high-quality contributions.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Code Standards](#code-standards)
- [Testing](#testing)
- [Adding New Features](#adding-new-features)
- [Pull Request Process](#pull-request-process)
- [Architecture Overview](#architecture-overview)
- [Common Tasks](#common-tasks)
- [Getting Help](#getting-help)

---

## Getting Started

### Prerequisites

- **Node.js**: Version 18 or higher (20 recommended)
- **npm**: Comes with Node.js
- **Git**: For version control

Verify your setup:

```bash
node --version   # Should be v18.x or higher
npm --version    # Should be v9.x or higher
git --version
```

### Cloning the Repository

```bash
git clone https://github.com/probelabs/visor.git
cd visor
```

### Installing Dependencies

```bash
npm install
```

This will also run the `prepare` script which sets up Husky for Git hooks.

### Building the Project

```bash
npm run build
```

This command:

1. Cleans the dist directory
2. Runs `patch-package` for any dependency patches
3. Generates the configuration schema
4. Builds the CLI bundle with `@vercel/ncc`
5. Builds the SDK with `tsup`

### Verifying Your Setup

```bash
# Run the test suite
npm test

# Run the CLI
./dist/index.js --help

# Check linting
npm run lint
```

---

## Development Workflow

### Development Commands

| Command                      | Description                                    |
| ---------------------------- | ---------------------------------------------- |
| `npm run build`              | Build CLI and SDK                              |
| `npm run build:cli`          | Build CLI only                                 |
| `npm run build:sdk`          | Build SDK only                                 |
| `npm run clean`              | Clean dist directory                           |
| `npm test`                   | Run all tests (Jest + YAML tests)              |
| `npm run test:watch`         | Run tests in watch mode                        |
| `npm run test:coverage`      | Generate coverage report                       |
| `npm run test:yaml`          | Run YAML-based tests only                      |
| `npm run test:yaml:parallel` | Run YAML tests with parallelism                |
| `npm run lint`               | Lint TypeScript files                          |
| `npm run lint:fix`           | Auto-fix linting issues                        |
| `npm run format`             | Format code with Prettier                      |
| `npm run format:check`       | Check code formatting                          |
| `npm run docs:validate`      | Validate README links                          |

### Running the CLI Locally

After building, you can run the CLI directly:

```bash
# Show help
./dist/index.js --help

# Run all checks
./dist/index.js --check all

# Run specific checks with debug output
./dist/index.js --check security,performance --debug

# Run with custom config
./dist/index.js --config my-config.yaml --check all

# Output in different formats
./dist/index.js --check all --output json
./dist/index.js --check all --output markdown
./dist/index.js --check all --output sarif
```

### Watch Mode Development

For rapid development, use watch mode for tests:

```bash
npm run test:watch
```

Note: There is no hot-reload for the CLI itself. You need to run `npm run build`
after making changes to source files.

### Debugging Techniques

1. **Enable debug mode**:

   ```bash
   ./dist/index.js --debug --config .visor.yaml
   ```

2. **Use the `log()` function** in JavaScript expressions (`if`, `fail_if`,
   `transform_js`):

   ```yaml
   if: |
     log("Debug:", outputs);
     return outputs.length > 0;
   ```

3. **Use the `json` filter** in Liquid templates:

   ```yaml
   prompt: |
     Debug: {{ outputs | json }}
   ```

4. **Use the logger check type**:

   ```yaml
   checks:
     debug-flow:
       type: logger
       message: |
         Outputs: {{ outputs | json }}
   ```

5. **Enable OpenTelemetry tracing**:
   ```bash
   VISOR_TELEMETRY_ENABLED=true \
   VISOR_TELEMETRY_SINK=otlp \
   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces \
   ./dist/index.js --config .visor.yaml
   ```

For more debugging techniques, see [docs/debugging.md](./debugging.md).

---

## Code Standards

### TypeScript Conventions

- **Target**: ES2022
- **Module**: CommonJS
- **Strict mode**: Enabled
- All source code is in the `src/` directory
- Tests are in the `tests/` directory

### ESLint Rules

Key ESLint rules enforced:

- `prefer-const`: Use `const` when variables are not reassigned
- `no-var`: Use `let` or `const` instead of `var`
- `@typescript-eslint/no-unused-vars`: No unused variables (allows `_` prefix
  for intentionally unused)
- Import `liquidjs` through `createExtendedLiquid()` from
  `src/liquid-extensions`

### Prettier Configuration

The project uses Prettier with these settings:

| Setting          | Value   |
| ---------------- | ------- |
| `semi`           | `true`  |
| `trailingComma`  | `es5`   |
| `singleQuote`    | `true`  |
| `printWidth`     | `100`   |
| `tabWidth`       | `2`     |
| `useTabs`        | `false` |
| `bracketSpacing` | `true`  |
| `arrowParens`    | `avoid` |
| `endOfLine`      | `lf`    |

For markdown files, `printWidth` is `80` with `proseWrap: always`.

### Naming Conventions

- **Files**: Use kebab-case for file names (`check-provider.interface.ts`)
- **Classes**: Use PascalCase (`CheckProvider`, `ConfigManager`)
- **Functions/Methods**: Use camelCase (`executeCheck`, `validateConfig`)
- **Constants**: Use UPPER_SNAKE_CASE for true constants
- **Interfaces**: Use PascalCase, prefix with `I` only if needed for clarity

### File Organization

```
src/
  index.ts                    # GitHub Action entry point
  cli-main.ts                 # CLI entry point
  config.ts                   # Configuration loading

  types/
    config.ts                 # Configuration types
    engine.ts                 # Engine state types
    execution.ts              # Execution result types
    cli.ts                    # CLI option types

  providers/
    check-provider.interface.ts  # Provider base class
    check-provider-registry.ts   # Provider registry
    ai-check-provider.ts         # AI provider
    command-check-provider.ts    # Command provider
    ...                          # Other providers

  state-machine/
    runner.ts                 # State machine runner
    states/                   # State handlers

  utils/                      # Utility functions
  telemetry/                  # OpenTelemetry integration
  debug-visualizer/           # Debug UI server
```

### Pre-commit Hooks

The project uses Husky with lint-staged to run checks before commits:

- ESLint with auto-fix on `src/**/*.ts` and `tests/**/*.ts`
- Prettier formatting on all staged files

---

## Testing

### Test Structure

Tests are organized by type:

```
tests/
  unit/                    # Unit tests for individual components
  integration/             # Integration tests with mocked APIs
  e2e/                     # End-to-end tests
  scenarios/               # Complex workflow scenarios
  performance/             # Performance and stress tests
  fixtures/                # Test data and mock responses
  errors/                  # Error handling tests
  edge-cases/              # Edge case tests
  setup.ts                 # Global test setup
```

### Writing Tests with Jest

Tests use Jest with SWC for TypeScript transformation. Example test:

```typescript
import { ConfigManager } from '../../src/config';

describe('ConfigManager', () => {
  beforeEach(() => {
    // Setup for each test
  });

  afterEach(() => {
    // Cleanup
  });

  it('should load configuration from file', async () => {
    const manager = new ConfigManager();
    const config = await manager.loadConfig('path/to/config.yaml');

    expect(config).toBeDefined();
    expect(config.checks).toBeDefined();
  });

  it('should throw on invalid configuration', async () => {
    const manager = new ConfigManager();

    await expect(manager.loadConfig('invalid.yaml')).rejects.toThrow();
  });
});
```

### Test Fixtures

Place test fixtures in `tests/fixtures/`:

```typescript
// tests/fixtures/sample-pr.ts
export const samplePR = {
  number: 123,
  title: 'Test PR',
  body: 'Test description',
  author: 'test-user',
  // ...
};
```

### Running Specific Tests

```bash
# Run a specific test file
npm test -- tests/unit/config.test.ts

# Run tests matching a pattern
npm test -- --testNamePattern="ConfigManager"

# Run tests in a specific directory
npm test -- tests/unit/

# Run with verbose output
npm test -- --verbose

# Update snapshots
npm test -- --updateSnapshot
```

### Test Configuration

Key Jest settings (from `jest.config.js`):

- **testTimeout**: 10 seconds (increased from default)
- **forceExit**: true (prevents hanging on async operations)
- **logHeapUsage**: Enabled in CI for memory monitoring
- **maxWorkers**: 1 in CI, 50% locally

### Coverage Requirements

Generate coverage reports:

```bash
npm run test:coverage
```

Coverage reports are generated in the `coverage/` directory. While there are no
strict coverage requirements, aim to maintain or improve coverage when adding
new code.

---

## Adding New Features

### Adding a New Provider

Providers are pluggable components that implement check types. To add a new
provider:

1. **Create the provider file** in `src/providers/`:

```typescript
// src/providers/my-custom-provider.ts
import { CheckProvider, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';

export class MyCustomProvider extends CheckProvider {
  getName(): string {
    return 'my-custom';
  }

  getDescription(): string {
    return 'My custom check provider';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    // Validate provider-specific configuration
    const cfg = config as CheckProviderConfig;
    return cfg.type === 'my-custom' && !!cfg.myRequiredField;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary> {
    // Implement your check logic here
    return {
      issues: [],
      summary: 'Check completed successfully',
    };
  }

  getSupportedConfigKeys(): string[] {
    return ['type', 'myRequiredField', 'optionalField'];
  }

  async isAvailable(): Promise<boolean> {
    // Check if required dependencies are available
    return true;
  }

  getRequirements(): string[] {
    return ['MY_API_KEY environment variable'];
  }
}
```

2. **Register the provider** in `src/providers/check-provider-registry.ts`:

```typescript
import { MyCustomProvider } from './my-custom-provider';

// In the registry initialization
registry.register(new MyCustomProvider());
```

3. **Add TypeScript types** if needed in `src/types/config.ts`

4. **Write tests** in `tests/unit/providers/my-custom-provider.test.ts`

5. **Add documentation** in `docs/providers/my-custom.md`

### Adding New Configuration Options

1. **Update the types** in `src/types/config.ts`:

```typescript
export interface CheckConfig {
  // ... existing fields
  myNewOption?: string;
}
```

2. **Update the schema generator** by running:

```bash
npm run prebuild
```

3. **Update documentation** in `docs/configuration.md`

4. **Add tests** for the new option

### Adding New CLI Commands

CLI commands are defined in `src/cli-main.ts` using Commander:

```typescript
program
  .command('my-command')
  .description('Description of my command')
  .option('-f, --flag <value>', 'Option description')
  .action(async (options) => {
    // Command implementation
  });
```

### Documentation Requirements

When adding new features:

1. Update relevant documentation in `docs/`
2. Add examples in `examples/` if appropriate
3. Update `CLAUDE.md` if the feature affects development workflow
4. Keep README examples accurate

---

## Pull Request Process

### Branch Naming Conventions

Use descriptive branch names:

- `feature/add-new-provider` - New features
- `fix/config-loading-error` - Bug fixes
- `docs/update-contributing` - Documentation updates
- `refactor/simplify-engine` - Code refactoring
- `test/add-provider-tests` - Test additions

### Commit Message Format

Write clear, descriptive commit messages:

```
<type>: <short description>

<optional longer description>

<optional footer with issue references>
```

Types:

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `refactor`: Code refactoring
- `test`: Test additions or changes
- `chore`: Build process or auxiliary tool changes

Examples:

```
feat: add HTTP client provider for external API calls

Implements a new provider type that can make HTTP requests
to external APIs and process the responses.

Closes #123
```

```
fix: resolve config loading race condition

The configuration loader was not awaiting async operations
properly, causing intermittent failures.
```

### Before Submitting

1. **Run the test suite**:

   ```bash
   npm test
   ```

2. **Run linting and formatting**:

   ```bash
   npm run lint
   npm run format
   ```

3. **Build the project**:

   ```bash
   npm run build
   ```

4. **Test your changes manually**:
   ```bash
   ./dist/index.js --check all --debug
   ```

### PR Description Template

When creating a PR, include:

```markdown
## Summary

Brief description of what this PR does.

## Changes

- List of specific changes
- Include any breaking changes

## Testing

How the changes were tested:

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing performed

## Related Issues

Closes #123
```

### Review Process

1. PRs require at least one approval before merging
2. All CI checks must pass
3. Address review comments or explain why changes are not needed
4. Keep PRs focused - prefer smaller, incremental changes

### CI Checks

The following checks run on PRs:

- **Lint**: ESLint checks
- **Format**: Prettier format check
- **Test**: Full test suite
- **Build**: Verify the project builds successfully

---

## Architecture Overview

For a detailed architecture overview, see [docs/architecture.md](./architecture.md).

### Key Files to Understand

| File                                   | Description                          |
| -------------------------------------- | ------------------------------------ |
| `src/index.ts`                         | GitHub Action entry point            |
| `src/cli-main.ts`                      | CLI entry point                      |
| `src/config.ts`                        | Configuration loading and validation |
| `src/check-execution-engine.ts`        | Main orchestration engine            |
| `src/state-machine-execution-engine.ts`| State machine runner                 |
| `src/providers/check-provider.interface.ts` | Provider base class             |
| `src/types/config.ts`                  | Configuration TypeScript types       |

### How the Codebase is Organized

1. **Entry Points**: `src/index.ts` (GitHub Action) and `src/cli-main.ts` (CLI)
2. **Configuration**: `src/config.ts` loads and validates YAML configuration
3. **Execution Engine**: `src/state-machine-execution-engine.ts` orchestrates
   check execution using a state machine
4. **Providers**: `src/providers/` contains pluggable check implementations
5. **Types**: `src/types/` contains TypeScript type definitions
6. **Utilities**: `src/utils/` contains helper functions

---

## Common Tasks

### Updating Dependencies

```bash
# Update a specific dependency
npm update <package-name>

# Update all dependencies (be careful)
npm update

# Check for outdated packages
npm outdated
```

After updating dependencies:

1. Run the full test suite
2. Build the project
3. Test the CLI manually

### Regenerating Types

The configuration schema is auto-generated from TypeScript types:

```bash
npm run prebuild
```

This runs `scripts/generate-config-schema.js` which generates the JSON schema
from `src/types/config.ts`.

### Updating Documentation

1. Edit files in `docs/`
2. Validate links: `npm run docs:validate`
3. Keep examples in `examples/` synchronized with documentation

### Running Simulations

Test GitHub event handling locally:

```bash
# Simulate issue event
npm run simulate:issue

# Simulate comment event
npm run simulate:comment
```

### Release Process

Releases are managed through npm scripts:

```bash
# Interactive release
npm run release

# Specific version bumps
npm run release:patch   # 0.1.42 -> 0.1.43
npm run release:minor   # 0.1.42 -> 0.2.0
npm run release:major   # 0.1.42 -> 1.0.0
```

The release script handles:

1. Version bumping in `package.json`
2. Building the project
3. Creating a git tag
4. Pushing to the repository
5. Publishing to npm

---

## Getting Help

- **Documentation**: Check the `docs/` directory
- **Issues**: Search or create issues on GitHub
- **Debugging**: See [docs/debugging.md](./debugging.md)
- **Troubleshooting**: See [docs/troubleshooting.md](./troubleshooting.md)

### Related Documentation

- [Configuration Reference](./configuration.md)
- [Architecture Overview](./architecture.md)
- [Debugging Guide](./debugging.md)
- [Troubleshooting](./troubleshooting.md)
- [Dev Playbook](./dev-playbook.md)
- [CI/CLI Mode](./ci-cli-mode.md)

---

Thank you for contributing to Visor!
