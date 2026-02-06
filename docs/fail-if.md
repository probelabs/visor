# Fail If: Turning conditions into failures

Visor lets you declare simple expressions that fail a check when they evaluate to true. This works for any provider (ai, command, http_*, etc.) and is evaluated as part of the execution engine so dependents can be skipped reliably.

## Where to configure

- Per check:

```yaml
steps:
  analyze-bug:
    type: ai
    schema: ./schemas/ticket-analysis.json
    fail_if: output.error
```

- Global (applies to all checks unless the check overrides with its own `fail_if`):

```yaml
fail_if: outputs["fetch-tickets"].error
```

## Evaluation context

Inside the expression you can use:

### Primary context variables

- `output`: the current check's structured output.
  - Includes `issues` and any other fields produced by the provider.
  - For custom schemas, all top-level JSON fields are preserved and exposed here.
  - For command output that is JSON, fields are available directly; for plain text, treat `output` as a string.
- `outputs`: a map of dependency outputs keyed by check name. Each value is that check's `output` if present; otherwise the whole check result.

### Additional context variables

- `memory`: accessor for the memory store (see [Memory](./memory.md))
  - `memory.get(key, namespace?)` - Get a value
  - `memory.has(key, namespace?)` - Check if key exists
  - `memory.list(namespace?)` - List keys
  - `memory.getAll(namespace?)` - Get all key-value pairs
- `inputs`: workflow inputs (for workflows)
- `env`: environment variables
- `debug`: debug information (if available)
  - `debug.errors` - Array of error messages
  - `debug.processingTime` - Processing time in milliseconds
  - `debug.provider` - AI provider used
  - `debug.model` - AI model used

### Context for `if` conditions

When used in `if` conditions (not `fail_if`), additional context is available:

- `branch`: current branch name
- `baseBranch`: target branch (default: `main`)
- `filesChanged`: array of changed file paths
- `filesCount`: number of changed files
- `event`: GitHub event context with `event_name`, `action`, `repository`, etc.
- `checkName`, `schema`, `group`: check metadata

### Legacy context (backward compatibility)

- `issues`: shorthand for `output.issues`
- `criticalIssues`, `errorIssues`, `warningIssues`, `infoIssues`, `totalIssues`: count of issues by severity
- `metadata`: object containing `checkName`, `schema`, `group`, issue counts, `hasChanges`, `branch`, `event`

## Helper functions

### String helpers
- `contains(haystack, needle)` - Case-insensitive substring check
- `startsWith(s, prefix)` - Case-insensitive prefix check
- `endsWith(s, suffix)` - Case-insensitive suffix check
- `length(x)` - Length of string, array, or object keys

### Control helpers
- `always()` - Always returns `true`
- `success()` - Returns `true`
- `failure()` - Returns `false`

### Debugging
- `log(...args)` - Print debug output prefixed with emoji. See [Debugging Guide](./debugging.md)

### Issue/file matching helpers
- `hasIssue(issues, field, value)` - Check if any issue has a field matching value
- `countIssues(issues, field, value)` - Count issues matching field/value
- `hasFileMatching(issues, pattern)` - Check if any issue affects a file matching pattern
- `hasIssueWith(issues, field, value)` - Alias for `hasIssue`
- `hasFileWith(issues, pattern)` - Alias for `hasFileMatching`

### Author permission helpers
- `hasMinPermission(level)` - Check if author has at least the specified permission level
- `isOwner()` - Check if author is repository owner
- `isMember()` - Check if author is organization member
- `isCollaborator()` - Check if author is collaborator
- `isContributor()` - Check if author has contributed before
- `isFirstTimer()` - Check if author is a first-time contributor

See [Author Permissions](./author-permissions.md) for detailed usage.

## Truthiness

Truthiness rules follow JavaScript: non-empty strings are truthy, `""` and `null`/`undefined` are falsy, `0` is falsy.

## Complex failure conditions

For more control, use the complex form with additional options:

```yaml
failure_conditions:
  no_critical_issues:
    condition: "criticalIssues > 0"
    message: "Critical security issues found"
    severity: error      # error, warning, or info
    halt_execution: true # Stop all execution immediately
```

Options:
- `condition`: The expression to evaluate (required)
- `message`: Human-readable message when condition triggers (optional)
- `severity`: Issue severity level - `error`, `warning`, or `info` (default: `error`)
- `halt_execution`: If `true`, stops all workflow execution immediately (default: `false`)

## What happens when a condition is met

- The engine adds an issue to the check with ruleId `<checkName>_fail_if` (or `global_fail_if` for the global rule).
- Issue severity is `error` by default (configurable with complex form).
- Direct dependents of that check are skipped with reason `dependency_failed`.
- Skipped checks do not execute their providers; they appear as skipped in the details table.
- If `halt_execution: true`, the entire workflow stops immediately.

Only direct dependencies gate execution. Transitive checks are gated through the chain (i.e., if A fails B, and C depends on B, C will also be skipped once B is skipped).

## Examples

Fail when AI (custom schema) reports an error:

```yaml
steps:
  analyze-bug:
    type: ai
    schema: ./schemas/ticket-analysis.json
    fail_if: output.error
  log-results:
    type: command
    depends_on: [analyze-bug]
    exec: echo "OK"
```

Fail when a dependency produced an error flag:

```yaml
fail_if: outputs["fetch-tickets"].error
```

Fail on text output pattern:

```yaml
steps:
  lint:
    type: command
    exec: run-linter
    fail_if: contains(output, "ERROR:")
```

## ForEach and fail_if

When a check uses `forEach: true`, the engine evaluates `fail_if` once on the aggregated result (after all items complete). You can write expressions against the aggregated `output` (often an array), e.g.:

```yaml
fail_if: output.some(x => x.status === 'fail')
```

Per‑item fail logic is not evaluated via `fail_if`; use `if:` to skip item work or emit issues inside the per‑item action.

## Multi-line expressions

You can write multi-line expressions with debug statements:

```yaml
fail_if: |
  log("Checking output:", output);
  log("Issue count:", output.issues?.length);
  output.issues?.some(i => i.severity === 'critical')
```

The last expression determines the boolean result. Lines are joined using the comma operator.

## Notes

- Fail conditions are evaluated during dependency-aware execution as part of the engine (not only in providers), ensuring dependents are reliably skipped even if a provider path didn't attach issues.
- Issue ruleIds are consistent: `<checkName>_fail_if` for per-check and `global_fail_if` for global.
- Expressions support optional chaining (`?.`) and nullish coalescing (`??`) for safe property access.
- If expression evaluation fails, the condition is treated as `false` (fail-safe behavior).

## Related documentation

- [Author Permissions](./author-permissions.md) - Permission helper functions
- [Debugging Guide](./debugging.md) - Using `log()` and other debugging techniques
- [Memory](./memory.md) - Memory store access in expressions
- [Configuration](./configuration.md) - Full configuration reference
