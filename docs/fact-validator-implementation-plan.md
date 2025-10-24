# Fact Validator Implementation Plan

## 🎯 CURRENT STATUS: 50% COMPLETE

**Last Updated:** 2025-10-16

### Implementation Status

| Component | Status | Files |
|-----------|--------|-------|
| **Phase 1: Infrastructure** | ✅ COMPLETE | `src/types/config.ts`, `src/config.ts`, `src/check-execution-engine.ts` |
| **Phase 2: Execution** | ✅ COMPLETE | `src/check-execution-engine.ts` (lines 283-748) |
| **Phase 3: Configuration** | ✅ COMPLETE | `examples/fact-validator.yaml` |
| **Phase 4: Documentation** | ⏳ PENDING | - |
| **Phase 5: Testing** | ⏳ PENDING | - |
| **Phase 6: Deployment** | ⏳ PENDING | - |

### Test Results

✅ **1438 tests passing, 0 failures**

### What's Working

- ✅ `on_finish` hook infrastructure (types, validation, detection)
- ✅ Full execution logic (`run`, `goto_js`, error handling, logging)
- ✅ Complete fact validator example configuration
- ✅ Memory-based retry tracking
- ✅ forEach iteration with aggregation
- ✅ Dynamic routing based on validation results

### Quick Test

```bash
npm run build
./dist/index.js --config examples/fact-validator.yaml --event issue_opened --cli
```

---

## Executive Summary

This plan implements an AI-powered fact validation system for GitHub issue and comment assistants. Before posting responses, the system:

1. **Extracts** all factual claims from the AI-generated response
2. **Validates** each fact individually using AI with code/documentation search
3. **Aggregates** validation results to determine overall accuracy
4. **Retries** the original assistant with fact-checking context if validation fails
5. **Posts** the response only after facts are verified (or max attempts reached)

**Key Feature**: Introduces a new `on_finish` routing hook on the forEach check itself to handle aggregation and routing after ALL dependent checks complete ALL iterations.

**Configuration**: Controlled by `ENABLE_FACT_VALIDATION` environment variable (enabled by default in workflows).

## Critical Design Decision: `on_finish` on forEach Check

### The Winning Argument: Multiple Dependents in forEach

The `on_finish` hook **MUST** be on the forEach check itself, not on dependent checks.

**Why?** Consider this scenario:

```yaml
checks:
  extract-facts:
    type: ai
    forEach: true
    # Outputs: [fact1, fact2, fact3]

  validate-security:
    depends_on: [extract-facts]
    # Runs 3 times, validates security aspects

  validate-technical:
    depends_on: [extract-facts]
    # Runs 3 times, validates technical aspects

  validate-format:
    depends_on: [extract-facts]
    # Runs 3 times, validates format/style
```

**With `on_finish` on forEach check:**
```yaml
extract-facts:
  forEach: true
  on_finish:  # ✅ Runs ONCE after ALL dependents complete ALL iterations
    run: [aggregate-all-validations]
    goto_js: |
      const securityValid = outputs.history['validate-security'].every(r => r.is_valid);
      const technicalValid = outputs.history['validate-technical'].every(r => r.is_valid);
      const formatValid = outputs.history['validate-format'].every(r => r.is_valid);

      if (!securityValid || !technicalValid || !formatValid) {
        return 'retry-with-context';
      }
      return null;
```

**This is the ONLY way to aggregate across ALL dependent checks!**

If `on_finish` were on dependent checks, each would trigger separately and there would be no single point to aggregate results from all dependents.

## User Requirements Met

- ✅ Fact validator enabled conditionally via environment variable
- ✅ Enabled by default in GitHub workflow
- ✅ Extract facts after AI generates response
- ✅ forEach validation of each fact individually
- ✅ **NEW**: `on_finish` hook on forEach check for post-iteration aggregation and routing
- ✅ Check if all facts valid after forEach completes
- ✅ Route back to original assistant with context if invalid (max 2 attempts)
- ✅ Track attempts in memory to prevent infinite loops
- ✅ Liquid templates check attempt count and fact data from memory
- ✅ Second pass includes fact validation context for AI to self-correct

## Architecture

### High-Level Flow

```mermaid
graph TD
    A[Issue/Comment Trigger] --> B[init-fact-validation-memory]
    B --> C[issue-assistant or comment-assistant]
    C --> D{ENABLE_FACT_VALIDATION?}
    D -->|No| E[post-direct-response]
    D -->|Yes| F[extract-facts: forEach with on_finish]
    F --> G{Any facts to validate?}
    G -->|No facts| E
    G -->|Yes| H[validate-fact: depends_on extract-facts]
    H --> I[forEach Iterations: fact 1...N]
    I --> J[on_finish triggers on extract-facts]
    J --> K[aggregate-validations via on_finish.run]
    K --> L{on_finish.goto_js evaluates}
    L -->|All valid| M[return null → proceed]
    L -->|Invalid + attempt < 2| N[increment attempt, return issue-assistant]
    L -->|Invalid + attempt >= 1| O[return null → give up]
    M --> P[post-verified-response]
    N --> C
    O --> Q[post-unverified-warning]

    style F fill:#ffeb3b,stroke:#f57c00,stroke-width:3px
    style J fill:#ffeb3b,stroke:#f57c00,stroke-width:3px

    classDef newFeature fill:#4caf50,stroke:#2e7d32,stroke-width:2px
    class F,J newFeature
```

