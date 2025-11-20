## ⚡ Performance & Cost Controls

- Cache Node in CI: `actions/setup-node@v4` with `cache: npm`.
- Use tags: run `local,fast` on PRs; `remote,comprehensive` nightly.
- Increase `max-parallelism` cautiously if not reusing AI sessions.

