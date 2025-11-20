## 📊 Output Formats

- Table: default terminal summary
- JSON: `--output json` for pipelines
- Markdown: render comments as markdown
- SARIF 2.1.0: `--output sarif` for code scanning

### Saving outputs reliably

- Use the built‑in `--output-file <path>` to write the formatted result directly to a file without mixing with logs.
- All status logs are sent to stderr; stdout contains only the formatted result when not using `--output-file`.

Examples:

```
visor --check all --output json --output-file results.json
visor --check security --output sarif --output-file visor-results.sarif
visor --check architecture --output markdown --output-file report.md
visor --check style --output table --output-file summary.txt
```
