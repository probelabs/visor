# RFC: Enhanced Execution Logging & Statistics

**Status:** Implemented
**Date:** 2025-10-04
**Version:** 1.0

## Summary

This RFC describes the implementation of comprehensive execution statistics tracking and enhanced logging for Visor checks, providing users with clear visibility into forEach iterations, skip reasons, and overall execution metrics.

## Motivation

Users running complex Visor workflows with features like `forEach`, `if` conditions, and `fail_if` lacked visibility into:
- How many times each check actually ran (forEach iterations)
- Why checks were skipped and what conditions failed
- Overall execution metrics (total runs vs. configured checks)
- Performance bottlenecks (time per check/iteration)
- Issue distribution across checks

This made debugging and understanding workflow execution difficult.

## Design

### Architecture

The solution adds execution statistics tracking throughout the check execution lifecycle:

```
CheckExecutionEngine
├── executionStats: Map<string, CheckExecutionStats>  // Tracks all stats
├── initializeCheckStats()                             // Initialize stats for each check
├── recordIterationStart/Complete()                    // Track forEach iterations
├── recordSkip()                                       // Track skipped checks
├── recordError()                                      // Track failures
├── buildExecutionStatistics()                         // Build final stats object
└── logExecutionSummary()                              // Display symbol-rich table
```

### Data Structures

#### CheckExecutionStats
```typescript
interface CheckExecutionStats {
  checkName: string;
  totalRuns: number;          // How many times executed (1 or forEach iterations)
  successfulRuns: number;
  failedRuns: number;
  skipped: boolean;
  skipReason?: 'if_condition' | 'fail_fast' | 'dependency_failed';
  skipCondition?: string;     // The actual if condition text
  totalDuration: number;      // Total duration in milliseconds
  perIterationDuration?: number[];  // Duration for each iteration
  issuesFound: number;
  issuesBySeverity: {
    critical: number;
    error: number;
    warning: number;
    info: number;
  };
  outputsProduced?: number;   // For forEach checks
  errorMessage?: string;      // If failed
  forEachPreview?: string[];  // Preview of forEach items
}
```

#### ExecutionStatistics
```typescript
interface ExecutionStatistics {
  totalChecksConfigured: number;
  totalExecutions: number;     // Sum of all runs including forEach
  successfulExecutions: number;
  failedExecutions: number;
  skippedChecks: number;
  totalDuration: number;
  checks: CheckExecutionStats[];
}
```

### Tracking Points

1. **Initialization** (`executeDependencyAwareChecks` start)
   - Initialize stats for all checks

2. **forEach Execution** (when forEach items detected)
   - Record forEach preview items
   - Track each iteration start/complete
   - Log iteration progress: `✔ 3/5 (2.1s)`

3. **Normal Execution** (single runs)
   - Track start/complete
   - Record outputs produced

4. **Skip Conditions** (when `if` evaluates to false)
   - Record skip reason and condition
   - Log: `⏭ Skipped (if: branch == "main")`

5. **Errors** (on exception)
   - Record error message
   - Track failed iteration

6. **Completion** (`executeChecks` end)
   - Build final statistics
   - Display summary table

### Output Formats

#### Console (Table) - Default
```
┌───────────────────────────────────────┐
│ Execution Complete (45.3s)            │
├───────────────────────────────────────┤
│ Checks: 8 configured → 23 executions  │
│ Status: 20 ✔ │ 2 ✖ │ 1 ⏭             │
│ Issues: 15 total (3 🔴 12 ⚠️)         │
└───────────────────────────────────────┘

Check Details:
┌─────────────────────┬──────────┬──────────┬─────────────────────┐
│ Check               │ Duration │ Status   │ Details             │
├─────────────────────┼──────────┼──────────┼─────────────────────┤
│ list-files          │ 0.5s     │ ✔        │ →5                  │
│ validate-file       │ 12.3s    │ ✔ ×5     │ 12⚠️                │
│ security-scan       │ 8.2s     │ ✔        │ 3🔴                 │
│ transform-data      │ 6.1s     │ ✔ ×3     │ →3                  │
│ notify-slack        │ 2.1s     │ ✖ ×3     │ HTTP 500            │
│ production-only     │ -        │ ⏭ if     │ branch=="main"      │
│ archive-results     │ 1.3s     │ ✔        │                     │
│ final-report        │ 14.8s    │ ✔        │ →1                  │
└─────────────────────┴──────────┴──────────┴─────────────────────┘

Legend: ✔=success │ ✖=failed │ ⏭=skipped │ ×N=iterations │ →N=outputs │ N🔴=critical │ N⚠️=warnings
```

#### JSON Output
Full `executionStatistics` object included in JSON output with all tracked data:
- Per-iteration timings
- Skip condition evaluations
- forEach item previews
- Complete error messages

### Symbol Reference

