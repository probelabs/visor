# Fail If: Turning conditions into failures

Visor lets you declare simple expressions that fail a check when they evaluate to true. This works for any provider (ai, command, http_*, etc.) and is evaluated as part of the execution engine so dependents can be skipped reliably.

## Where to configure

- Per check:

```yaml
checks:
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

- `output`: the current check’s structured output.
  - Includes `issues` and any other fields produced by the provider.
  - For custom schemas, all top‑level JSON fields are preserved and exposed here.
  - For command output that is JSON, fields are available directly; for plain text, treat `output` as a string.
- `outputs`: a map of dependency outputs keyed by check name. Each value is that check’s `output` if present; otherwise the whole check result.

Helpers available: `contains(haystack, needle)`, `startsWith(s,prefix)`, `endsWith(s,suffix)`, `length(x)`, `always()`, `success()`, `failure()`, and issue/file matching helpers (see source FailureConditionEvaluator for the full list).

Truthiness rules follow JavaScript: non‑empty strings are truthy, `""` and `null`/`undefined` are falsy, `0` is falsy.

## What happens when a condition is met

- The engine adds an error‑severity issue to the check with ruleId `<checkName>_fail_if` (or `global_fail_if` for the global rule).
- Direct dependents of that check are skipped with reason `dependency_failed`.
- Skipped checks do not execute their providers; they appear as ⏭ in the details table.

Only direct dependencies gate execution. Transitive checks are gated through the chain (i.e., if A fails B, and C depends on B, C will also be skipped once B is skipped).

## Examples

Fail when AI (custom schema) reports an error:

```yaml
checks:
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
checks:
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

## Notes

- Fail conditions are evaluated during dependency‑aware execution as part of the engine (not only in providers), ensuring dependents are reliably skipped even if a provider path didn’t attach issues.
- Issue ruleIds are consistent: `<checkName>_fail_if` for per‑check and `global_fail_if` for global.

