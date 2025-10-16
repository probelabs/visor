# Fact Validator - Gap Analysis

## Implementation Status vs Plan

### ✅ COMPLETED: Core `on_finish` Hook Infrastructure

#### 1. Type Definitions (100% Complete)
- ✅ `OnFinishConfig` interface in `src/types/config.ts`
- ✅ All fields: `run`, `run_js`, `goto`, `goto_js`, `goto_event`
- ✅ Added to `CheckConfig` interface as `on_finish?: OnFinishConfig`

#### 2. Schema Validation (100% Complete)
- ✅ Validation in `src/config.ts` (lines 735-744)
- ✅ Enforces: `on_finish` only on `forEach: true` checks
- ✅ Clear error messages
- ✅ Fixed: Added 'memory' to valid check types

#### 3. Detection & Triggering (100% Complete)
- ✅ `handleOnFinishHooks()` method in `src/check-execution-engine.ts`
- ✅ Detects forEach checks with `on_finish`
- ✅ Verifies all dependents completed
- ✅ Triggers after ALL forEach iterations + dependents complete
- ✅ Skips empty forEach arrays
- ✅ Provides rich context: outputs, forEach stats, memory, PR info

#### 4. Testing (100% Complete)
- ✅ Unit tests: 3/3 passing (validation)
- ✅ E2E tests: 4/4 passing (integration)
- ✅ Full suite: 1426/1426 passing
- ✅ No regressions

---

## 🚧 PENDING: Execution Implementation (MVP Status)

### What's Currently Implemented (MVP)
The `on_finish` hook is **detected and triggered correctly** with full context, but:

```typescript
// Current implementation (lines 383-394 in check-execution-engine.ts):
if (onFinish.run && onFinish.run.length > 0) {
  logger.info(`TODO: on_finish.run would execute [${onFinish.run.join(', ')}]`);
}
if (onFinish.goto_js) {
  logger.info(`TODO: on_finish.goto_js would evaluate and potentially route`);
} else if (onFinish.goto) {
  logger.info(`TODO: on_finish.goto would jump to '${onFinish.goto}'`);
}
```

### What Needs Full Implementation

#### 1. `on_finish.run` Execution (Critical for Fact Validator)
**Status:** TODO logged, not executed

**Required Implementation:**
```typescript
// Execute checks specified in on_finish.run
if (onFinish.run && onFinish.run.length > 0) {
  logger.info(`▶ on_finish.run: executing [${onFinish.run.join(', ')}]`);
  for (const runCheckName of onFinish.run) {
    // Need to execute check inline similar to on_success/on_fail
    await this.executeCheckInline(
      runCheckName,
      config,
      prInfo,
      results,
      dependencyGraph,
      sessionInfo,
      debug
    );
  }
}
```

**Blockers:**
- Need `executeCheckInline()` method or equivalent
- Need to handle check dependencies
- Need to update results map with executed check outputs

**Priority:** HIGH - This is critical for `aggregate-validations` check

---

#### 2. `on_finish.run_js` Evaluation (Optional Enhancement)
**Status:** Not implemented

**Required Implementation:**
```typescript
if (onFinish.run_js) {
  const memoryStore = MemoryStore.getInstance();
  const sandbox = new Sandbox({ audit: false, forbidFunctionCalls: false });
  const context = {
    outputs: outputsForContext,
    forEach: forEachStats,
    memory: { /* memory helpers */ },
    pr: prInfo,
    event: prInfo.eventContext,
    env: getSafeEnvironmentVariables(),
    step: { id: checkName, tags: checkConfig.tags || [], group: checkConfig.group },
  };
  const dynamicRun = sandbox.compile(onFinish.run_js)(context);
  const runList = Array.isArray(dynamicRun) ? dynamicRun : [];

  for (const runCheckName of runList) {
    await this.executeCheckInline(runCheckName, ...);
  }
}
```

**Priority:** MEDIUM - Nice to have but not required for basic fact validator

---

#### 3. `on_finish.goto_js` Evaluation (Critical for Fact Validator)
**Status:** TODO logged, not executed

