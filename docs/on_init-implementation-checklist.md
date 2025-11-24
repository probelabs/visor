# `on_init` Implementation Checklist

Quick reference for implementing the `on_init` lifecycle hook.

## Phase 1: Type Definitions ✅

**File:** `src/types/config.ts`

- [ ] Add `OnInitConfig` interface (~30 lines)
  ```typescript
  export interface OnInitConfig {
    run?: OnInitRunItem[];
    run_js?: string;
    transitions?: TransitionRule[];
  }
  ```

- [ ] Add `OnInitRunItem` type union (~5 lines)
  ```typescript
  export type OnInitRunItem =
    | OnInitToolInvocation
    | OnInitStepInvocation
    | OnInitWorkflowInvocation
    | string;
  ```

- [ ] Add `OnInitToolInvocation` interface (~10 lines)
- [ ] Add `OnInitStepInvocation` interface (~10 lines)
- [ ] Add `OnInitWorkflowInvocation` interface (~15 lines)
- [ ] Add `on_init?: OnInitConfig` to `CheckConfig` (~1 line)

**Total:** ~70 lines

## Phase 2: Core Handler ✅

**File:** `src/state-machine/dispatch/execution-invoker.ts`

- [ ] Add `handleOnInit()` function (~60 lines)
  ```typescript
  async function handleOnInit(
    checkId: string,
    onInit: OnInitConfig,
    context: EngineContext,
    parentScope: Scope
  ): Promise<void>
  ```

- [ ] Add `executeOnInitItem()` function (~40 lines)
  ```typescript
  async function executeOnInitItem(
    item: OnInitRunItem,
    context: EngineContext,
    scope: Scope
  ): Promise<void>
  ```

- [ ] Add `normalizeRunItems()` function (~15 lines)
  ```typescript
  function normalizeRunItems(run: OnInitRunItem[]): OnInitRunItem[]
  ```

- [ ] Add `detectInvocationType()` function (~10 lines)
  ```typescript
  function detectInvocationType(item: OnInitRunItem): 'tool' | 'step' | 'workflow'
  ```

- [ ] Call `handleOnInit()` in main execution flow (~5 lines)
  ```typescript
  // Before executing the check
  if (checkConfig.on_init) {
    await handleOnInit(checkId, checkConfig.on_init, context, scope);
  }
  ```

**Total:** ~130 lines

## Phase 3: Invocation Handlers ✅

**File:** `src/state-machine/dispatch/on-init-handlers.ts` (new file)

- [ ] Add `executeToolInvocation()` (~50 lines)
  ```typescript
  export async function executeToolInvocation(
    item: OnInitToolInvocation,
    context: EngineContext,
    scope: Scope
  ): Promise<unknown>
  ```

- [ ] Add `executeStepInvocation()` (~50 lines)
  ```typescript
  export async function executeStepInvocation(
    item: OnInitStepInvocation,
    context: EngineContext,
    scope: Scope
  ): Promise<unknown>
  ```

- [ ] Add `executeWorkflowInvocation()` (~40 lines)
  ```typescript
  export async function executeWorkflowInvocation(
    item: OnInitWorkflowInvocation,
    context: EngineContext,
    scope: Scope
  ): Promise<unknown>
  ```

**Total:** ~140 lines

## Phase 4: Context Enhancement ✅

**Files:** All provider files

- [ ] `src/providers/command-check-provider.ts`
  - Add `args: context?.args || {}` to templateContext (~2 lines)

- [ ] `src/providers/ai-check-provider.ts`
  - Add `args: context?.args || {}` to templateContext (~2 lines)

- [ ] `src/providers/mcp-check-provider.ts`
  - Add `args: context?.args || {}` to templateContext (~2 lines)

- [ ] `src/providers/http-check-provider.ts`
  - Add `args: context?.args || {}` to templateContext (~2 lines)