**Legend:**
- 🟡 **Yellow boxes**: Components involving the new `on_finish` hook
- 🟢 **Green**: New features requiring implementation

### Detailed Flow with on_finish

```mermaid
graph TD
    A[issue-assistant generates response] --> B[extract-facts: AI with forEach]
    B --> C[validate-fact runs N times]
    C --> D1[Iteration 1]
    C --> D2[Iteration 2]
    C --> DN[Iteration N]
    D1 --> E[All iterations complete]
    D2 --> E
    DN --> E
    E --> F[on_finish.run executes]
    F --> G[aggregate-validations runs]
    G --> H[on_finish.goto_js evaluates]
    H -->|allValid = true| I[return null]
    H -->|allValid = false, attempt = 0| J[increment, return issue-assistant]
    H -->|allValid = false, attempt >= 1| K[return null]
    I --> L[post-verified-response]
    J --> A
    K --> M[post-unverified-warning]

    style E fill:#ffeb3b,stroke:#f57c00,stroke-width:3px
    style F fill:#ffeb3b,stroke:#f57c00,stroke-width:3px
```

## Complete Implementation

### 1. Environment Variable Configuration

Add to `.visor.yaml`:
```yaml
env:
  ENABLE_FACT_VALIDATION: "${{ env.ENABLE_FACT_VALIDATION }}"
```

Add to GitHub workflow (`.github/workflows/visor.yml`):
```yaml
env:
  ENABLE_FACT_VALIDATION: "true"  # Enable by default
```

### 2. Memory Initialization

```yaml
checks:
  init-fact-validation:
    type: memory
    operation: set
    key: fact_validation_attempt
    value: 0
    namespace: fact-validation
    on: [issue_opened, issue_comment]
    if: "env.ENABLE_FACT_VALIDATION === 'true'"
```

### 3. Update Assistants with Retry Context

```yaml
  issue-assistant:
    type: ai
    group: dynamic
    schema: issue-assistant
    depends_on: [init-fact-validation]
    prompt: |
      {% if memory.has('fact_validation_issues', 'fact-validation') %}
      ## ⚠️ Previous Fact Validation Issues
      The following facts were incorrect in your previous response:

      {% assign issues = memory.get('fact_validation_issues', 'fact-validation') %}
      {% for issue in issues %}
      - **{{ issue.claim }}** - {{ issue.issue }}
        - Evidence: {{ issue.evidence }}
        {% if issue.correction %}
        - Correct information: {{ issue.correction }}
        {% endif %}
      {% endfor %}

      Please correct these facts in your new response.
      {% endif %}

      You are a GitHub issue assistant for the {{ event.repository.fullName }} repository.

      [Rest of your existing issue-assistant prompt...]
    on: [issue_opened]

  comment-assistant:
    type: ai
    group: dynamic
    schema: issue-assistant
    depends_on: [init-fact-validation]
    prompt: |
      {% if memory.has('fact_validation_issues', 'fact-validation') %}
      ## ⚠️ Previous Fact Validation Issues
      [Same as above...]
      {% endif %}

      You are a GitHub comment assistant for {{ event.repository.fullName }}.

      [Rest of your existing comment-assistant prompt...]
    on: [issue_comment]
```

### 4. Fact Extraction (forEach with on_finish)

```yaml
  extract-facts:
    type: ai
    group: fact-validation
    schema: plain
    depends_on: [issue-assistant, comment-assistant]
    prompt: |
      Extract all factual claims from the following assistant response.

      Response:
      ```
      {{ outputs['issue-assistant'].text || outputs['comment-assistant'].text }}
      ```

      Extract facts in these categories:
      1. **Technical Facts**: How code/features work
      2. **Configuration Facts**: Settings, files, configuration
      3. **Documentation Facts**: References to docs, guides, examples
      4. **Version Facts**: Versions, releases, compatibility
      5. **Feature Facts**: Feature availability or behavior
      6. **Process Facts**: Workflows, procedures, best practices

      Return a JSON array of fact objects:
      ```json
      [
        {
          "id": "fact-1",
          "category": "Configuration Facts",
          "claim": "The default config file is .visor.yaml",
          "context": "Mentioned when explaining Visor setup",
          "verifiable": true
        }
      ]
      ```

      Return ONLY the JSON array. If no verifiable facts, return: []
    transform_js: |
      try {
        const parsed = JSON.parse(output);
        const verifiable = parsed.filter(f => f.verifiable === true);
        return verifiable;
      } catch (e) {
        log('Failed to parse facts:', e);
        return [];
      }
    forEach: true  # ← Makes this a forEach check

    # ✅ on_finish runs ONCE after ALL dependents complete
    on_finish:
      # First, run aggregation
      run: [aggregate-validations]

      # Then, routing decision based on aggregated results
      goto_js: |
        const allValid = memory.get('all_facts_valid', 'fact-validation');
        const attempt = memory.get('fact_validation_attempt', 'fact-validation') || 0;

        log('Fact validation complete - allValid:', allValid, 'attempt:', attempt);

        if (allValid) {
          log('All facts valid, proceeding to post');
          return null;  // Continue to post checks
        }

        if (attempt >= 1) {
          log('Max attempts reached, giving up');
          return null;  // Continue to warning check
        }

        // Retry with fact validation context
        log('Facts invalid, retrying assistant with context');
        memory.increment('fact_validation_attempt', 1, 'fact-validation');
        return event.name === 'issue_opened' ? 'issue-assistant' : 'comment-assistant';

      goto_event: "{{ event.event_name }}"

    on: [issue_opened, issue_comment]
    if: "env.ENABLE_FACT_VALIDATION === 'true'"
```

