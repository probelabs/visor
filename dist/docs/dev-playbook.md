## Developer Experience Playbook

This guide covers both contributing to Visor and using it effectively.

### Quick Start for Contributors

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Run the CLI locally
./dist/index.js --help
```

### Development Commands

#### Build
| Command | Description |
|---------|-------------|
| `npm run build` | Build CLI and SDK |
| `npm run build:cli` | Build CLI only |
| `npm run build:sdk` | Build SDK only |
| `npm run clean` | Clean dist directory |

#### Testing
| Command | Description |
|---------|-------------|
| `npm test` | Run all tests (Jest + YAML tests) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Generate coverage report |
| `npm run test:yaml` | Run YAML-based tests only |
| `npm run test:yaml:parallel` | Run YAML tests with parallelism |

#### Code Quality
| Command | Description |
|---------|-------------|
| `npm run lint` | Lint TypeScript files |
| `npm run lint:fix` | Auto-fix linting issues |
| `npm run format` | Format code with Prettier |
| `npm run format:check` | Check code formatting |

#### Release
| Command | Description |
|---------|-------------|
| `npm run release` | Interactive release |
| `npm run release:patch` | Release patch version |
| `npm run release:minor` | Release minor version |
| `npm run release:major` | Release major version |

#### Deployment
| Command | Description |
|---------|-------------|
| `npm run deploy` | Deploy site and worker |
| `npm run deploy:site` | Deploy site to Cloudflare Pages |
| `npm run deploy:worker` | Deploy worker to Cloudflare |

#### Simulation & Debugging
| Command | Description |
|---------|-------------|
| `npm run simulate:issue` | Simulate GitHub issue event |
| `npm run simulate:comment` | Simulate GitHub comment event |

#### Running Locally
| Command | Description |
|---------|-------------|
| `./dist/index.js --config .visor.yaml` | Run with config file |
| `./dist/index.js --tui --config ./workflow.yaml` | Interactive TUI mode |
| `./dist/index.js --debug-server --debug-port 3456` | Visual debugger |
| `./dist/index.js --tui --debug` | TUI with debug logging |

See [Debugging Guide](debugging.md) for complete local development documentation.

### Using Visor Effectively

- **Start with defaults**: Copy `defaults/visor.yaml` or an example from `examples/`; run `npx -y @probelabs/visor@latest --check all --debug`.
- **Treat config as code**: Review `.visor.yaml` and templates; pin providers/models for reproducibility.
- **Roll out gradually**: Gate heavier checks with tags (`local`, `fast`, `critical`). See [Tag Filtering](tag-filtering.md).
- **Secure credentials**: Prefer GitHub App in production; scope/rotate API keys. See [Security](security.md).
- **Make feedback actionable**: Group related checks; use `/review --check ...` triggers; enable `reuse_ai_session` for follow-ups.
- **Keep suppressions intentional**: Annotate context; audit `visor-disable-file` periodically. See [Suppressions](suppressions.md).
- **Validate locally**: `npx -y @probelabs/visor@latest --check security --output markdown`; run tests; `--fail-fast` for fast lanes.

### Related Documentation

- [Configuration](configuration.md) - Full configuration reference
- [Debugging](debugging.md) - Debugging techniques and troubleshooting
- [Troubleshooting](troubleshooting.md) - Common issues and solutions
- [CI/CLI Mode](ci-cli-mode.md) - Running Visor in CI environments
- [Output Formats](output-formats.md) - Available output formats
