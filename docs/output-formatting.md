## Output Formatting and Safety Limits

Visor renders human‑friendly tables in the CLI using `cli-table3`. Extremely large or unbroken strings can make third‑party wrapping/width calculation slow. To keep rendering fast and predictable, Visor pre‑wraps and truncates content before handing it to the table library.

What this means when `--output table` is used:

- Long words are soft‑broken to avoid expensive width calculations.
- Very large cells are truncated with a clear marker:
  
  … [truncated]

- Code replacements are line‑capped and soft‑wrapped so they fit in the table column.

Environment knobs (advanced)

- `VISOR_MAX_TABLE_CELL` (default: `4000`)
  - Maximum characters allowed per table cell (after wrapping). Content beyond this is truncated and annotated.
- `VISOR_MAX_TABLE_CODE_LINES` (default: `120`)
  - Maximum number of code lines included in a single table cell. Extra lines are dropped and the block is annotated.

Notes

- These safety limits affect only the table output. JSON, SARIF, and Markdown formats are unaffected.
- If you need the complete, untruncated data for automation, prefer `--output json` (optionally with `--output-file`).

Troubleshooting

- If you notice slowdowns at “Formatting results as table”, try reducing `VISOR_MAX_TABLE_CELL` (e.g., `2000`) or use `--output json` for machine‑readable pipelines.