### 5. Fact Validation (Dependent Check)

```yaml
  validate-fact:
    type: ai
    group: fact-validation
    schema: plain
    depends_on: [extract-facts]
    prompt: |
      Verify this factual claim using available MCP tools.

      Fact to verify:
      - **Category**: {{ outputs['extract-facts'].category }}
      - **Claim**: {{ outputs['extract-facts'].claim }}
      - **Context**: {{ outputs['extract-facts'].context }}

      ## Verification Process

      1. **Use MCP tools** to search code, read docs, check config
      2. **Search relevant files**:
         - Config facts → .visor.yaml, defaults/.visor.yaml, examples/
         - Feature facts → docs/, src/
         - Doc facts → Verify links and file references
      3. **Cross-reference** with examples and patterns

      Return JSON:
      ```json
      {
        "fact_id": "{{ outputs['extract-facts'].id }}",
        "claim": "{{ outputs['extract-facts'].claim }}",
        "is_valid": true,
        "confidence": "high",
        "evidence": "Found in defaults/.visor.yaml:10",
        "correction": null,
        "sources": ["defaults/.visor.yaml", "docs/configuration.md"]
      }
      ```

      Be thorough. If unsure, mark confidence as "low".
      Return ONLY the JSON object.
    transform_js: |
      try {
        return JSON.parse(output);
      } catch (e) {
        log('Failed to parse validation:', e);
        return {
          fact_id: outputs['extract-facts'].id,
          claim: outputs['extract-facts'].claim,
          is_valid: false,
          confidence: 'low',
          evidence: 'Failed to parse validation response',
          correction: null,
          sources: []
        };
      }
    on: [issue_opened, issue_comment]
    if: "env.ENABLE_FACT_VALIDATION === 'true'"
```

### 6. Aggregate Validation Results

```yaml
  aggregate-validations:
    type: memory
    operation: exec_js
    namespace: fact-validation
    memory_js: |
      // Get ALL validation results from forEach iterations
      const validations = outputs.history['validate-fact'];

      log('Aggregating', validations.length, 'validation results');

      // Analyze results
      const invalid = validations.filter(v => !v.is_valid);
      const lowConfidence = validations.filter(v => v.confidence === 'low');
      const allValid = invalid.length === 0 && lowConfidence.length === 0;

      // Store results
      memory.set('all_facts_valid', allValid, 'fact-validation');
      memory.set('validation_results', validations, 'fact-validation');
      memory.set('invalid_facts', invalid, 'fact-validation');
      memory.set('low_confidence_facts', lowConfidence, 'fact-validation');

      // Store issues for retry context
      if (!allValid) {
        const issues = [...invalid, ...lowConfidence].map(v => ({
          claim: v.claim,
          issue: v.is_valid ? 'low confidence' : 'incorrect',
          evidence: v.evidence,
          correction: v.correction
        }));
        memory.set('fact_validation_issues', issues, 'fact-validation');
      }

      return {
        total: validations.length,
        valid: validations.filter(v => v.is_valid && v.confidence !== 'low').length,
        invalid: invalid.length,
        low_confidence: lowConfidence.length,
        all_valid: allValid,
        summary: allValid
          ? 'All facts validated successfully'
          : `Found ${invalid.length} invalid and ${lowConfidence.length} low-confidence facts`
      };
    on: [issue_opened, issue_comment]
```

### 7. Post Verified Response

```yaml
  post-verified-response:
    type: github
    tags: [github]
    depends_on: [extract-facts]
    on: [issue_opened, issue_comment]
    if: |
      env.ENABLE_FACT_VALIDATION === 'true' &&
      memory.get('all_facts_valid', 'fact-validation') === true
    op: comment.create
    value: |
      {{ outputs['issue-assistant'].text || outputs['comment-assistant'].text }}
```

### 8. Post Unverified Warning

```yaml
  post-unverified-warning:
    type: github
    tags: [github]
    depends_on: [extract-facts]
    on: [issue_opened, issue_comment]
    if: |
      env.ENABLE_FACT_VALIDATION === 'true' &&
      memory.get('all_facts_valid', 'fact-validation') === false &&
      memory.get('fact_validation_attempt', 'fact-validation') >= 1
    op: comment.create
    value: |
      ⚠️ **Fact Validation Warning**

      I attempted to respond to your {{ event.name === 'issue_opened' ? 'issue' : 'comment' }}, but could not verify all factual claims after validation.

      **Issues Found:**
      {% assign invalid = memory.get('invalid_facts', 'fact-validation') %}
      {% for fact in invalid %}
      - **{{ fact.claim }}**: {{ fact.evidence }}
        {% if fact.correction %}
        - Correction: {{ fact.correction }}
        {% endif %}
      {% endfor %}

      {% assign lowConf = memory.get('low_confidence_facts', 'fact-validation') %}
      {% if lowConf.size > 0 %}

      **Low Confidence:**
      {% for fact in lowConf %}
      - **{{ fact.claim }}**: {{ fact.evidence }}
      {% endfor %}
      {% endif %}

      I recommend having a human team member review this to provide accurate information.
```

### 9. Direct Post (Validation Disabled)

