# on_finish Hook - Implementation Status

> **Note (2026-01-28)**: This is a **historical planning document** from October 2025.
> The `on_finish` feature has been implemented but the codebase has since been refactored.
> Some file paths and line numbers in this document are outdated.
>
> **Current implementation locations:**
> - Core logic: `src/engine/on-finish/orchestrator.ts`, `src/engine/on-finish/utils.ts`
> - State machine integration: `src/state-machine/states/level-dispatch.ts`, `src/state-machine/dispatch/foreach-processor.ts`
> - Tests: `tests/engine/foreach-on-finish.engine.test.ts`, `tests/e2e/on-finish-*.test.ts`
>
> For current usage documentation, see `docs/failure-routing.md` and `docs/foreach-dependency-propagation.md`.

**Last Updated:** 2025-10-16
**Status:** ✅ FEATURE COMPLETE (Infrastructure Ready) - See note above for current locations

## What Was Built

### ✅ The `on_finish` Hook Feature (COMPLETE)

A new execution primitive that allows forEach checks to execute aggregation logic and dynamic routing **after ALL dependent checks complete ALL their forEach iterations**.

#### Core Implementation (100% Complete)

**1. Type Definitions**
- File: `src/types/config.ts`
- `OnFinishConfig` interface with fields: `run`, `goto`, `goto_js`, `goto_event`
- Added to `CheckConfig` as optional field

**2. Schema Validation**
- File: `src/config.ts`
- Validates `on_finish` only allowed on `forEach: true` checks
- Clear error messages for misconfiguration

**3. Execution Engine**
- File: `src/check-execution-engine.ts` (lines 283-748)
- `executeCheckInline()` method: Executes checks inline with dependency resolution (187 lines)
- `handleOnFinishHooks()` method: Complete on_finish execution logic (209 lines)
- Supports:
  - `on_finish.run`: Sequential execution of check array
  - `on_finish.goto_js`: Dynamic routing via JavaScript evaluation
  - `on_finish.goto`: Static routing
  - Full context: outputs, outputs.history, forEach stats, memory, pr, files, env
  - Error handling with fallback mechanisms
  - Comprehensive logging

**4. Testing**
- Unit tests: 10 tests in `tests/unit/on-finish-validation.test.ts`
- E2E tests: 20 tests in `tests/e2e/foreach-on-finish.test.ts`
- All 1449 tests passing, 0 failures
- No regressions

**5. Documentation**
- `docs/failure-routing.md`: Added 260 lines documenting on_finish
- `docs/dependencies.md`: Added 232 lines explaining forEach + on_finish
- `docs/foreach-dependency-propagation.md`: Added 372 lines with lifecycle
- Total: 864 lines of comprehensive documentation

**6. Example**
- `examples/fact-validator.yaml`: Complete working example (362 lines)
- Demonstrates real-world usage with fact validation scenario

---

## What This Enables

The `on_finish` hook is a **generic feature** that can be used for any post-forEach processing:

### Use Cases

1. **Aggregation**: Collect and summarize results from all forEach iterations
2. **Validation**: Check if all iterations meet certain criteria
3. **Retry Logic**: Route back to earlier checks based on aggregated results
4. **Conditional Routing**: Make decisions based on overall success/failure
5. **Reporting**: Generate summaries after batch processing
6. **Quality Gates**: Enforce thresholds across multiple validations

### Example: Fact Validator (Demonstration)

The `examples/fact-validator.yaml` file demonstrates one possible use case:
- Extract facts from AI responses (forEach)
- Validate each fact individually (forEach propagation)
- Aggregate validation results (on_finish.run)
- Retry with correction context if invalid (on_finish.goto_js)
- Post verified or unverified response

**This is an EXAMPLE, not a deployed feature.**

---

## Scope Clarification

### What's in This PR

✅ **The `on_finish` hook feature**
- New execution primitive
- Fully tested and documented
- Production-ready infrastructure
- Generic capability for any use case

### What's NOT in This PR

❌ **Fact validator as default behavior**
- The fact validator checks are NOT added to `defaults/.visor.yaml`
- This would make fact validation run by default for all users
- That decision is separate from implementing the hook feature

---

## Why This Scope Makes Sense

**1. Feature vs. Application**
- The `on_finish` hook is infrastructure (like `on_success` or `on_fail`)
- Fact validation is one specific application of that infrastructure
- Infrastructure should be generic, not tied to one use case

**2. User Choice**
- Users can opt into fact validation by using the example config
- Not all users may want AI responses to be fact-checked
- Keeps the default config lean and focused

**3. Consistency**
- Other features follow this pattern: implement primitive, provide example
- Examples: forEach itself, memory checks, webhook checks
- All have examples but aren't required in every config

**4. Testing**
- The `on_finish` hook is tested independently
- Fact validation as a system would need separate testing at scale
- Real-world usage will inform if it should be default

---

## Next Steps (If Desired)

### To Deploy Fact Validator by Default

If you want to make fact validation run by default:

1. **Add to defaults/.visor.yaml**
   - Copy checks from `examples/fact-validator.yaml`
   - Set `ENABLE_FACT_VALIDATION=true` by default
   - Update issue-assistant and comment-assistant prompts

2. **Additional Testing**
   - Test with real GitHub issues/comments
   - Measure performance impact
   - Tune prompts for accuracy
   - Test with different AI providers

3. **Documentation**
   - Update README to mention fact validation
   - Add user guide for configuring/disabling it
   - Document the retry behavior

4. **Monitoring**
   - Add metrics for validation accuracy
   - Track retry rates
   - Monitor latency impact

**Estimated Effort:** 8-12 hours

---

## Recommendation

**Ship the `on_finish` hook feature as-is.**

The PR is complete and production-ready. It delivers:
- A powerful new execution primitive
- Comprehensive tests and documentation
- A working example showing real-world usage

The fact validator can be adopted later as:
- Users opt-in via the example
- A follow-up PR if desired as default
- Community contributions with variations

**PR Title:** "Add `on_finish` hook for forEach aggregation and routing"

---

## Summary

**What we built:** A complete, tested, documented feature that extends Visor's execution model
**What we didn't build:** A specific application deployed by default
**Why this is correct:** Features should be generic; applications should be optional

✅ The `on_finish` hook is **production-ready and complete**.