| Symbol | Meaning | Example |
|--------|---------|---------|
| `✔` | Success (1 run) | `✔` |
| `✔ ×5` | Success (5 forEach iterations) | `✔ ×5` |
| `✖ ×3` | Failed (3 iterations) | `✖ ×3` |
| `✔/✖ 2/3` | Partial success (2 of 3 succeeded) | `✔/✖ 2/3` |
| `⏭ if` | Skipped (if condition) | `⏭ if` |
| `⏭ ff` | Skipped (fail-fast) | `⏭ ff` |
| `⏭ dep` | Skipped (dependency failed) | `⏭ dep` |
| `→N` | Produced N outputs | `→5` |
| `N🔴` | N critical issues | `3🔴` |
| `N⚠️` | N warnings | `12⚠️` |
| `N💡` | N info messages | `5💡` |

## Implementation

### Files Modified

1. **src/check-execution-engine.ts** (~300 lines added)
   - Added `CheckExecutionStats` and `ExecutionStatistics` interfaces
   - Added `executionStats` property to class
   - Implemented tracking methods:
     - `initializeCheckStats()`
     - `recordIterationStart/Complete()`
     - `recordSkip()`
     - `recordError()`
     - `recordForEachPreview()`
     - `buildExecutionStatistics()`
   - Implemented display methods:
     - `logExecutionSummary()`
     - `formatStatusColumn()`
     - `formatDetailsColumn()`
     - `truncate()`
   - Updated `executeDependencyAwareChecks()` to track stats
   - Updated `executeChecks()` to return statistics

2. **src/output-formatters.ts** (~5 lines added)
   - Added `executionStatistics?` field to `AnalysisResult` interface

### Backward Compatibility

✅ **No Breaking Changes**
- All changes are additive
- `executionStatistics` is optional in `AnalysisResult`
- Existing output formats continue to work
- Statistics appear automatically in table output (default)
- JSON/SARIF include statistics when available

## Examples

### Scenario 1: forEach with Multiple Iterations

**Config:**
```yaml
checks:
  list-files:
    type: command
    exec: echo '["a.json", "b.json", "c.json"]'
    forEach: true

  validate-file:
    type: command
    exec: jsonlint {{ outputs.list-files }}
    depends_on: [list-files]
```

**Output:**
```
▶ Running check: list-files [1/2]
✔ Check complete: list-files (0.3s) - 3 items

▶ Running check: validate-file [2/2]
  Processing 3 items...
  ✔ 1/3 (1.2s)
  ✔ 2/3 (1.1s)
  ✔ 3/3 (1.3s)
✔ Check complete: validate-file (3.6s) - 3 runs

┌───────────────────────────────────────┐
│ Execution Complete (3.9s)             │
├───────────────────────────────────────┤
│ Checks: 2 configured → 4 executions   │
│ Status: 4 ✔ │ 0 ✖ │ 0 ⏭              │
└───────────────────────────────────────┘

Check Details:
┌─────────────────────┬──────────┬──────────┬─────────────────────┐
│ Check               │ Duration │ Status   │ Details             │
├─────────────────────┼──────────┼──────────┼─────────────────────┤
│ list-files          │ 0.3s     │ ✔        │ →3                  │
│ validate-file       │ 3.6s     │ ✔ ×3     │                     │
└─────────────────────┴──────────┴──────────┴─────────────────────┘
```

### Scenario 2: Conditional Skip

**Config:**
```yaml
checks:
  production-deploy:
    type: command
    exec: ./deploy.sh
    if: 'branch == "main"'
```

**Output (on feature branch):**
```
▶ Running check: production-deploy [1/1]
⏭  Skipped (if: branch == "main")

┌───────────────────────────────────────┐
│ Execution Complete (0.0s)             │
├───────────────────────────────────────┤
│ Checks: 1 configured → 0 executions   │
│ Status: 0 ✔ │ 0 ✖ │ 1 ⏭              │
└───────────────────────────────────────┘

Check Details:
┌─────────────────────┬──────────┬──────────┬─────────────────────┐
│ Check               │ Duration │ Status   │ Details             │
├─────────────────────┼──────────┼──────────┼─────────────────────┤
│ production-deploy   │ -        │ ⏭ if     │ branch == "main"    │
└─────────────────────┴──────────┴──────────┴─────────────────────┘
```

## Benefits

1. **🎯 Clarity**: Users immediately see forEach iterations and skip reasons
2. **📊 Metrics**: Clear stats on total work done vs. configured checks
3. **⚡ Performance**: Easy to spot slow checks and iterations
4. **🐛 Debugging**: Skip conditions shown inline for quick troubleshooting
5. **📈 Automation**: Full stats in JSON for CI/CD analytics
6. **✅ Professional**: Clean, symbol-rich output matches modern CLIs

## Future Enhancements

Potential future improvements:
- Color-coded output (green/red/yellow) when terminal supports it
- Configurable verbosity levels for forEach iteration logging
- Export statistics to external monitoring systems
- Historical statistics comparison across runs
- Performance regression detection

## References

- Implementation PR: [Link to PR]
- Related Issues: Enhanced logging visibility (#XX)
- Documentation: Updated in CLAUDE.md and README.md