```yaml
  post-direct-response:
    type: github
    tags: [github]
    depends_on: [issue-assistant, comment-assistant]
    on: [issue_opened, issue_comment]
    if: "env.ENABLE_FACT_VALIDATION !== 'true'"
    op: comment.create
    value: |
      {{ outputs['issue-assistant'].text || outputs['comment-assistant'].text }}
```

## on_finish Hook Implementation Requirements

### Type Definitions (`src/types/config.ts`)

```typescript
interface CheckConfig {
  type: string;
  forEach?: boolean;
  on_finish?: RoutingAction;  // NEW: Only valid on forEach checks
  on_success?: RoutingAction;
  on_fail?: RoutingAction;
  // ... other fields
}

interface RoutingAction {
  run?: string[];
  run_js?: string;
  goto?: string;
  goto_js?: string;
  goto_event?: string;
  retry?: RetryConfig;
}
```

### Execution Engine (`src/check-execution-engine.ts`)

**Key behaviors to implement:**

1. **Trigger Condition**:
   - Only on checks with `forEach: true`
   - Triggers AFTER all dependent checks complete ALL their iterations
   - Does NOT trigger if forEach array is empty

2. **Execution Order**:
   ```
   forEach check executes once → outputs array
   ↓
   All dependent checks execute N times (forEach propagation)
   ↓
   on_finish.run executes (checks in order)
   ↓
   on_finish.run_js evaluates (additional dynamic checks)
   ↓
   on_finish.goto_js evaluates (routing decision)
   ↓
   If goto returned, jump to ancestor check
   ```

3. **Context Available**:
   ```javascript
   {
     step: { id: 'extract-facts', tags: [...], group: '...' },
     attempt: 1,
     loop: 2,
     outputs: {
       'extract-facts': [...],        // Array of items
       'validate-fact': [...],        // Array of ALL results
     },
     outputs.history: {
       'extract-facts': [[...], ...], // Cross-loop history
       'validate-fact': [[...], ...],
     },
     forEach: {
       total: 3,
       successful: 3,
       failed: 0,
       items: [...]
     },
     memory,
     pr,
     files,
     env
   }
   ```

4. **Error Handling**:
   - If `on_finish.run` checks fail, mark forEach check as failed
   - If `goto_js` throws error, fallback to static `goto` or skip routing
   - Clear error if `on_finish` used on non-forEach check

5. **Loop Safety**:
   - Count `on_finish.goto` toward `max_loops`
   - Track routing transitions
   - Abort with clear message if max_loops exceeded

### Schema Validation (`src/config.ts`)

```typescript
// Validation rules:
// 1. on_finish only allowed on checks with forEach: true
// 2. on_finish.goto must be ancestor (same as on_success/on_fail)
// 3. on_finish.goto_js must return string or null
// 4. on_finish.run must be array of valid check IDs

if (check.on_finish && !check.forEach) {
  throw new Error(
    `Check '${checkId}' has on_finish but forEach is not true. ` +
    `on_finish is only valid on forEach checks.`
  );
}
```

### Documentation Updates

1. **`docs/failure-routing.md`**: Add `on_finish` section
2. **`docs/dependencies.md`**: Explain `on_finish` with forEach
3. **`examples/foreach-on-finish.yaml`**: Complete working example
4. **`docs/foreach-dependency-propagation.md`**: Update with `on_finish`

## Testing Strategy

### Unit Tests

1. **on_finish Trigger**:
   - Triggers after last forEach iteration
   - Does NOT trigger for empty arrays
   - Does NOT trigger on non-forEach checks

2. **on_finish Execution Order**:
   - `run` executes before `goto`
   - `run_js` evaluates after `run`
   - `goto_js` evaluates last

3. **on_finish Context**:
   - Has access to `outputs.history` of all dependents
   - Has `forEach` stats (total, successful, failed)
   - Has correct `attempt` and `loop` counters

4. **Error Cases**:
   - Error if `on_finish` on non-forEach check
   - Handle `goto_js` errors gracefully
   - Handle failed `on_finish.run` checks

### Integration Tests

1. **Full Fact Validation Flow**:
   - Issue opened → assistant → extract → validate → aggregate → post
   - All facts valid → direct post
   - Some facts invalid → retry → validate → post

2. **Retry Logic**:
   - Invalid facts → retry once with context → validate → post
   - Invalid facts → retry → still invalid → warning post

3. **Edge Cases**:
   - No facts extracted → direct post
   - All facts low confidence → retry
   - Validation disabled → direct post

4. **Multiple Dependents**:
   - forEach with multiple dependent checks
   - Aggregate across all dependents
   - Route based on combined results

### E2E Tests

1. **GitHub Issue Opened**:
   - Real issue → assistant response → fact validation → post
2. **Comment on Issue**:
   - Comment → response → invalid facts → retry → post
3. **Validation Disabled**:
   - Comment → response → direct post (no validation)

## Quick Reference

### Configuration Checklist

- [x] Add `ENABLE_FACT_VALIDATION` to workflow env (default: "true") ✅
- [x] Implement `on_finish` hook in execution engine ✅
- [x] Add type definitions for `on_finish` ✅
- [x] Add schema validation for `on_finish` ✅
- [x] Add memory initialization check ✅
- [x] Add fact extraction AI check with `forEach` and `on_finish` ✅
- [x] Add fact validation AI check (depends on extract-facts) ✅
- [x] Add aggregation memory check ✅
- [x] Add response posting checks (verified/unverified/direct) ✅
- [x] Update issue-assistant with retry context ✅
- [x] Update comment-assistant with retry context ✅

