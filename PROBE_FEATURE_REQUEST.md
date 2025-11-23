# Feature Request: Add `disableTools`, `allowedTools`, and `systemPrompt` options to ProbeAgent

## Summary

Request to add native support for tool filtering and a more intuitive system prompt option in ProbeAgent's configuration API.

## Current Situation

ProbeAgent currently does not support:
1. **`disableTools`** - option to disable all tools
2. **`allowedTools`** - option to filter/whitelist specific tools
3. **`systemPrompt`** - more intuitive alias for `customPrompt`

These options are being passed by downstream consumers (like Visor) but are silently ignored because they don't exist in the `ProbeAgentOptions` interface.

## Motivation

### Use Case 1: Disabling Tools
When using ProbeAgent for pure Q&A or analysis tasks, tool execution may not be desired. Users should be able to disable all tools to:
- Reduce unnecessary tool calls
- Speed up responses
- Control costs
- Ensure the agent operates in a pure-LLM mode

### Use Case 2: Tool Filtering
In certain workflows, only specific tools should be available. For example:
- Allow only `search` but not `extract` or `query`
- Restrict to read-only operations (no `implement` tool)
- Custom tool subsets for different agent personas

### Use Case 3: Intuitive System Prompt
The term `systemPrompt` is more widely recognized in the AI/LLM community than `customPrompt`. Having both as aliases would improve developer experience.

## Proposed API

### 1. `disableTools` Option

```typescript
export interface ProbeAgentOptions {
  // ... existing options ...

  /**
   * Disable all tools (search, query, extract, delegate, etc.)
   * When true, the agent operates without any tool calls
   */
  disableTools?: boolean;
}
```

**Implementation**: When `disableTools: true`, `toolImplementations` should be set to an empty object `{}`.

### 2. `allowedTools` Option

```typescript
export interface ProbeAgentOptions {
  // ... existing options ...

  /**
   * Whitelist of allowed tools. If specified, only these tools will be available.
   * Available tools: 'search', 'query', 'extract', 'delegate', 'listFiles', 'searchFiles', 'implement'
   */
  allowedTools?: string[];
}
```

**Implementation**: When `allowedTools` is specified, filter `toolImplementations` to only include the specified tool names.

**Priority**: `disableTools` should take precedence over `allowedTools`. If both are specified and `disableTools: true`, no tools should be available.

### 3. `systemPrompt` Alias

```typescript
export interface ProbeAgentOptions {
  // ... existing options ...

  /** Custom system prompt to replace the default system message */
  customPrompt?: string;

  /** Alias for customPrompt. More intuitive naming for system prompts. */
  systemPrompt?: string;
}
```

**Implementation**:
```javascript
constructor(options = {}) {
  // systemPrompt takes precedence over customPrompt if both are provided
  this.customPrompt = options.systemPrompt || options.customPrompt || null;
  // ...
}
```

## Example Usage

```javascript
// Example 1: Disable all tools
const agent = new ProbeAgent({
  disableTools: true,
  systemPrompt: "You are a helpful coding assistant."
});

// Example 2: Allow only search and query tools
const agent = new ProbeAgent({
  allowedTools: ['search', 'query'],
  systemPrompt: "You are a code exploration assistant."
});

// Example 3: Use systemPrompt alias
const agent = new ProbeAgent({
  systemPrompt: "You are a code reviewer.",  // Instead of customPrompt
  promptType: 'code-review'
});
```

## Current Workaround

Consumers are currently working around this limitation by:
1. Passing options via type casting: `(options as any).disableTools = true`
2. Manually mapping `systemPrompt` → `customPrompt` before creating the agent
3. Modifying `agent.toolImplementations` after creation (fragile, not recommended)

These workarounds are not ideal as they:
- Bypass TypeScript type safety
- Are not officially supported
- May break with future ProbeAgent updates
- Are not discoverable in the API

## Investigation Details

**Tested with**: `@probelabs/probe@0.6.0-rc167` (latest as of 2025-01-21)

**Confirmed**:
- ✅ `customPrompt` works correctly
- ❌ `disableTools` does not exist in ProbeAgentOptions interface
- ❌ `allowedTools` does not exist in ProbeAgentOptions interface
- ❌ `systemPrompt` does not exist (only `customPrompt` is available)

**Source Investigation**:
- `index.d.ts` (lines 7-38): ProbeAgentOptions interface definition
- `src/agent/ProbeAgent.js` (lines 251-299): Tool initialization in `initializeTools()`

## Benefits

1. **Better API consistency** - Aligns with common LLM framework patterns
2. **Type safety** - No need for `as any` type casting
3. **Discoverability** - Options visible in TypeScript autocomplete
4. **Flexibility** - Users can control tool availability per agent instance
5. **Performance** - Skip unnecessary tool initialization when tools are disabled

## Related

This feature request is from the Visor project (AI-powered code review tool) which uses ProbeAgent as its AI provider. The options are already exposed in Visor's configuration API but are currently non-functional due to ProbeAgent not supporting them.

---

**Version**: `@probelabs/probe@0.6.0-rc167`
**Reporter**: Visor project maintainers
**Priority**: Medium (workarounds exist but are not ideal)
