# RFC: `on_init` Lifecycle Hook for Context Preprocessing

**Status:** Proposal
**Author:** Visor Team
**Created:** 2024-01-XX
**Updated:** 2024-01-XX

---

## Abstract

This RFC proposes adding an `on_init` lifecycle hook to enable automatic context enrichment before step execution. This solves the link preprocessing problem (JIRA, Linear, etc.) and provides a general-purpose mechanism for setup, data fetching, and context preparation.

---

## Table of Contents

1. [Motivation](#motivation)
2. [Proposed Solution](#proposed-solution)
3. [Detailed Design](#detailed-design)
4. [Type Definitions](#type-definitions)
5. [Syntax Specifications](#syntax-specifications)
6. [Execution Semantics](#execution-semantics)
7. [Implementation Plan](#implementation-plan)
8. [Examples](#examples)
9. [Alternatives Considered](#alternatives-considered)
10. [Migration Path](#migration-path)
11. [Open Questions](#open-questions)

---

## 1. Motivation

### 1.1 Problem Statement

**Use Case:** Automatically enrich AI prompts with external context (JIRA tickets, Linear issues, etc.)

**Current Approach:** Use `depends_on` for preprocessing
```yaml
# Verbose and clunky
steps:
  enrich-jira:
    type: mcp
    method: fetch-jira
    args:
      issue_key: "{{ pr.description | regex_search: '[A-Z]+-[0-9]+' }}"

  ai-review:
    depends_on: [enrich-jira]  # Explicit dependency
    prompt: |
      JIRA: {{ outputs["enrich-jira"] }}
      Review...
```

**Problems:**
- ❌ Verbose: Requires separate step definition
- ❌ Clutters logs: Preprocessor appears as separate step
- ❌ Not reusable: Hard to share preprocessing logic
- ❌ Unclear intent: Looks like regular dependency, not preprocessing
- ❌ Tight coupling: Parent knows about preprocessor step name

### 1.2 Goals

1. **Clean preprocessing** - Make preprocessing intent explicit
2. **Reusability** - One helper, many callers with different arguments
3. **Composability** - Mix tools, steps, and workflows
4. **Consistency** - Follow existing `on_success`/`on_fail`/`on_finish` patterns
5. **Flexibility** - Support conditional and dynamic preprocessing

### 1.3 Non-Goals

- Replacing `depends_on` for actual dependencies
- Adding new parameter passing mechanisms (reuse templates)
- Supporting parallel execution within `on_init`

---

## 2. Proposed Solution

### 2.1 Overview

Add an `on_init` lifecycle hook that runs **before** a step executes:

```yaml
steps:
  ai-review:
    type: ai
    on_init:
      run:
        - tool: fetch-jira
          with:
            issue_key: "{{ pr.description | regex_search: '[A-Z]+-[0-9]+' }}"
          as: jira-context
    prompt: |
      JIRA: {{ outputs["jira-context"] }}
      Review the PR...

  # Reusable helper (doesn't run independently)
  fetch-jira:
    type: mcp
    method: fetch-jira-ticket
    args:
      issue_key: "{{ args.issue_key }}"
    on: []
```

### 2.2 Key Features

1. **`on_init` hook** - Runs before step execution
2. **`with` directive** - Pass custom arguments to invoked items
3. **`as` directive** - Custom output naming
4. **Unified invocations** - Call tools, steps, or workflows
5. **`run_js` support** - Dynamic/conditional preprocessing

---

## 3. Detailed Design

### 3.1 Execution Flow

```
┌─────────────────────┐
│ Step Scheduled      │
│ (e.g., ai-review)   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Check on_init       │
│ directive           │
└──────────┬──────────┘
           │
           ▼
     ┌────┴────┐
     │ Has     │
     │ on_init?│
     └────┬────┘
          │
    Yes   │   No
     ┌────┴────┐
     ▼         ▼
┌─────────┐  ┌──────────────┐
│ Execute │  │ Execute Step │
│ on_init │  │ Normally     │
│ Items   │  └──────────────┘
└────┬────┘
     │
     ▼
┌─────────────────────┐
│ For each item:      │
│ 1. Resolve type     │
│    (tool/step/wflow)│
│ 2. Inject 'args'    │
│ 3. Execute          │
│ 4. Store output     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Execute Main Step   │
│ (outputs available) │
└─────────────────────┘
```

### 3.2 Invocation Types

The `on_init.run` array supports three invocation types:

#### 3.2.1 Tool Invocation

```yaml
- tool: fetch-jira-ticket
  with:
    issue_key: PROJ-123
  as: jira-data
```

**Execution:**
1. Looks up tool in `tools:` section
2. Creates temporary MCP check
3. Injects `with` as `args` context
4. Executes via MCP provider
5. Stores output as `outputs["jira-data"]`

#### 3.2.2 Step Invocation

```yaml
- step: extract-metadata
  with:
    pr_number: "{{ pr.number }}"
  as: metadata
```

**Execution:**
1. Looks up step in `steps:` section
2. Injects `with` as `args` context
3. Executes step normally
4. Stores output as `outputs["metadata"]`

#### 3.2.3 Workflow Invocation

```yaml
- workflow: security-validation
  with:
    files: "{{ files | map: 'filename' }}"
    severity: high
  as: security-results
  overrides:
    scan-step:
      timeout: 120
```

**Execution:**
1. Looks up workflow (registry or file)
2. Passes `with` as workflow `inputs`
3. Executes workflow via state machine
4. Stores output as `outputs["security-results"]`

### 3.3 Argument Passing

Arguments flow via the existing template context:

```yaml
# Caller
on_init:
  run:
    - tool: fetch-jira
      with:
        issue_key: PROJ-123
        include_comments: true

# Tool definition
tools:
  fetch-jira:
    exec: |
      # Access via args.*
      KEY="{{ args.issue_key }}"
      COMMENTS="{{ args.include_comments | default: false }}"
      curl https://jira.../issue/$KEY
```

**Template Context Enhancement:**
```typescript
const templateContext = {
  // Standard context
  pr: { ... },
  files: [ ... ],
  outputs: { ... },
  env: { ... },

  // NEW: Custom arguments from caller
  args: {
    issue_key: "PROJ-123",
    include_comments: true,
  },
};
```

---

## 4. Type Definitions

### 4.1 Core Types

```typescript
/**
 * Init hook configuration - runs BEFORE check execution
 */
export interface OnInitConfig {
  /** Items to run before this check executes */
  run?: OnInitRunItem[];

  /** Dynamic init items: JS expression returning OnInitRunItem[] */
  run_js?: string;

  /** Declarative transitions (optional, for advanced use cases) */
  transitions?: TransitionRule[];
}

/**
 * Unified run item - can be tool, step, workflow, or plain string
 */
export type OnInitRunItem =
  | OnInitToolInvocation
  | OnInitStepInvocation
  | OnInitWorkflowInvocation
  | string;  // Backward compatible: plain step name

/**
 * Invoke a custom tool (from tools: section)
 */
export interface OnInitToolInvocation {
  /** Tool name (must exist in tools: section) */
  tool: string;

  /** Arguments to pass to the tool (Liquid templates supported) */
  with?: Record<string, unknown>;

  /** Custom output name (defaults to tool name) */
  as?: string;
}

/**
 * Invoke a helper step (regular check)
 */
export interface OnInitStepInvocation {
  /** Step name (must exist in steps: section) */
  step: string;

  /** Arguments to pass to the step (Liquid templates supported) */
  with?: Record<string, unknown>;

  /** Custom output name (defaults to step name) */
  as?: string;
}

/**
 * Invoke a reusable workflow
 */
export interface OnInitWorkflowInvocation {
  /** Workflow ID or path */
  workflow: string;

  /** Workflow inputs (Liquid templates supported) */
  with?: Record<string, unknown>;

  /** Custom output name (defaults to workflow name) */
  as?: string;

  /** Step overrides */
  overrides?: Record<string, Partial<CheckConfig>>;

  /** Output mapping */
  output_mapping?: Record<string, string>;
}
```

### 4.2 CheckConfig Extension

```typescript
export interface CheckConfig {
  // ... existing fields ...

  /** Init routing configuration for this check (runs before execution) */
  on_init?: OnInitConfig;

  /** Success routing configuration */
  on_success?: OnSuccessConfig;

  /** Failure routing configuration */
  on_fail?: OnFailConfig;

  /** Finish routing configuration (forEach only) */
  on_finish?: OnFinishConfig;
}
```

---

## 5. Syntax Specifications

### 5.1 Basic Syntax

```yaml
# Simple tool invocation
on_init:
  run:
    - tool: fetch-jira
      with:
        issue_key: PROJ-123

# Simple step invocation
on_init:
  run:
    - step: extract-data
      with:
        text: "{{ pr.description }}"

# Simple workflow invocation
on_init:
  run:
    - workflow: validate
      with:
        env: production
```

### 5.2 Mixed Invocations

```yaml
on_init:
  run:
    # Tool
    - tool: fetch-jira
      with:
        issue_key: PROJ-123
      as: jira

    # Step
    - step: analyze
      with:
        files: "{{ files }}"
      as: analysis

    # Workflow
    - workflow: security-scan
      with:
        severity: high
      as: security
```

### 5.3 Custom Output Names

```yaml
on_init:
  run:
    - tool: fetch-jira
      with:
        issue_key: PROJ-100
      as: jira-100

    - tool: fetch-jira
      with:
        issue_key: PROJ-200
      as: jira-200

prompt: |
  JIRA 100: {{ outputs["jira-100"] }}
  JIRA 200: {{ outputs["jira-200"] }}
```

### 5.4 Dynamic Invocations

```yaml
on_init:
  run_js: |
    const items = [];

    // Conditional tool invocation
    const jiraKey = pr.description?.match(/([A-Z]+-[0-9]+)/)?.[1];
    if (jiraKey) {
      items.push({
        tool: 'fetch-jira',
        with: { issue_key: jiraKey },
        as: 'jira',
      });
    }

    // Conditional workflow invocation
    if (pr.base === 'main') {
      items.push({
        workflow: 'prod-checks',
        with: { pr_number: pr.number },
      });
    }

    return items;
```

### 5.5 Backward Compatibility

```yaml
# Old style (still supported)
on_init:
  run: [step1, step2]  # Plain strings

# New style
on_init:
  run:
    - step: step1
    - tool: my-tool
      with:
        key: value
```

### 5.6 Template Expressions in Arguments

```yaml
on_init:
  run:
    - tool: fetch-jira
      with:
        # Liquid template expressions
        issue_key: "{{ pr.description | regex_search: '[A-Z]+-[0-9]+' }}"
        pr_number: "{{ pr.number }}"
        files: "{{ files | map: 'filename' }}"
        has_tests: "{{ files | map: 'filename' | join: ',' | contains: 'test' }}"
```

---

## 6. Execution Semantics

### 6.1 Execution Order

`on_init` items execute **sequentially** in the order specified:

```yaml
on_init:
  run:
    - tool: step-1       # Executes first
    - step: step-2       # Executes second (can use outputs["step-1"])
    - workflow: step-3   # Executes third (can use outputs["step-1"] and outputs["step-2"])
```

### 6.2 Output Availability

Each `on_init` item's output is immediately available to subsequent items:

```yaml
on_init:
  run:
    - tool: extract-keys
      as: keys

    - tool: fetch-data
      with:
        keys: "{{ outputs['keys'] }}"  # Uses previous output
      as: data
```

### 6.3 Error Handling

**Default behavior:** If any `on_init` item fails, the parent step fails.

```yaml
on_init:
  run:
    - tool: fetch-jira
      # If this fails, ai-review doesn't run
```

**Optional:** Support `continue_on_failure` for specific items:

```yaml
on_init:
  run:
    - tool: fetch-jira
      with:
        issue_key: "{{ pr.description | regex_search: '[A-Z]+-[0-9]+' }}"
      continue_on_failure: true  # Optional enhancement
```

### 6.4 Scope Inheritance

`on_init` items inherit the parent's forEach scope:

```yaml
steps:
  validate-files:
    forEach: true
    exec: echo {{ files | map: 'filename' | json }}

  process-file:
    depends_on: [validate-files]
    on_init:
      run:
        - step: setup-processor
          # Runs once per forEach item, with same scope
    exec: process {{ outputs['validate-files'] }}
```

### 6.5 Conditional Execution

The parent's `if` condition is evaluated **before** `on_init`:

```yaml
steps:
  conditional-step:
    if: pr.base === 'main'  # Evaluated first
    on_init:
      run: [setup]          # Only runs if condition true
    exec: deploy
```

---

## 7. Implementation Plan

### 7.1 Phase 1: Core Infrastructure

#### File: `src/types/config.ts`

**Tasks:**
- [ ] Add `OnInitConfig` interface
- [ ] Add `OnInitRunItem` type union
- [ ] Add `OnInitToolInvocation` interface
- [ ] Add `OnInitStepInvocation` interface
- [ ] Add `OnInitWorkflowInvocation` interface
- [ ] Add `on_init?: OnInitConfig` to `CheckConfig`

**Lines:** ~100 new lines

#### File: `src/state-machine/dispatch/execution-invoker.ts`

**Tasks:**
- [ ] Add `handleOnInit()` function
- [ ] Add `executeOnInitItem()` function
- [ ] Add `detectInvocationType()` function
- [ ] Add `normalizeRunItems()` function
- [ ] Call `handleOnInit()` before step execution
- [ ] Pass enriched context with `args` to helpers

**Lines:** ~200-300 new lines

**Pseudocode:**
```typescript
async function handleOnInit(
  checkId: string,
  onInit: OnInitConfig,
  context: EngineContext,
  parentScope: Scope
): Promise<void> {
  // Process on_init.run
  if (onInit.run && onInit.run.length > 0) {
    const items = normalizeRunItems(onInit.run);

    for (const item of items) {
      await executeOnInitItem(item, context, parentScope);
    }
  }

  // Process on_init.run_js
  if (onInit.run_js) {
    const dynamicItems = evaluateRunJs(onInit.run_js, context);
    for (const item of dynamicItems) {
      await executeOnInitItem(item, context, parentScope);
    }
  }
}

async function executeOnInitItem(
  item: OnInitRunItem,
  context: EngineContext,
  scope: Scope
): Promise<void> {
  const type = detectInvocationType(item);
  const outputName = item.as || item.tool || item.step || item.workflow;

  let result: unknown;

  switch (type) {
    case 'tool':
      result = await executeToolInvocation(item, context, scope);
      break;
    case 'step':
      result = await executeStepInvocation(item, context, scope);
      break;
    case 'workflow':
      result = await executeWorkflowInvocation(item, context, scope);
      break;
  }

  // Store result for parent and subsequent on_init items
  context.outputs[outputName] = result;
}

function normalizeRunItems(run: OnInitRunItem[]): OnInitRunItem[] {
  return run.map(item => {
    if (typeof item === 'string') {
      return { step: item };  // Backward compat
    }
    return item;
  });
}

function detectInvocationType(item: OnInitRunItem): 'tool' | 'step' | 'workflow' {
  if (typeof item === 'string') return 'step';
  if ('tool' in item) return 'tool';
  if ('workflow' in item) return 'workflow';
  if ('step' in item) return 'step';
  throw new Error('Unknown on_init item type');
}
```

### 7.2 Phase 2: Invocation Handlers

#### Tool Invocation

```typescript
async function executeToolInvocation(
  item: OnInitToolInvocation,
  context: EngineContext,
  scope: Scope
): Promise<unknown> {
  const toolDef = context.config.tools?.[item.tool];
  if (!toolDef) {
    throw new Error(`Tool '${item.tool}' not found`);
  }

  // Create temporary MCP check
  const tempCheck: CheckConfig = {
    type: 'mcp',
    method: item.tool,
    transport: 'custom',
    args: item.with || {},
  };

  // Build context with args
  const enrichedContext = {
    ...context,
    args: item.with || {},
  };

  // Execute via MCP provider
  const provider = registry.getProvider('mcp');
  const result = await provider.execute(
    context.prInfo,
    tempCheck,
    buildDependencyResultsWithScope(checkId, tempCheck, context, scope),
    enrichedContext
  );

  return result.output;
}
```

#### Step Invocation

```typescript
async function executeStepInvocation(
  item: OnInitStepInvocation,
  context: EngineContext,
  scope: Scope
): Promise<unknown> {
  const stepConfig = context.config.steps?.[item.step];
  if (!stepConfig) {
    throw new Error(`Step '${item.step}' not found`);
  }

  // Build context with args
  const enrichedContext = {
    ...context,
    args: item.with || {},
  };

  // Execute step
  const provider = registry.getProvider(stepConfig.type || 'ai');
  const result = await provider.execute(
    context.prInfo,
    stepConfig,
    buildDependencyResultsWithScope(checkId, stepConfig, context, scope),
    enrichedContext
  );

  return result.output;
}
```

#### Workflow Invocation

```typescript
async function executeWorkflowInvocation(
  item: OnInitWorkflowInvocation,
  context: EngineContext,
  scope: Scope
): Promise<unknown> {
  // Create workflow check
  const workflowCheck: CheckConfig = {
    type: 'workflow',
    workflow: item.workflow,
    args: item.with || {},
    overrides: item.overrides,
    output_mapping: item.output_mapping,
  };

  // Execute via workflow provider
  const provider = registry.getProvider('workflow');
  const result = await provider.execute(
    context.prInfo,
    workflowCheck,
    buildDependencyResultsWithScope(checkId, workflowCheck, context, scope),
    context
  );

  return result.output;
}
```

### 7.3 Phase 3: Context Enhancement

#### File: `src/providers/command-check-provider.ts`

**Tasks:**
- [ ] Add `args` to template context
- [ ] Pass `args` from `context?.args`

**Changes:**
```typescript
const templateContext = {
  pr: { ... },
  files: [ ... ],
  outputs: { ... },
  env: { ... },

  // NEW: Custom arguments
  args: context?.args || {},
};
```

**Files to update:**
- `src/providers/ai-check-provider.ts`
- `src/providers/command-check-provider.ts`
- `src/providers/mcp-check-provider.ts`
- `src/providers/http-check-provider.ts`
- All providers that render templates

### 7.4 Phase 4: Routing & Loop Budget

#### File: `src/state-machine/states/routing.ts`

**Tasks:**
- [ ] Add loop budget checking for `on_init`
- [ ] Increment routing loop counter
- [ ] Add `on_init` to routing metrics

**Changes:**
```typescript
// Check loop budget
if (checkLoopBudget(context, state, 'on_init', 'run')) {
  throw new Error(`Loop budget exceeded during on_init`);
}

// Increment counter
incrementRoutingLoopCount(context, state, 'on_init', 'run');
```

### 7.5 Phase 5: Testing

#### Unit Tests

**File:** `tests/unit/on-init-handler.test.ts`
- [ ] Test `normalizeRunItems()`
- [ ] Test `detectInvocationType()`
- [ ] Test `handleOnInit()` with tools
- [ ] Test `handleOnInit()` with steps
- [ ] Test `handleOnInit()` with workflows
- [ ] Test mixed invocations
- [ ] Test `with` argument passing
- [ ] Test `as` output naming
- [ ] Test error handling
- [ ] Test loop budget enforcement

#### Integration Tests

**File:** `tests/integration/on-init.test.ts`
- [ ] Test tool invocation end-to-end
- [ ] Test step invocation end-to-end
- [ ] Test workflow invocation end-to-end
- [ ] Test argument flow (with → args)
- [ ] Test output availability
- [ ] Test chaining (tool → step → workflow)
- [ ] Test conditional execution (run_js)
- [ ] Test forEach scope inheritance
- [ ] Test backward compatibility (string arrays)

#### E2E Tests

**File:** `tests/e2e/on-init-jira.test.ts`
- [ ] Test JIRA link preprocessing
- [ ] Test multiple link types (JIRA + Linear)
- [ ] Test dynamic preprocessing
- [ ] Test with real workflows

### 7.6 Phase 6: Documentation

**Tasks:**
- [ ] Update `CLAUDE.md` with `on_init` pattern
- [ ] Add examples to `examples/` directory
- [ ] Update API documentation
- [ ] Add troubleshooting guide
- [ ] Create migration guide from `depends_on`

**Files:**
- `docs/on_init-guide.md` - User guide
- `docs/on_init-api.md` - API reference
- `examples/on_init-*.yaml` - Examples
- `CLAUDE.md` - Update with on_init pattern

### 7.7 Phase 7: Schema Generation

**File:** `src/generated/config-schema.ts`

**Tasks:**
- [ ] Run schema generator
- [ ] Validate generated types
- [ ] Update JSON schema

---

## 8. Examples

### 8.1 Basic JIRA Preprocessing

```yaml
tools:
  fetch-jira:
    exec: curl https://jira.../issue/{{ args.issue_key }}
    parseJson: true
    transform_js: |
      return `<jira>${output.fields.summary}</jira>`;

steps:
  ai-review:
    type: ai
    on_init:
      run:
        - tool: fetch-jira
          with:
            issue_key: "{{ pr.description | regex_search: '[A-Z]+-[0-9]+' }}"
          as: jira-context
    prompt: |
      JIRA: {{ outputs["jira-context"] }}
      Review the PR...

  fetch-jira:
    type: mcp
    method: fetch-jira
    transport: custom
    args:
      issue_key: "{{ args.issue_key }}"
    on: []
```

### 8.2 Multi-Source Enrichment

```yaml
steps:
  comprehensive-review:
    type: ai
    on_init:
      run_js: |
        const items = [];

        // JIRA
        const jiraKey = pr.description?.match(/([A-Z]+-[0-9]+)/)?.[1];
        if (jiraKey) {
          items.push({
            tool: 'fetch-jira',
            with: { issue_key: jiraKey },
            as: 'jira',
          });
        }

        // Linear
        const linearUrl = pr.description?.match(/(https:\/\/linear\.app\/[^\s]+)/)?.[1];
        if (linearUrl) {
          items.push({
            tool: 'fetch-linear',
            with: { url: linearUrl },
            as: 'linear',
          });
        }

        // Security scan (workflow)
        if (pr.base === 'main') {
          items.push({
            workflow: 'security-scan',
            with: { files: files.map(f => f.filename) },
            as: 'security',
          });
        }

        return items;

    prompt: |
      {% if outputs["jira"] %}
      JIRA: {{ outputs["jira"] }}
      {% endif %}

      {% if outputs["linear"] %}
      Linear: {{ outputs["linear"] }}
      {% endif %}

      {% if outputs["security"] %}
      Security: {{ outputs["security"] }}
      {% endif %}

      Review...
```

### 8.3 Setup/Teardown Pattern

```yaml
steps:
  integration-test:
    type: command
    on_init:
      run:
        - step: setup-database
          with:
            name: test-db
    on_finish:
      run:
        - step: cleanup-database
          with:
            name: test-db
    exec: npm run test:integration

  setup-database:
    type: command
    exec: docker run -d --name {{ args.name }} postgres
    on: []

  cleanup-database:
    type: command
    exec: docker rm -f {{ args.name }}
    on: []
```

---

## 9. Alternatives Considered

### 9.1 Alternative 1: `preprocess` Directive

```yaml
steps:
  ai-review:
    preprocess: [fetch-jira]
```

**Rejected:** Less consistent with existing `on_*` pattern.

### 9.2 Alternative 2: `setup` Hook

```yaml
steps:
  ai-review:
    setup:
      run: [fetch-jira]
```

**Rejected:** "setup" implies infrastructure, not data enrichment.

### 9.3 Alternative 3: Automatic Detection

```yaml
steps:
  ai-review:
    prompt: |
      {{ enrich("jira", pr.description) }}
```

**Rejected:** Too magical, unclear execution order, hard to debug.

### 9.4 Alternative 4: Context Enrichers (Global)

```yaml
context_enrichers:
  jira:
    pattern: 'https://.*atlassian.net/browse/([A-Z]+-[0-9]+)'
    tool: fetch-jira
```

**Rejected:** Less flexible, no per-step control, new top-level concept.

### 9.5 Alternative 5: Inline Syntax

```yaml
on_init:
  run: [fetch-jira(issue_key=PROJ-123)]
```

**Rejected:** Non-standard YAML, harder to parse, limited.

---

## 10. Migration Path

### 10.1 From `depends_on` to `on_init`

**Before:**
```yaml
steps:
  enrich-jira:
    type: mcp
    method: fetch-jira

  ai-review:
    depends_on: [enrich-jira]
    prompt: "JIRA: {{ outputs['enrich-jira'] }}"
```

**After:**
```yaml
steps:
  ai-review:
    on_init:
      run:
        - step: enrich-jira
    prompt: "JIRA: {{ outputs['enrich-jira'] }}"

  enrich-jira:
    type: mcp
    method: fetch-jira
    on: []  # Mark as helper only
```

### 10.2 Backward Compatibility

**Existing configs continue to work:**
```yaml
on_init:
  run: [step1, step2]  # String array (backward compat)
```

**New syntax is opt-in:**
```yaml
on_init:
  run:
    - tool: my-tool
      with: { ... }
```

---

## 11. Open Questions

### 11.1 Parallel Execution

**Question:** Should `on_init` items execute in parallel or sequentially?

**Proposal:** Sequential (preserves output ordering, simpler)

**Future:** Add `parallel: true` option if needed:
```yaml
on_init:
  run:
    - tool: fetch-jira
    - tool: fetch-linear
  parallel: true  # Future enhancement
```

### 11.2 Nested on_init

**Question:** Can `on_init` steps have their own `on_init`?

**Proposal:** Yes, but enforce max depth (e.g., 3 levels) to prevent infinite loops.

### 11.3 Continue on Failure

**Question:** Should individual `on_init` items support `continue_on_failure`?

**Proposal:** Future enhancement:
```yaml
on_init:
  run:
    - tool: fetch-jira
      continue_on_failure: true
```

### 11.4 Output Scoping

**Question:** Should `on_init` outputs be scoped differently from regular outputs?

**Proposal:** No, use the same `outputs` map for consistency.

### 11.5 Timeout

**Question:** Should `on_init` have a global timeout?

**Proposal:** Use sum of individual item timeouts. Add `timeout` if needed:
```yaml
on_init:
  timeout: 60000  # ms (future enhancement)
  run: [ ... ]
```

---

## 12. Summary

### 12.1 Benefits

1. **✅ Clean preprocessing** - Explicit intent, doesn't clutter logs
2. **✅ Reusable** - One helper, many callers with `with` args
3. **✅ Unified** - Tools, steps, workflows with same syntax
4. **✅ Consistent** - Follows existing `on_*` patterns
5. **✅ Flexible** - Conditional, dynamic, composable
6. **✅ Backward compatible** - Existing code works

### 12.2 Implementation Effort

| Phase | Effort | Lines of Code |
|-------|--------|---------------|
| Type definitions | Low | ~100 |
| Core handler | Medium | ~300 |
| Invocation handlers | Medium | ~200 |
| Context enhancement | Low | ~50 |
| Testing | High | ~500 |
| Documentation | Medium | ~1000 |
| **Total** | **Medium-High** | **~2150** |

### 12.3 Rollout Plan

1. **Week 1:** Type definitions + schema
2. **Week 2:** Core implementation
3. **Week 3:** Testing
4. **Week 4:** Documentation + examples
5. **Week 5:** Beta testing with real workflows
6. **Week 6:** GA release

---

## 13. References

- [Existing `on_success` implementation](src/state-machine/states/routing.ts#599)
- [Existing `on_fail` implementation](src/state-machine/states/routing.ts#816)
- [Existing `on_finish` implementation](src/state-machine/states/routing.ts#231)
- [Workflow provider](src/providers/workflow-check-provider.ts)
- [Custom tool executor](src/providers/custom-tool-executor.ts)

---

## Appendix A: Complete Type Definitions

```typescript
// src/types/config.ts

/**
 * Init hook configuration - runs BEFORE check execution
 */
export interface OnInitConfig {
  /** Items to run before this check executes */
  run?: OnInitRunItem[];

  /** Dynamic init items: JS expression returning OnInitRunItem[] */
  run_js?: string;

  /** Declarative transitions (optional) */
  transitions?: TransitionRule[];
}

/**
 * Unified run item
 */
export type OnInitRunItem =
  | OnInitToolInvocation
  | OnInitStepInvocation
  | OnInitWorkflowInvocation
  | string;

/**
 * Tool invocation
 */
export interface OnInitToolInvocation {
  tool: string;
  with?: Record<string, unknown>;
  as?: string;
}

/**
 * Step invocation
 */
export interface OnInitStepInvocation {
  step: string;
  with?: Record<string, unknown>;
  as?: string;
}

/**
 * Workflow invocation
 */
export interface OnInitWorkflowInvocation {
  workflow: string;
  with?: Record<string, unknown>;
  as?: string;
  overrides?: Record<string, Partial<CheckConfig>>;
  output_mapping?: Record<string, string>;
}

/**
 * Check configuration (extended)
 */
export interface CheckConfig {
  // ... existing fields ...

  /** Init hook - runs before check execution */
  on_init?: OnInitConfig;

  /** Success hook */
  on_success?: OnSuccessConfig;

  /** Failure hook */
  on_fail?: OnFailConfig;

  /** Finish hook (forEach only) */
  on_finish?: OnFinishConfig;
}
```

---

**End of RFC**