**Status:** All core configuration items complete. See `examples/fact-validator.yaml` for reference.

### Check Names

```yaml
init-fact-validation        # Memory: Initialize attempt counter
issue-assistant             # AI: Generate issue response
comment-assistant           # AI: Generate comment response
extract-facts               # AI: Extract facts (forEach: true, on_finish)
validate-fact               # AI: Validate each fact (depends on extract-facts)
aggregate-validations       # Memory: Collect validation results (run by on_finish)
post-verified-response      # GitHub: Post response (all facts valid)
post-unverified-warning     # GitHub: Post warning (max attempts reached)
post-direct-response        # GitHub: Post directly (validation disabled)
```

### Memory Keys (namespace: fact-validation)

```yaml
fact_validation_attempt     # number: Current attempt (0, 1, 2)
all_facts_valid             # boolean: True if all facts validated
validation_results          # array: All validation results
invalid_facts               # array: Facts that failed validation
low_confidence_facts        # array: Facts with low confidence
fact_validation_issues      # array: Issues for retry context
```

### Liquid Template Examples

```liquid
{# Check if fact validation is enabled #}
{% if env.ENABLE_FACT_VALIDATION == 'true' %}

{# Get current attempt #}
{% assign attempt = "fact_validation_attempt" | memory_get: "fact-validation" %}

{# Check if all facts are valid #}
{% assign allValid = "all_facts_valid" | memory_get: "fact-validation" %}

{# Get invalid facts #}
{% assign invalidFacts = "invalid_facts" | memory_get: "fact-validation" %}
{% for fact in invalidFacts %}
  - {{ fact.claim }}: {{ fact.evidence }}
{% endfor %}

{% endif %}
```

### JavaScript Examples

```javascript
// In on_finish.goto_js
const allValid = memory.get('all_facts_valid', 'fact-validation');
const attempt = memory.get('fact_validation_attempt', 'fact-validation') || 0;

// Get all validation results from forEach iterations
const results = outputs.history['validate-fact'];
const allResultsValid = results.every(r => r.is_valid);

// Decide whether to retry
if (!allValid && attempt < 1) {
  memory.increment('fact_validation_attempt', 1, 'fact-validation');
  return event.name === 'issue_opened' ? 'issue-assistant' : 'comment-assistant';
}
return null;
```

## Rollout Plan

### Phase 1: on_finish Hook Implementation (3-4 days)
- Implement TypeScript types
- Implement execution engine logic
- Add schema validation
- Write unit tests
- Update documentation

### Phase 2: Fact Validator Configuration (2-3 days)
- Create complete .visor.yaml configuration
- Implement all checks
- Test forEach and on_finish integration
- Write integration tests

### Phase 3: Testing & Refinement (2-3 days)
- E2E testing with real scenarios
- Tune prompts for better fact extraction
- Tune confidence thresholds
- Performance testing

### Phase 4: Documentation & Examples (1-2 days)
- Complete user documentation
- Add example configurations
- Create debugging guide
- Write best practices

### Phase 5: Deployment (1 day)
- Enable in staging
- Monitor metrics
- Enable in production
- Set up alerts

**Total**: 9-13 days

## Success Metrics

1. **Accuracy Rate**: % of responses with all facts validated correctly
2. **Validation Coverage**: % of responses that go through validation
3. **Retry Rate**: % requiring retry after failed validation
4. **False Positive Rate**: % of valid facts marked invalid
5. **Performance**: Average latency added by validation
6. **User Satisfaction**: Feedback on response accuracy

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| High latency | High | Medium | Configurable enable/disable, optimize prompts |
| False positives | Medium | High | Thorough testing, tune thresholds |
| Infinite loops | Low | High | Hard limit (max 2 attempts), memory tracking |
| API quota exhaustion | Medium | Medium | Rate limiting, caching |

## Conclusion

This fact validation system significantly improves AI response accuracy while maintaining flexibility. The key innovation is the `on_finish` hook on forEach checks, enabling clean aggregation and routing after all dependent validations complete.

### Key Benefits

1. **on_finish Hook**: Clean primitive for post-forEach processing
2. **Self-Correcting AI**: Retry with validation context
3. **Granular Validation**: Each fact validated independently
4. **Safe Loops**: Memory tracking prevents recursion
5. **Flexible**: Easy to enable/disable per environment

---

## 📋 IMPLEMENTATION TASK LIST

### ✅ PHASE 1: Core `on_finish` Hook Infrastructure (COMPLETED)

**Priority: P0 (CRITICAL) - Status: ✅ DONE**

- [x] **1.1** Create `OnFinishConfig` interface in `src/types/config.ts`
  - [x] Add `run?: string[]` field
  - [x] Add `goto?: string` field
  - [x] Add `goto_event?: EventTrigger` field
  - [x] Add `goto_js?: string` field
  - [x] Add `run_js?: string` field
  - [x] Add `on_finish?: OnFinishConfig` to `CheckConfig`

- [x] **1.2** Add schema validation in `src/config.ts`
  - [x] Validate `on_finish` only allowed on `forEach: true` checks
  - [x] Add clear error messages
  - [x] Fix missing 'memory' check type

- [x] **1.3** Implement detection & triggering in `src/check-execution-engine.ts`
  - [x] Create `handleOnFinishHooks()` method
  - [x] Detect forEach checks with `on_finish`
  - [x] Verify all dependents completed
  - [x] Build context (outputs, forEach stats, memory, PR)
  - [x] Skip empty forEach arrays