- [ ] `src/providers/memory-check-provider.ts`
  - Add `args: context?.args || {}` to templateContext (~2 lines)

- [ ] Update `ExecutionContext` interface
  ```typescript
  export interface ExecutionContext {
    // ... existing fields ...
    args?: Record<string, unknown>;  // NEW
  }
  ```

**Total:** ~15 lines

## Phase 5: Routing & Loop Budget ✅

**File:** `src/state-machine/states/routing.ts`

- [ ] Add loop budget check for `on_init` (~10 lines)
  ```typescript
  if (checkLoopBudget(context, state, 'on_init', 'run')) {
    throw new Error('Loop budget exceeded during on_init');
  }
  ```

- [ ] Add routing loop increment (~5 lines)
  ```typescript
  incrementRoutingLoopCount(context, state, 'on_init', 'run');
  ```

**Total:** ~15 lines

## Phase 6: Testing ✅

### Unit Tests

**File:** `tests/unit/on-init-handler.test.ts` (new)

- [ ] Test `normalizeRunItems()` - string array
- [ ] Test `normalizeRunItems()` - mixed array
- [ ] Test `detectInvocationType()` - tool
- [ ] Test `detectInvocationType()` - step
- [ ] Test `detectInvocationType()` - workflow
- [ ] Test `detectInvocationType()` - string
- [ ] Test `handleOnInit()` - empty run
- [ ] Test `handleOnInit()` - single tool
- [ ] Test `handleOnInit()` - single step
- [ ] Test `handleOnInit()` - single workflow
- [ ] Test `handleOnInit()` - mixed items
- [ ] Test `handleOnInit()` - run_js
- [ ] Test error handling - tool not found
- [ ] Test error handling - step not found
- [ ] Test error handling - workflow not found
- [ ] Test loop budget enforcement

**Total:** ~300 lines

**File:** `tests/unit/on-init-invocations.test.ts` (new)

- [ ] Test `executeToolInvocation()` - basic
- [ ] Test `executeToolInvocation()` - with args
- [ ] Test `executeToolInvocation()` - with as
- [ ] Test `executeStepInvocation()` - basic
- [ ] Test `executeStepInvocation()` - with args
- [ ] Test `executeStepInvocation()` - with as
- [ ] Test `executeWorkflowInvocation()` - basic
- [ ] Test `executeWorkflowInvocation()` - with inputs
- [ ] Test `executeWorkflowInvocation()` - with overrides
- [ ] Test argument passing (with → args)
- [ ] Test output naming (as)

**Total:** ~200 lines

### Integration Tests

**File:** `tests/integration/on-init.test.ts` (new)

- [ ] Test tool invocation end-to-end
- [ ] Test step invocation end-to-end
- [ ] Test workflow invocation end-to-end
- [ ] Test mixed invocations
- [ ] Test argument flow
- [ ] Test output availability
- [ ] Test chaining (tool → step → workflow)
- [ ] Test conditional (run_js)
- [ ] Test forEach scope inheritance
- [ ] Test backward compatibility

**Total:** ~400 lines

### E2E Tests

**File:** `tests/e2e/on-init-jira.test.ts` (new)

- [ ] Test JIRA preprocessing
- [ ] Test multi-source (JIRA + Linear)
- [ ] Test dynamic preprocessing
- [ ] Test with real workflows

**Total:** ~200 lines

**Grand Total Tests:** ~1100 lines

## Phase 7: Documentation ✅

**Files:**

- [ ] `docs/RFC-on_init-hook.md` (DONE)
- [ ] `docs/on_init-guide.md` - User guide
- [ ] `docs/on_init-api.md` - API reference
- [ ] `examples/on_init-basic.yaml` - Basic examples
- [ ] `examples/on_init-jira.yaml` - JIRA preprocessing
- [ ] `examples/on_init-advanced.yaml` - Advanced patterns
- [ ] Update `CLAUDE.md` with on_init pattern
- [ ] Update `README.md` with on_init mention