**Required Implementation:**
```typescript
if (onFinish.goto_js) {
  const memoryStore = MemoryStore.getInstance();
  const sandbox = new Sandbox({ audit: false, forbidFunctionCalls: false });
  const context = {
    outputs: outputsForContext,
    forEach: forEachStats,
    memory: { /* memory helpers */ },
    pr: prInfo,
    event: prInfo.eventContext,
    env: getSafeEnvironmentVariables(),
    step: { id: checkName, tags: checkConfig.tags || [], group: checkConfig.group },
  };

  const gotoTarget = sandbox.compile(onFinish.goto_js)(context);

  if (gotoTarget && typeof gotoTarget === 'string') {
    logger.info(`↪ on_finish.goto: jumping to '${gotoTarget}' from '${checkName}'`);
    // Execute the target check with optional event override
    await this.executeCheckInline(
      gotoTarget,
      config,
      prInfo,
      results,
      dependencyGraph,
      sessionInfo,
      debug,
      { eventOverride: onFinish.goto_event }
    );
  }
}
```

**Priority:** HIGH - This is critical for retry routing in fact validator

---

#### 4. Static `on_finish.goto` Execution
**Status:** TODO logged, not executed

**Required Implementation:**
```typescript
else if (onFinish.goto) {
  logger.info(`↪ on_finish.goto: jumping to '${onFinish.goto}' from '${checkName}'`);
  await this.executeCheckInline(
    onFinish.goto,
    config,
    prInfo,
    results,
    dependencyGraph,
    sessionInfo,
    debug,
    { eventOverride: onFinish.goto_event }
  );
}
```

**Priority:** MEDIUM - Less critical as goto_js is more flexible

---

## 🔴 MISSING: Fact Validator Application Logic

### What's NOT Implemented Yet

#### 1. Memory Initialization Check
**File:** Not created
**What's needed:**
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

#### 2. Updated Assistant Prompts
**Files:** Existing issue-assistant and comment-assistant checks
**What's needed:**
- Add Liquid template logic to check for `memory.has('fact_validation_issues')`
- Include fact validation context in retry attempts
- Show previous validation failures to AI

#### 3. Fact Extraction Check
**File:** Not created
**What's needed:**
```yaml
checks:
  extract-facts:
    type: ai
    forEach: true
    on_finish:
      run: [aggregate-validations]
      goto_js: |
        const allValid = memory.get('all_facts_valid', 'fact-validation');
        const attempt = memory.get('fact_validation_attempt', 'fact-validation') || 0;
        if (!allValid && attempt < 1) {
          memory.increment('fact_validation_attempt', 1, 'fact-validation');
          return event.name === 'issue_opened' ? 'issue-assistant' : 'comment-assistant';
        }
        return null;
      goto_event: "{{ event.event_name }}"
    # ... extraction prompt
```

#### 4. Fact Validation Check
**File:** Not created
**What's needed:**
```yaml
checks:
  validate-fact:
    type: ai
    depends_on: [extract-facts]
    # ... validation prompt with MCP tools
```

#### 5. Aggregation Check
**File:** Not created
**What's needed:**
```yaml
checks:
  aggregate-validations:
    type: memory
    operation: exec_js
    namespace: fact-validation
    memory_js: |
      const validations = outputs.history['validate-fact'];
      const invalid = validations.filter(v => !v.is_valid);
      const allValid = invalid.length === 0;
      memory.set('all_facts_valid', allValid, 'fact-validation');
      // ... store results
```

#### 6. Response Posting Checks
**Files:** Not created
**What's needed:**
- `post-verified-response`: Post when all facts valid
- `post-unverified-warning`: Post warning when facts invalid after retry
- `post-direct-response`: Post without validation when disabled

#### 7. Environment Variable Configuration
**Files:** `.visor.yaml` and `.github/workflows/visor.yml`
**What's needed:**
- Add `ENABLE_FACT_VALIDATION` env var
- Default to `true` in workflows
- Pass through to checks

---

## 📊 Implementation Progress

### Core Infrastructure: 100% ✅
- [x] Type definitions
- [x] Schema validation
- [x] Detection & triggering
- [x] Context building
- [x] Testing framework

