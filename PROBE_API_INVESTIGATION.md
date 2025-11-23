# ProbeAgent API Investigation

## Investigation Summary

User requested investigation into how `disableTools` and custom system prompts work with the ProbeAgent integration. The user suspected these features were not working and expected ProbeAgent to have a **native `disableTools` option**.

## Key Finding: API Mismatch Confirmed

**ProbeAgent does NOT support `disableTools` or `allowedTools` options** despite Visor passing them.

---

## Detailed Findings

### 1. ProbeAgent TypeScript Definitions

**File:** `node_modules/@probelabs/probe/index.d.ts`

**ProbeAgentOptions Interface (lines 7-38):**
```typescript
export interface ProbeAgentOptions {
  sessionId?: string;
  customPrompt?: string;  // ← NOT "systemPrompt"
  promptType?: 'code-explorer' | 'engineer' | 'code-review' | 'support' | 'architect';
  allowEdit?: boolean;
  path?: string;
  provider?: 'anthropic' | 'openai' | 'google';
  model?: string;
  debug?: boolean;
  tracer?: any;
  enableMcp?: boolean;
  mcpConfigPath?: string;
  mcpConfig?: any;
  mcpServers?: any[];
  storageAdapter?: StorageAdapter;
  hooks?: Record<string, (data: any) => void | Promise<void>>;
  // ❌ NO "disableTools" option
  // ❌ NO "allowedTools" option
  // ❌ Uses "customPrompt" not "systemPrompt"
}
```

### 2. ProbeAgent Implementation

**File:** `node_modules/@probelabs/probe/src/agent/ProbeAgent.js`

**Constructor (lines 94-97):**
```javascript
constructor(options = {}) {
  this.sessionId = options.sessionId || randomUUID();
  this.customPrompt = options.customPrompt || null; // ← Uses customPrompt
  // ... no code for disableTools or allowedTools
}
```

**Tool Initialization (lines 251-299):**
```javascript
initializeTools() {
  const configOptions = {
    sessionId: this.sessionId,
    debug: this.debug,
    defaultPath: this.allowedFolders.length > 0 ? this.allowedFolders[0] : process.cwd(),
    allowedFolders: this.allowedFolders,
    outline: this.outline,
    enableBash: this.enableBash,
    bashConfig: this.bashConfig
  };

  // Create base tools
  const baseTools = createTools(configOptions);

  // Create wrapped tools with event emission
  const wrappedTools = createWrappedTools(baseTools);

  // Store tool instances for execution - HARDCODED LIST
  this.toolImplementations = {
    search: wrappedTools.searchToolInstance,
    query: wrappedTools.queryToolInstance,
    extract: wrappedTools.extractToolInstance,
    delegate: wrappedTools.delegateToolInstance,
    listFiles: listFilesToolInstance,
    searchFiles: searchFilesToolInstance,
  };

  // ❌ NO mechanism to filter or disable tools
}
```

**Grep Results:**
- Searched entire probe source directory for `disableTools` and `allowedTools`
- **ZERO matches found** - these options do not exist in the ProbeAgent codebase

### 3. Visor's Implementation

**File:** `src/ai-review-service.ts`

**AIReviewConfig Interface (lines 36-67):**
```typescript
export interface AIReviewConfig {
  // ...
  systemPrompt?: string;   // Line 50 - Visor's API
  customPrompt?: string;   // Line 52 - backward compat
  allowedTools?: string[]; // Line 60 - NOT in ProbeAgent
  disableTools?: boolean;  // Line 62 - NOT in ProbeAgent
  // ...
}
```

**ProbeAgent Creation (lines 1401-1463):**
```typescript
const options: TracedProbeAgentOptions = {
  sessionId: sessionId,
  promptType: /* ... */,
  allowEdit: false,
  debug: this.config.debug || false,
  // Map systemPrompt to Probe customPrompt until SDK exposes a first-class field
  customPrompt: systemPrompt || this.config.customPrompt,  // Line 1415 ✅ WORKS
};

// ... later ...

// Pass tool filtering options to ProbeAgent
if (this.config.allowedTools !== undefined) {
  (options as any).allowedTools = this.config.allowedTools;  // ❌ IGNORED BY PROBE
}
if (this.config.disableTools !== undefined) {
  (options as any).disableTools = this.config.disableTools;  // ❌ IGNORED BY PROBE
}

const agent = new ProbeAgent(options);
```

**Comment at line 1414:**
> "Map systemPrompt to Probe customPrompt until SDK exposes a first-class field"

This confirms Visor is working around ProbeAgent's API.

### 4. AI Check Provider

**File:** `src/providers/ai-check-provider.ts`