**Total:** ~2000 lines

## Phase 8: Schema Generation ✅

**File:** `scripts/generate-config-schema.js`

- [ ] Run: `npm run generate-config-schema`
- [ ] Verify generated schema includes OnInitConfig
- [ ] Validate JSON schema
- [ ] Commit generated files

## Progress Tracking

| Phase | Tasks | Lines | Status |
|-------|-------|-------|--------|
| 1. Type Definitions | 6 | ~70 | ⬜ Not Started |
| 2. Core Handler | 5 | ~130 | ⬜ Not Started |
| 3. Invocation Handlers | 3 | ~140 | ⬜ Not Started |
| 4. Context Enhancement | 6 | ~15 | ⬜ Not Started |
| 5. Routing & Loop Budget | 2 | ~15 | ⬜ Not Started |
| 6. Testing | 37 | ~1100 | ⬜ Not Started |
| 7. Documentation | 8 | ~2000 | 🟡 In Progress |
| 8. Schema Generation | 4 | ~0 | ⬜ Not Started |
| **TOTAL** | **71** | **~3470** | **5% Complete** |

## Quick Start Guide

### 1. Start with Type Definitions

```bash
# Edit src/types/config.ts
code src/types/config.ts
```

Add interfaces at the end of the file, following existing patterns.

### 2. Implement Core Handler

```bash
# Edit execution-invoker.ts
code src/state-machine/dispatch/execution-invoker.ts
```

Add `handleOnInit()` before the main execution logic.

### 3. Add Invocation Handlers

```bash
# Create new file
touch src/state-machine/dispatch/on-init-handlers.ts
code src/state-machine/dispatch/on-init-handlers.ts
```

Implement three handler functions.

### 4. Update Providers

```bash
# Update all providers
code src/providers/command-check-provider.ts
code src/providers/ai-check-provider.ts
# ... etc
```

Add `args` to template context.

### 5. Write Tests

```bash
# Create test files
touch tests/unit/on-init-handler.test.ts
touch tests/integration/on-init.test.ts
```

### 6. Run Tests

```bash
npm test -- on-init
```

### 7. Generate Schema

```bash
npm run generate-config-schema
```

### 8. Test End-to-End

```bash
# Create example
touch examples/on_init-test.yaml

# Run visor
npm run build
./dist/cli-main.js --config examples/on_init-test.yaml
```

## Common Pitfalls

1. **❌ Forgetting to pass `args` in context**
   - Remember to add to ExecutionContext interface
   - Pass through all provider execute() calls

2. **❌ Not handling backward compatibility**
   - String arrays must still work: `run: [step1, step2]`

3. **❌ Not storing outputs correctly**
   - Use `as` if provided, fallback to tool/step/workflow name

4. **❌ Not checking loop budget**
   - Each on_init item counts toward routing budget

5. **❌ Forgetting scope inheritance**
   - on_init items must inherit parent's forEach scope

## Testing Checklist

- [ ] Unit tests pass: `npm test -- unit/on-init`
- [ ] Integration tests pass: `npm test -- integration/on-init`
- [ ] E2E tests pass: `npm test -- e2e/on-init`
- [ ] All existing tests still pass: `npm test`
- [ ] Lint passes: `npm run lint`
- [ ] Build succeeds: `npm run build`
- [ ] Schema generation works: `npm run generate-config-schema`
- [ ] Examples work: `./dist/cli-main.js --config examples/on_init-*.yaml`

## Release Checklist

- [ ] All tests passing
- [ ] Documentation complete
- [ ] Examples working
- [ ] Schema generated
- [ ] CHANGELOG updated
- [ ] Version bumped
- [ ] PR created
- [ ] Code review completed
- [ ] Merged to main
- [ ] Release notes published

---

**Estimated Timeline:** 4-6 weeks
**Estimated LOC:** ~3500 lines
**Complexity:** Medium-High
