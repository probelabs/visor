# CI Integration for Tests

Run your in-YAML integration tests in CI using the Visor CLI. Below is a GitHub Actions example. Adapt for other CIs similarly.

## Basic GitHub Actions Example

```yaml
name: Visor Tests
on: [pull_request]

jobs:
  tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run build

      - name: Run integration tests
        run: |
          mkdir -p output
          npx visor test \
            --config defaults/visor.tests.yaml \
            --json output/visor-tests.json \
            --report junit:output/visor-tests.xml \
            --summary md:output/visor-tests.md

      - name: Upload test artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: visor-test-results
          path: |
            output/visor-tests.json
            output/visor-tests.xml
            output/visor-tests.md
```

## Multi-Suite Discovery

When you have multiple test files, Visor can discover and run them all:

```yaml
- name: Run all test suites
  run: |
    mkdir -p output
    npx visor test tests/ \
      --max-suites 4 \
      --max-parallel 2 \
      --json output/visor-tests.json \
      --report junit:output/visor-tests.xml
```

The test runner automatically discovers:
- Files ending with `.tests.yaml` or `.tests.yml`
- YAML files containing a top-level `tests:` key with a `cases` array

## Validation-Only Step

Add a fast validation step before running tests to catch YAML syntax errors early:

```yaml
- name: Validate test files
  run: npx visor test --validate --config defaults/visor.tests.yaml
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VISOR_DEBUG` | `false` | Enable debug logging |
| `VISOR_TEST_PROMPT_MAX_CHARS` | `4000` (CI) / `8000` | Truncate captured prompts |
| `VISOR_TEST_HISTORY_LIMIT` | `200` (CI) / `500` | Limit output history entries |
| `CI` | - | Automatically detected; adjusts defaults |

## Tips

- Keep `ai_provider: mock` in `tests.defaults` for fast, deterministic runs.
- Set `--max-parallel` to speed up case execution within a suite.
- Set `--max-suites` to run multiple test files in parallel.
- Use `--bail` for faster feedback on PRs; run full suite on main.
- Collect artifacts so you can inspect failures without re-running.
- Use `--validate` in a separate step for faster feedback on syntax errors.

## See Also

- [CLI Reference](cli.md) - Full list of test command flags
- [Getting Started](getting-started.md) - Writing your first tests
- [Fixtures and Mocks](fixtures-and-mocks.md) - Mock AI providers for CI
- [Troubleshooting](troubleshooting.md) - Common CI issues

