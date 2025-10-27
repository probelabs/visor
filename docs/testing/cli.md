# Visor Test CLI

Run integration tests for your Visor config using the built-in `test` subcommand.

## Commands

- Discover tests file and list cases
  - `visor test --list [--config defaults/.visor.tests.yaml]`
- Run cases
  - `visor test [--config defaults/.visor.tests.yaml] [--only <substring>] [--bail]`
- Validate tests YAML without running
  - `visor test --validate [--config defaults/.visor.tests.yaml]`

## Flags

- `--config <path>`: Path to `.visor.tests.yaml` (auto-discovers `.visor.tests.yaml` or `defaults/.visor.tests.yaml`).
- `--only <filter>`: Run cases whose `name` contains the substring (case-insensitive).
- `--bail`: Stop on first failure.
- `--json <path|->`: Write a minimal JSON summary.
- `--report junit:<path>`: Write a minimal JUnit XML.
- `--summary md:<path>`: Write a minimal Markdown summary.
- `--progress compact|detailed`: Progress verbosity (parsing supported; detailed view evolves over time).
- `--max-parallel <N>`: Run up to N cases concurrently.
- `--prompt-max-chars <N>`: Truncate captured prompt text to N characters.

## Output

- Per-case PASS/FAIL lines
- Coverage table (expected vs actual step runs)
- Summary totals

## Tips

- Use `--validate` when iterating on tests to catch typos early.
- Keep `strict: true` in `tests.defaults` to surface missing `expect` quickly.
- For large suites, increase `--max-parallel` to improve throughput.