### Execution Layer: 30% 🚧
- [x] Hook detection
- [x] Context preparation
- [ ] `on_finish.run` execution (0%)
- [ ] `on_finish.run_js` evaluation (0%)
- [ ] `on_finish.goto_js` evaluation (0%)
- [ ] Static `on_finish.goto` execution (0%)

### Fact Validator Application: 0% ⏳
- [ ] Memory initialization (0%)
- [ ] Assistant prompt updates (0%)
- [ ] Fact extraction check (0%)
- [ ] Fact validation check (0%)
- [ ] Aggregation check (0%)
- [ ] Response posting checks (0%)
- [ ] Environment configuration (0%)

---

## 🎯 Critical Path to Working Fact Validator

### Phase 1: Complete `on_finish` Execution (CRITICAL)
**Estimated Effort:** 4-6 hours

1. **Implement `executeCheckInline()` method** (or reuse existing)
   - Needs to execute a named check
   - Handle dependencies
   - Update results map
   - Support event override

2. **Implement `on_finish.run` execution**
   - Call `executeCheckInline()` for each check
   - Execute in order
   - Propagate errors properly

3. **Implement `on_finish.goto_js` evaluation**
   - Compile and execute JS expression
   - Extract goto target
   - Call `executeCheckInline()` with target
   - Support `goto_event` override

4. **Add comprehensive logging**
   - Log execution start/complete
   - Log routing decisions
   - Debug output for context

5. **Test extensively**
   - Unit tests for execution order
   - E2E tests with actual routing
   - Test error handling

### Phase 2: Build Fact Validator Checks (HIGH PRIORITY)
**Estimated Effort:** 6-8 hours

1. **Create memory initialization check**
2. **Update assistant prompts with retry context**
3. **Implement fact extraction check**
4. **Implement fact validation check**
5. **Implement aggregation check**
6. **Create response posting checks**
7. **Add environment configuration**

### Phase 3: Integration & Polish (MEDIUM PRIORITY)
**Estimated Effort:** 2-4 hours

1. **E2E testing with real scenarios**
2. **Documentation updates**
3. **Example configurations**
4. **Performance optimization**

---

## 🚀 Recommended Next Steps

### Immediate (Blocking Fact Validator)
1. **Implement `executeCheckInline()` or equivalent** - This is THE blocker
2. **Complete `on_finish.run` execution** - Needed for aggregation
3. **Complete `on_finish.goto_js` evaluation** - Needed for retry routing

### Short-term (Complete Fact Validator MVP)
4. **Create fact validator checks configuration**
5. **Update assistant prompts**
6. **Test end-to-end flow**

### Medium-term (Polish & Enhance)
7. **Add `run_js` support** (optional)
8. **Comprehensive documentation**
9. **Performance optimization**
10. **Additional test scenarios**

---

## 💡 Technical Notes

### The `executeCheckInline()` Challenge

Looking at the codebase, there's a **nested function** `executeNamedCheckInline` inside `executeWithRouting()` (line ~672), but it's not accessible from `handleOnFinishHooks()`.

**Options:**
1. **Extract to class method** - Refactor `executeNamedCheckInline` to be a class method
2. **Call existing execution flow** - Use the existing check execution infrastructure
3. **Implement simplified inline executor** - Create a minimal executor for on_finish use case

**Recommendation:** Extract to class method for consistency with `on_success` and `on_fail` handling.

### Memory Store Access

Already implemented correctly - using `MemoryStore.getInstance()` and creating helpers inline.

### Sandbox for JS Evaluation

Already using `@nyariv/sandboxjs` elsewhere - same pattern should work for `on_finish`.

---

## Summary

**What's Done:** 🎉
- Complete `on_finish` hook infrastructure
- Full type safety and validation
- Detection and context building
- Comprehensive test coverage

**What's Blocking:** 🚧
- **Critical:** `on_finish.run` and `on_finish.goto_js` execution
- **Blocker:** Need `executeCheckInline()` or equivalent method

**What's Next:** 📋
- Complete execution implementation (~4-6 hours)
- Build fact validator checks (~6-8 hours)
- Test and polish (~2-4 hours)

**Total to Working Fact Validator:** ~12-18 hours of focused development

The infrastructure is solid - we just need to "connect the wires" for actual check execution!