- [x] **1.4** Write comprehensive tests
  - [x] Unit tests for validation (3 tests)
  - [x] E2E tests for integration (4 tests)
  - [x] Verify no regressions (full suite)

**Result:** ✅ All 1426 tests passing, infrastructure solid

---

### ✅ PHASE 2: Complete `on_finish` Execution (COMPLETED)

**Priority: P0 (CRITICAL - BLOCKING) - Status: ✅ DONE**

- [x] **2.1** Detection and context building ✅
  - [x] Detect `on_finish` configuration
  - [x] Build forEach stats
  - [x] Prepare outputs context
  - [x] Create memory helpers

- [x] **2.2** Implement `executeCheckInline()` method ✅
  - [x] Extract/refactor `executeNamedCheckInline` from `executeWithRouting()`
  - [x] Make it a class method accessible to `handleOnFinishHooks()`
  - [x] Handle check dependencies
  - [x] Update results map
  - [x] Support event override (`goto_event`)
  - [x] Add error handling
  - **Files modified:** `src/check-execution-engine.ts` (lines 283-470)

- [x] **2.3** Implement `on_finish.run` execution ✅
  - [x] Iterate through `onFinish.run` array
  - [x] Call `executeCheckInline()` for each check
  - [x] Execute in order (sequential)
  - [x] Propagate errors properly
  - [x] Log execution start/complete
  - **Files modified:** `src/check-execution-engine.ts` (lines 625-668)

- [x] **2.5** Implement `on_finish.goto_js` evaluation ✅
  - [x] Compile JS expression with Sandbox
  - [x] Evaluate with full context
  - [x] Extract goto target (string or null)
  - [x] Call `executeCheckInline()` with target
  - [x] Support `goto_event` override
  - [x] Handle null return (no routing)
  - [x] Add loop safety checks
  - **Files modified:** `src/check-execution-engine.ts` (lines 670-748)

- [x] **2.6** Implement static `on_finish.goto` execution ✅
  - [x] Check for static goto string
  - [x] Call `executeCheckInline()` with target
  - [x] Support `goto_event` override
  - **Files modified:** `src/check-execution-engine.ts` (lines 710-713)

- [x] **2.7** Add comprehensive error handling ✅
  - [x] Try-catch around `run` execution
  - [x] Try-catch around `goto_js` evaluation
  - [x] Fallback to static `goto` on `goto_js` error
  - [x] Clear error messages
  - [x] Log all errors

- [x] **2.8** Add execution logging ✅
  - [x] Log `on_finish` start
  - [x] Log each check execution
  - [x] Log routing decisions
  - [x] Log completion
  - [x] Debug output for context

- [x] **2.9** Write tests for execution ✅
  - [x] Unit test: `on_finish.run` executes in order
  - [x] Unit test: `on_finish.goto_js` routes correctly
  - [x] Unit test: Error handling works
  - [x] E2E test: Full routing flow
  - [x] E2E test: Retry with memory
  - **Files:** `tests/unit/on-finish-validation.test.ts`, `tests/e2e/foreach-on-finish.test.ts`
  - **Result:** 1438 tests passing, 0 failures

**Total Phase 2: COMPLETED** ✅

---

### ✅ PHASE 3: Fact Validator Configuration (COMPLETED)

**Priority: P1 (HIGH) - Status: ✅ DONE**

- [x] **3.1** Create memory initialization check ✅
  - [x] Type: `memory`
  - [x] Operation: `set`
  - [x] Key: `fact_validation_attempt`
  - [x] Value: `0`
  - [x] Namespace: `fact-validation`
  - [x] Add `if` condition for `ENABLE_FACT_VALIDATION`
  - **File:** `examples/fact-validator.yaml`

- [x] **3.2** Update issue-assistant prompt ✅
  - [x] Add Liquid template check for `memory.has('fact_validation_issues')`
  - [x] Display previous validation failures
  - [x] Format correction context clearly
  - [x] Test template rendering
  - **File:** `examples/fact-validator.yaml`

- [x] **3.3** Update comment-assistant prompt ✅
  - [x] Add same Liquid template logic as issue-assistant
  - [x] Ensure consistency in error display
  - [x] Test template rendering
  - **File:** `examples/fact-validator.yaml`

- [x] **3.4** Create extract-facts check ✅
  - [x] Type: `command` (demo) / `ai` (production)
  - [x] Schema: `plain`
  - [x] Depends on: `[issue-assistant, comment-assistant]`
  - [x] Write comprehensive extraction prompt
  - [x] Add `transform_js` to parse and filter facts
  - [x] Set `forEach: true`
  - [x] Add `on_finish` configuration:
    - [x] `run: [aggregate-validations]`
    - [x] `goto_js`: Check validation results and route
    - [x] `goto_event`: Pass through event
  - [x] Add `if` condition for `ENABLE_FACT_VALIDATION`
  - **File:** `examples/fact-validator.yaml`

- [x] **3.5** Create validate-fact check ✅
  - [x] Type: `command` (demo) / `ai` (production)
  - [x] Schema: `plain`
  - [x] Depends on: `[extract-facts]`
  - [x] Write validation prompt with MCP tools
  - [x] Instructions for using code search
  - [x] Instructions for reading documentation
  - [x] Add `transform_js` to parse validation result
  - [x] Handle parse errors gracefully
  - [x] Add `if` condition for `ENABLE_FACT_VALIDATION`
  - **File:** `examples/fact-validator.yaml`

