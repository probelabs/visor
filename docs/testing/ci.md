# CI Integration for Tests

Run your in‑YAML integration tests in CI using the Visor CLI. Below is a GitHub Actions example. Adapt for other CIs similarly.

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
      - run: npm run build --ignore-scripts

      - name: Run integration tests (defaults)
        run: |
          mkdir -p output
          node ./dist/index.js test \
            --config defaults/.visor.tests.yaml \
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

Tips
- Keep `ai_provider: mock` in `tests.defaults` for fast, deterministic runs.
- Set `--max-parallel` to speed up large suites (flows still run sequentially per case).
- Use `--bail` for faster feedback on PRs; run full suite on main.
- Collect artifacts so you can inspect failures without re-running.

