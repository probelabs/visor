## 👀 Observability

- Machine-readable output: `--output json` or `--output sarif`.
- Prefer the built‑in `--output-file <path>` to save results without touching stdout.
- Status/progress logs are written to stderr; control verbosity via `-q`, `-v`, or `--debug`.

Examples:

```
visor --check all --output json --output-file results.json
visor --check security --output sarif --output-file visor-results.sarif
```