**Correctly extracts config (lines 578-582, 646):**
```typescript
if (config.ai.disableTools !== undefined) {
  aiConfig.disableTools = config.ai.disableTools as boolean;
}

// Later...
if (Object.keys(mcpServers).length > 0 && !config.ai?.disableTools) {
  (aiConfig as any).mcpServers = mcpServers;
}
```

The provider correctly extracts and passes the `disableTools` option, but ProbeAgent silently ignores it.

---

## API Mismatch Summary

| Feature | Visor's API | ProbeAgent's API | Status |
|---------|-------------|------------------|--------|
| System Prompt | `systemPrompt` | `customPrompt` | ✅ **WORKING** - Visor maps correctly (line 1415) |
| Disable Tools | `disableTools` | ❌ Not supported | ❌ **NOT WORKING** - Option passed but ignored |
| Filter Tools | `allowedTools` | ❌ Not supported | ❌ **NOT WORKING** - Option passed but ignored |

---

## Why This Happens

1. **Type Casting Workaround:**
   - Visor uses `(options as any)` to bypass TypeScript type checking
   - This allows passing options that don't exist in ProbeAgent's types
   - ProbeAgent receives these options but doesn't use them

2. **No Validation:**
   - JavaScript allows passing extra properties to objects
   - ProbeAgent constructor doesn't validate or warn about unknown options
   - Options are silently ignored

3. **Hardcoded Tools:**
   - ProbeAgent's `initializeTools()` creates a fixed set of tools
   - No conditional logic based on configuration
   - No mechanism to filter or disable individual tools

---

## Implications

### For `disableTools`
- **Current Behavior:** Option is passed but has NO EFFECT
- **Expected Behavior:** All tools (search, query, extract, etc.) should be disabled
- **Actual Behavior:** All tools remain available to the AI

### For `allowedTools`
- **Current Behavior:** Option is passed but has NO EFFECT
- **Expected Behavior:** Only specified tools should be available
- **Actual Behavior:** All tools remain available to the AI

### For `systemPrompt`
- **Current Behavior:** ✅ WORKS correctly
- **Implementation:** Visor maps `systemPrompt` → `customPrompt` before passing to ProbeAgent
- **Code:** `customPrompt: systemPrompt || this.config.customPrompt` (ai-review-service.ts:1415)

---

## Recommendations

### Option 1: Feature Request to ProbeAgent
Request the @probelabs/probe package to add:
- Native `disableTools` option
- Native `allowedTools` option
- Native `systemPrompt` option (instead of `customPrompt`)

### Option 2: Workaround in Visor
Since ProbeAgent doesn't support tool filtering at the constructor level, options include:
1. **Remove the options from Visor's API** (breaking change)
2. **Document that these options don't work** with ProbeAgent provider
3. **Implement tool filtering at runtime** (modify ProbeAgent's toolImplementations after creation)
4. **Use MCP server configuration** to control tool availability instead

### Option 3: Runtime Modification (Hacky)
```typescript
const agent = new ProbeAgent(options);

// Manually filter tools after creation
if (this.config.disableTools) {
  agent.toolImplementations = {};
} else if (this.config.allowedTools) {
  const allowed = new Set(this.config.allowedTools);
  agent.toolImplementations = Object.fromEntries(
    Object.entries(agent.toolImplementations).filter(([name]) => allowed.has(name))
  );
}
```

⚠️ **Warning:** This is fragile and may break with ProbeAgent updates.

---

## Files Investigated

1. `/home/buger/projects/visor2/node_modules/@probelabs/probe/package.json`
2. `/home/buger/projects/visor2/node_modules/@probelabs/probe/index.d.ts`
3. `/home/buger/projects/visor2/node_modules/@probelabs/probe/src/agent/ProbeAgent.js`
4. `/home/buger/projects/visor2/src/ai-review-service.ts`
5. `/home/buger/projects/visor2/src/providers/ai-check-provider.ts`

## Investigation Methods

- Read TypeScript definitions
- Read JavaScript implementation
- Searched entire probe source for `disableTools`, `allowedTools`, `systemPrompt`, `customPrompt`
- Traced how Visor passes options to ProbeAgent
- Verified tool initialization logic

---

## Conclusion

The user's suspicion was correct: **`disableTools` and `allowedTools` are NOT working** because ProbeAgent doesn't support these options. They are passed via type casting but silently ignored.

The `systemPrompt` option DOES work because Visor explicitly maps it to ProbeAgent's `customPrompt` field.

**Next Steps:**
1. Contact @probelabs/probe maintainers to request native support for these options
2. OR remove these options from Visor's API documentation
3. OR implement runtime workarounds (not recommended)
