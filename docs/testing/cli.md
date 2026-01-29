# Visor Test CLI

Run integration tests for your Visor config using the built-in `test` subcommand.

## Commands

- Discover tests file and list cases
  - `visor test --list [--config defaults/visor.tests.yaml]`
- Run cases
  - `visor test [--config defaults/visor.tests.yaml] [--only <substring>] [--bail]`
- Validate tests YAML without running
  - `visor test --validate [--config defaults/visor.tests.yaml]`

## Auto-Discovery

When no `--config` is provided, the test runner searches for test files in the following order:

1. `defaults/visor.tests.yaml` or `defaults/visor.tests.yml`
2. `.visor.tests.yaml` or `.visor.tests.yml` in the project root

You can also pass a directory or glob pattern as a positional argument to discover multiple test suites:

```bash
visor test defaults/           # Run all suites in defaults/
visor test "**/*.tests.yaml"   # Run all matching suites
```

## Flags

### Core Flags

- `--config <path>`: Path to `.visor.tests.yaml` (auto-discovers if not specified).
- `--only <filter>`: Run cases whose `name` contains the substring (case-insensitive).
  - Stage filter: append `#<stage>` to run only a flow stage.
    - Examples: `--only pr-review-e2e-flow#facts-invalid`, `--only pr-review-e2e-flow#3` (1-based index)
- `--bail`: Stop on first failure.
- `--list`: List discovered test cases without running them.
- `--validate`: Validate tests YAML syntax without running.

### Parallelism

- `--max-parallel <N>`: Run up to N test cases concurrently within a suite (default: 1).
- `--max-suites <N>`: Run up to N test suites concurrently when discovering multiple files (default: number of CPUs).

### Output & Reporting

- `--json <path|->`: Write a minimal JSON summary (`-` for stdout).
- `--report junit:<path>`: Write a JUnit XML report.
- `--summary md:<path>`: Write a Markdown summary.
- `--progress compact|detailed`: Progress verbosity (default: compact).
- `--prompt-max-chars <N>`: Truncate captured prompt text to N characters.

### Debugging

- `--debug`: Enable debug mode for verbose output (equivalent to `VISOR_DEBUG=true`).
- `--no-mocks`: Run tests without mock injection. Real providers execute and outputs are printed as suggested mocks.

## Output

- Per-case PASS/FAIL lines
- Coverage table (expected vs actual step runs)
- Summary totals (Jest-style format)

## Tips

- Use `--validate` when iterating on tests to catch typos early.
- Keep `strict: true` in `tests.defaults` to surface missing `expect` quickly.
- For large suites, increase `--max-parallel` to improve throughput.
- Use `--no-mocks` to capture real provider outputs, then copy the suggested mocks into your test case.
- Enable debug logs with `--debug` or `VISOR_DEBUG=true`:
  ```bash
  visor test --debug --config defaults/visor.tests.yaml --only pr-review-e2e-flow#facts-invalid
  ```

## Related Documentation

- [Getting Started](./getting-started.md) - Introduction to the test framework
- [DSL Reference](./dsl-reference.md) - Complete test YAML schema
- [Assertions](./assertions.md) - Available assertion types
- [Fixtures and Mocks](./fixtures-and-mocks.md) - Managing test data
- [Flows](./flows.md) - Multi-stage test flows
- [CI Integration](./ci.md) - Running tests in CI pipelines
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
