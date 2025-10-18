# Run Modes in CI (including GitHub Actions)

Visor now defaults to CLI mode everywhere (no auto-detection). To enable GitHub-specific behavior (comments, checks), pass `--mode github-actions` or set the action input `mode: github-actions`.

Examples (GitHub Actions – CLI mode):

```yaml
jobs:
  visor-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx -y visor@latest --config .visor.yaml --output json
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

GitHub Actions behavior (comments/checks):

```yaml
jobs:
  visor-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx -y visor@latest --mode github-actions --config .visor.yaml --output json
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Notes:

- In CLI mode, GitHub credentials aren’t required. Provide your AI provider keys as env vars (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.).
- If you want PR comments/checks, run with `--mode github-actions` or use the published action with `with: mode: github-actions`.