- [x] **3.6** Create aggregate-validations check ✅
  - [x] Type: `memory`
  - [x] Operation: `exec_js`
  - [x] Namespace: `fact-validation`
  - [x] Write `memory_js` to:
    - [x] Get all validation results from `outputs.history['validate-fact']`
    - [x] Calculate `all_facts_valid`
    - [x] Store `invalid_facts`
    - [x] Store `low_confidence_facts`
    - [x] Store `fact_validation_issues` for retry
    - [x] Return summary object
  - **File:** `examples/fact-validator.yaml`

- [x] **3.7** Create post-verified-response check ✅
  - [x] Type: `logger` (demo) / `github` (production)
  - [x] Depends on: `[extract-facts]`
  - [x] Operation: `comment.create`
  - [x] Add `if` condition: `all_facts_valid === true`
  - [x] Value: Original assistant response
  - **File:** `examples/fact-validator.yaml`

- [x] **3.8** Create post-unverified-warning check ✅
  - [x] Type: `logger` (demo) / `github` (production)
  - [x] Depends on: `[extract-facts]`
  - [x] Operation: `comment.create`
  - [x] Add `if` condition: `all_facts_valid === false && attempt >= 1`
  - [x] Value: Warning with validation issues
  - [x] Format invalid and low-confidence facts
  - **File:** `examples/fact-validator.yaml`

- [x] **3.9** Create post-direct-response check ✅
  - [x] Type: `logger` (demo) / `github` (production)
  - [x] Depends on: `[issue-assistant, comment-assistant]`
  - [x] Operation: `comment.create`
  - [x] Add `if` condition: `ENABLE_FACT_VALIDATION !== 'true'`
  - [x] Value: Direct assistant response
  - **File:** `examples/fact-validator.yaml` (commented out in demo)

- [x] **3.10** Add environment configuration ✅
  - [x] Add to configuration: `env.ENABLE_FACT_VALIDATION`
  - [x] Test environment variable passing
  - **File:** `examples/fact-validator.yaml`

**Total Phase 3: COMPLETED** ✅

**Deliverable:** Complete working example at `examples/fact-validator.yaml` (474 lines) demonstrating:
- ✅ Memory-based retry tracking
- ✅ Conditional assistant prompts with validation context
- ✅ forEach fact extraction
- ✅ Parallel fact validation (N iterations)
- ✅ on_finish aggregation with `run` and `goto_js`
- ✅ Smart routing based on validation results
- ✅ Multiple posting paths (verified/unverified/direct)

**Test Command:** `./dist/index.js --config examples/fact-validator.yaml --event issue_opened --cli`

---

### ✅ PHASE 4: Documentation & Examples (COMPLETED)

**Priority: P2 (MEDIUM) - Status: ✅ DONE**

- [x] **4.1** Update `docs/failure-routing.md` ✅
  - [x] Add `on_finish` section (260 lines)
  - [x] Explain when it triggers
  - [x] Show examples with forEach
  - [x] Document context available
  - **File:** `docs/failure-routing.md` (lines 160-420)

- [x] **4.2** Update `docs/dependencies.md` ✅
  - [x] Explain `on_finish` with forEach propagation
  - [x] Show dependency chain examples
  - [x] Document best practices
  - **File:** `docs/dependencies.md` (lines 83-315)

- [x] **4.3** Complete working example ✅
  - [x] Created `examples/fact-validator.yaml` (474 lines)
  - [x] Added comprehensive comments
  - [x] Tested and verified working
  - **File:** `examples/fact-validator.yaml`

- [x] **4.4** Update `docs/foreach-dependency-propagation.md` ✅
  - [x] Add `on_finish` section (372 lines)
  - [x] Show how it fits in propagation
  - [x] Updated with complete lifecycle
  - **File:** `docs/foreach-dependency-propagation.md` (lines 69-441)

**Total Phase 4: COMPLETED** ✅

**Deliverables:**
- 864 lines of documentation added across 3 core docs
- Complete working example with inline documentation
- Cross-references and best practices throughout
- Common pitfalls and debugging tips included

---

### ✅ PHASE 5: Testing & Refinement (PARTIALLY COMPLETE)

**Priority: P1 (HIGH) - Status: 🚧 50% DONE**

- [x] **5.1** E2E test: Full fact validation flow ✅
  - [x] Test with real issue scenarios (3 tests)
  - [x] Verify extraction works
  - [x] Verify validation works
  - [x] Verify retry works
  - [x] Verify posting works
  - **File:** `tests/e2e/foreach-on-finish.test.ts`

- [x] **5.2** E2E test: Retry flow ✅
  - [x] Create issue with invalid facts (3 tests)
  - [x] Verify assistant retries
  - [x] Verify correction context passed
  - [x] Verify max attempts enforced
  - **File:** `tests/e2e/foreach-on-finish.test.ts`

- [x] **5.3** E2E test: Empty facts ✅
  - [x] Test response with no facts (3 tests)
  - [x] Verify direct posting
  - [x] Verify no validation runs
  - **File:** `tests/e2e/foreach-on-finish.test.ts`

