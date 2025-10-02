Build a feature that adds a "dry run" mode to the Visor CLI so developers can preview which checks would run, in what order, and why — without calling any AI providers or external services.

Requirements:
- CLI flag: `--dry-run`
- Print planned checks with dependency levels, tags, and if-conditions evaluation
- Show which checks are skipped due to tags/conditions
- Do not invoke providers; simulate outputs where sensible
- Include JSON export: `--output json` prints a machine-readable plan

Stretch goals:
- Allow `--include <glob>` and `--exclude <glob>` to simulate changed files
- Add a summary of potential cost/time based on tags (e.g., `fast`, `comprehensive`)

Constraints:
- Keep code isolated from execution path used in production runs
- Reuse existing dependency resolution logic where possible

