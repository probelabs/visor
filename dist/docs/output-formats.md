## Output Formats

Visor supports multiple output formats to suit different use cases, from terminal-friendly tables to machine-readable formats for CI/CD pipelines.

### Command-line Options

```bash
# Short form
visor -o json

# Long form
visor --output json

# Write to file instead of stdout
visor --output sarif --output-file results.sarif
```

Supported formats: `table` (default), `json`, `markdown`, `sarif`

---

## Table Format (Default)

The table format provides a colored, human-readable summary optimized for terminal output.

### Structure

```
Analysis Summary
┌─────────────────────────┬──────────────────────────────┐
│ Metric                  │ Value                        │
├─────────────────────────┼──────────────────────────────┤
│ Total Issues            │ 5                            │
│ Critical Issues         │ 1                            │
│ Files Analyzed          │ 12                           │
│ Total Additions         │ 245                          │
│ Total Deletions         │ 89                           │
│ Execution Time          │ 3421ms                       │
│ Checks Executed         │ security, performance        │
└─────────────────────────┴──────────────────────────────┘

SECURITY Issues (2)
┌─────────────────────────┬────────┬───────────────┬────────────────────────────────────────────────────────────┐
│ File                    │ Line   │ Severity      │ Message                                                    │
├─────────────────────────┼────────┼───────────────┼────────────────────────────────────────────────────────────┤
│ src/auth.ts             │ 42     │ CRITICAL      │ SQL injection vulnerability in user query                  │
│ src/utils.ts            │ 15     │ WARNING       │ Potential XSS via unsanitized input                        │
└─────────────────────────┴────────┴───────────────┴────────────────────────────────────────────────────────────┘
```

### Columns

| Column   | Width | Description                                    |
|----------|-------|------------------------------------------------|
| File     | 25    | Filename (truncated with `...` if too long)    |
| Line     | 8     | Line number of the issue                       |
| Severity | 15    | INFO, WARNING, ERROR, or CRITICAL              |
| Message  | 60    | Issue description with suggestions/code fixes  |

### Categories

Issues are grouped by category when `groupByCategory: true` (default):
- **Security** - Input validation, injection, authentication issues
- **Performance** - Optimization opportunities, resource management
- **Style** - Naming conventions, formatting inconsistencies
- **Logic** - Complexity, potential bugs, control flow issues
- **Documentation** - Missing or incomplete documentation

### Colored Output

When output is a TTY, severity levels are colorized:
- `critical` / `error` - Red
- `warning` - Yellow
- `info` - Cyan

### Truncation Behavior

Table cells are truncated to prevent rendering slowdowns:
- Maximum cell characters: 4000 (configurable via `VISOR_MAX_TABLE_CELL`)
- Maximum code block lines: 120 (configurable via `VISOR_MAX_TABLE_CODE_LINES`)
- Truncated content shows: `... [truncated]`

See [Output Formatting](./output-formatting.md) for detailed truncation controls.

---

## JSON Format

Machine-readable format ideal for programmatic processing and CI/CD pipelines.

```bash
visor -o json --output-file results.json
```

### Schema

```json
{
  "summary": {
    "totalIssues": 5,
    "criticalIssues": 1,
    "executionTime": 3421,
    "timestamp": "2024-01-15T10:30:00.000Z",
    "checksExecuted": ["security", "performance"]
  },
  "repository": {
    "title": "Fix authentication flow",
    "author": "developer",
    "base": "main",
    "head": "feature/auth-fix",
    "isGitRepository": true,
    "workingDirectory": "/home/user/project",
    "filesChanged": 12,
    "totalAdditions": 245,
    "totalDeletions": 89
  },
  "issues": {
    "security": [
      {
        "file": "src/auth.ts",
        "line": 42,
        "message": "SQL injection vulnerability in user query",
        "severity": "critical",
        "category": "security"
      }
    ],
    "performance": [],
    "style": [],
    "logic": [],
    "documentation": []
  },
  "files": [
    {
      "filename": "src/auth.ts",
      "status": "modified",
      "additions": 45,
      "deletions": 12
    }
  ],
  "debug": {
    "provider": "openai",
    "model": "gpt-4",
    "processingTime": 2100,
    "parallelExecution": true
  },
  "failureConditions": []
}
```

### Fields

| Field               | Type     | Description                                      |
|---------------------|----------|--------------------------------------------------|
| `summary`           | object   | Execution metrics and totals                     |
| `repository`        | object   | Repository and PR metadata                       |
| `issues`            | object   | Issues grouped by category                       |
| `files`             | array    | Changed files with diff statistics (optional)    |
| `debug`             | object   | Debug info when `--debug` enabled                |
| `failureConditions` | array    | Results of `fail_if` conditions                  |

---

## Markdown Format

GitHub-flavored markdown for embedding in PRs, wikis, or documentation.

```bash
visor -o markdown --output-file report.md
```

### Structure