- [x] **5.4** E2E test: Validation disabled ✅
  - [x] Set `ENABLE_FACT_VALIDATION=false` (2 tests)
  - [x] Verify direct posting
  - [x] Verify no validation runs
  - **File:** `tests/e2e/foreach-on-finish.test.ts`
  - **Result:** 20 tests passing (11 new + 9 existing)

- [ ] **5.5** Prompt tuning: Fact extraction
  - [ ] Test with various response types
  - [ ] Tune categories
  - [ ] Reduce false positives
  - [ ] Test edge cases
  - **Estimated effort:** 3-4 hours

- [ ] **5.6** Prompt tuning: Fact validation
  - [ ] Tune MCP tool usage
  - [ ] Improve evidence quality
  - [ ] Reduce false negatives
  - [ ] Test confidence thresholds
  - **Estimated effort:** 3-4 hours

- [ ] **5.7** Performance testing
  - [ ] Measure latency added
  - [ ] Identify bottlenecks
  - [ ] Optimize slow operations
  - [ ] Test with concurrent requests
  - **Estimated effort:** 2-3 hours

- [ ] **5.8** Integration testing
  - [ ] Test with real repository
  - [ ] Test with real issues/comments
  - [ ] Monitor API quota usage
  - [ ] Collect metrics
  - **Estimated effort:** 2-3 hours

**Total Phase 5 Effort:** 16-22 hours

---

### 🚀 PHASE 6: Deployment & Monitoring (NOT STARTED)

**Priority: P3 (LOW) - Status: ⏳ 0% DONE**

- [ ] **6.1** Set up staging environment
  - [ ] Deploy to staging
  - [ ] Enable fact validation
  - [ ] Monitor for errors
  - **Estimated effort:** 1 hour

- [ ] **6.2** Collect baseline metrics
  - [ ] Accuracy rate
  - [ ] Validation coverage
  - [ ] Retry rate
  - [ ] Performance impact
  - **Estimated effort:** 2-3 hours

- [ ] **6.3** Set up monitoring alerts
  - [ ] High error rate
  - [ ] High latency
  - [ ] API quota warnings
  - [ ] Infinite loop detection
  - **Estimated effort:** 1-2 hours

- [ ] **6.4** Production rollout
  - [ ] Gradual rollout (10% → 50% → 100%)
  - [ ] Monitor metrics
  - [ ] Adjust configuration as needed
  - **Estimated effort:** 2-3 hours

- [ ] **6.5** Post-deployment monitoring
  - [ ] Track success metrics
  - [ ] Collect user feedback
  - [ ] Identify improvement areas
  - **Estimated effort:** Ongoing

**Total Phase 6 Effort:** 6-9 hours

---

## 📊 OVERALL PROGRESS SUMMARY

| Phase | Priority | Status | Progress | Effort Remaining |
|-------|----------|--------|----------|------------------|
| **Phase 1: Infrastructure** | P0 | ✅ Done | 100% | 0 hours |
| **Phase 2: Execution** | P0 | ✅ Done | 100% | 0 hours |
| **Phase 3: Configuration** | P1 | ✅ Done | 100% | 0 hours |
| **Phase 4: Documentation** | P2 | ✅ Done | 100% | 0 hours |
| **Phase 5: Testing** | P1 | 🚧 Partial | 50% | 8-11 hours |
| **Phase 6: Deployment** | P3 | ⏳ Not Started | 0% | 6-9 hours |
| **TOTAL** | - | - | **75%** | **14-20 hours** |

---

## 🎯 IMPLEMENTATION PROGRESS

### ✅ Week 1: Complete Execution Layer (P0) - DONE

1. ✅ **Task 2.2** - Implement `executeCheckInline()` (BLOCKER) - COMPLETED
2. ✅ **Task 2.3** - Implement `on_finish.run` execution - COMPLETED
3. ✅ **Task 2.5** - Implement `on_finish.goto_js` evaluation - COMPLETED
4. ✅ **Task 2.9** - Write execution tests - COMPLETED
5. ✅ Verify all tests passing, no regressions - COMPLETED (1438 tests passing)

**Deliverable:** ✅ Fully functional `on_finish` hook with `run` and `goto_js` execution

### ✅ Week 2: Build Fact Validator (P1) - DONE

6. ✅ **Tasks 3.1-3.3** - Memory init + assistant prompt updates - COMPLETED
7. ✅ **Tasks 3.4-3.5** - Extract and validate fact checks - COMPLETED
8. ✅ **Task 3.6** - Aggregation check - COMPLETED
9. ✅ **Tasks 3.7-3.10** - Response posting + env config - COMPLETED
10. ✅ Manual testing of full flow - COMPLETED

**Deliverable:** ✅ Complete fact validator configuration at `examples/fact-validator.yaml`

### 🔄 Week 3: Test & Document (P1-P2) - NEXT

11. ⏳ **Phase 5.1-5.4** - E2E tests (additional scenarios)
12. ⏳ **Phase 5.5-5.6** - Prompt tuning (for production AI usage)
13. ⏳ **Phase 4.1-4.4** - Core documentation
14. ⏳ **Phase 4.5-4.6** - User guides

**Deliverable:** Tested and documented fact validator

---

## ✅ CRITICAL BLOCKERS - RESOLVED

1. ✅ **Task 2.2: `executeCheckInline()` method** - COMPLETED
2. ✅ **Tasks 2.3 + 2.5: `run` and `goto_js`** - COMPLETED
3. ✅ **Phase 2 completion** - COMPLETED

**Status:** All critical blockers have been resolved. The core infrastructure is complete and tested.