```markdown
# Visor Analysis Results
<!-- analysis results -->

## Summary

| Metric | Value |
|--------|-------|
| Total Issues | 5 |
| Critical Issues | 1 |
| Files Analyzed | 12 |
| Execution Time | 3421ms |
| Checks Executed | security, performance |

## Repository Information

- **Title**: Fix authentication flow
- **Author**: developer
- **Branch**: feature/auth-fix <- main
- **Working Directory**: `/home/user/project`
- **Changes**: +245/-89

## Security Issues (2 found)

### `src/auth.ts:42`
**Severity**: CRITICAL
**Message**: SQL injection vulnerability in user query
**Suggestion**: Use parameterized queries instead of string concatenation

**Suggested Fix**:
```typescript
const result = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
```

<details>
<summary>Show 3 more issues...</summary>
<!-- Additional issues collapsed by default -->
</details>
```

### Sections

1. **Summary** - Metrics table with issue counts and execution stats
2. **Repository Information** - PR/branch context
3. **Issues by Category** - Grouped with severity, message, suggestions, and code fixes
4. **Files Changed** - Optional diff statistics table

---

## SARIF Format

[SARIF 2.1.0](https://sarifweb.azurewebsites.net/) format for integration with GitHub Code Scanning, VS Code, and other security tools.

```bash
visor -o sarif --output-file visor-results.sarif
```

### Schema

```json
{
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "version": "2.1.0",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "Visor",
          "version": "1.0.0",
          "informationUri": "https://github.com/your-org/visor",
          "rules": [
            {
              "id": "visor-security-input-validation",
              "shortDescription": { "text": "Input validation required" },
              "fullDescription": { "text": "Input validation and sanitization should be implemented..." },
              "helpUri": "https://owasp.org/www-project-top-ten/2017/A1_2017-Injection"
            }
          ]
        }
      },
      "results": [
        {
          "ruleId": "visor-security-input-validation",
          "ruleIndex": 0,
          "level": "error",
          "message": { "text": "SQL injection vulnerability in user query" },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": {
                  "uri": "src/auth.ts",
                  "uriBaseId": "%SRCROOT%"
                },
                "region": {
                  "startLine": 42,
                  "startColumn": 1
                }
              }
            }
          ]
        }
      ]
    }
  ]
}
```

### Severity Mapping

| Visor Severity | SARIF Level |
|----------------|-------------|
| `critical`     | `error`     |
| `error`        | `error`     |
| `warning`      | `warning`   |
| `info`         | `note`      |

### Rule IDs

| Category      | Rule ID                          |
|---------------|----------------------------------|
| security      | `visor-security-input-validation`|
| performance   | `visor-performance-optimization` |
| style         | `visor-style-consistency`        |
| logic         | `visor-logic-complexity`         |
| documentation | `visor-documentation-missing`    |

---

## Environment Variables

| Variable                    | Default | Description                                          |
|-----------------------------|---------|------------------------------------------------------|
| `VISOR_OUTPUT_FORMAT`       | `table` | Default output format (overridden by `-o`/`--output`)|
| `VISOR_MAX_TABLE_CELL`      | `4000`  | Maximum characters per table cell before truncation  |
| `VISOR_MAX_TABLE_CODE_LINES`| `120`   | Maximum code block lines in table cells              |

Example:
```bash
# Set default format via environment
export VISOR_OUTPUT_FORMAT=json
visor --config .visor.yaml  # Uses JSON format

# Override environment with CLI flag
visor -o table --config .visor.yaml  # Uses table format
```

---

## Use-Case Guidance

### When to Use Each Format

| Format   | Best For                                                    |
|----------|-------------------------------------------------------------|
| Table    | Interactive terminal use, quick human review                |
| JSON     | CI/CD pipelines, programmatic processing, API responses     |
| Markdown | PR comments, documentation, reports for stakeholders        |
| SARIF    | GitHub Code Scanning, IDE integrations, security dashboards |

### CI/CD Integration Patterns

**Basic CI Pipeline (JSON for parsing)**:
```yaml
- name: Run Visor
  run: |
    visor -o json --output-file results.json
    CRITICAL=$(jq '.summary.criticalIssues' results.json)
    if [ "$CRITICAL" -gt 0 ]; then
      echo "Critical issues found!"
      exit 1
    fi
```

**GitHub Actions with SARIF Upload**:
```yaml
jobs:
  visor:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
    steps:
      - uses: actions/checkout@v4

      - name: Run Visor
        run: npx -y @probelabs/visor@latest -o sarif --output-file visor-results.sarif
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: visor-results.sarif
          category: visor
```

**PR Comment with Markdown**:
```yaml
- name: Run Visor
  run: visor -o markdown --output-file report.md

- name: Comment on PR
  uses: marocchino/sticky-pull-request-comment@v2
  with:
    path: report.md
```

### Saving Output Reliably

Use `--output-file` to write results directly to a file without mixing with logs:

```bash
visor --check all --output json --output-file results.json
visor --check security --output sarif --output-file visor-results.sarif
visor --check architecture --output markdown --output-file report.md
visor --check style --output table --output-file summary.txt
```

All status logs are sent to stderr; stdout contains only the formatted result when not using `--output-file`.

---

## Related Documentation

- [Output Formatting](./output-formatting.md) - Table safety limits and truncation controls
- [CI/CLI Mode](./ci-cli-mode.md) - Running Visor in CI environments
- [Configuration](./configuration.md) - Full configuration options
- [Failure Conditions](./fail-if.md) - Exit codes and `fail_if` conditions
