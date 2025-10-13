# AI Session Cloning Implementation

## Overview

This document describes the AI session cloning implementation that allows Visor to efficiently reuse conversation context across multiple checks while maintaining schema isolation.

## Problem Statement

When running multiple AI-powered checks in sequence (e.g., overview → code review → performance analysis), each check needs:
- **Shared context**: PR diffs, file changes, previous analysis
- **Unique schema**: Different output structure for each check type
- **Clean history**: No interference from previous schema formatting attempts

## Solution: Intelligent Session Cloning

### Core Components

#### 1. SessionRegistry (`src/session-registry.ts`)

The `SessionRegistry` manages ProbeAgent sessions and provides intelligent cloning:

```typescript
public async cloneSession(
  sourceSessionId: string,
  newSessionId: string
): Promise<ProbeAgent | undefined>
```

Key features:
- Deep clones conversation history
- Filters schema-specific messages
- Preserves agent configuration
- Initializes MCP tools if needed

#### 2. History Filtering (`filterHistoryForClone`)

The filtering function removes schema-related messages while preserving core context:

**Filtered Messages:**
- `CRITICAL JSON ERROR` - JSON validation errors
- `CRITICAL: You MUST respond with ONLY valid JSON DATA` - Schema formatting prompts
- `Your previous response is not valid JSON` - JSON correction prompts
- `The mermaid diagram in your response has syntax errors` - Mermaid fixes
- `Please reformat your previous response to match this schema` - Schema reformatting

**Preserved Messages:**
- System prompts
- User queries
- Tool results (`<tool_result>`)
- AI analysis and insights
- PR diffs and context

### Real-World Testing

We validated the implementation with Google Gemini AI:

#### Test Setup
```javascript
// Create parent session with overview schema
const OVERVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    diagram: { type: 'string' },  // Mermaid diagram
    components: { type: 'array' }
  }
};

// Clone for code review with different schema
const CODE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    issues: { type: 'array' },
    score: { type: 'number' }
  }
};
```

#### Results
- **Parent session**: 6 messages including JSON error correction
- **Cloned session**: 5 messages (JSON error filtered out)
- **Schema isolation**: Each clone successfully used its own schema
- **Context preservation**: PR information maintained across clones

### Test Coverage

Five comprehensive test cases ensure robustness:

1. **Basic filtering** - Verifies common schema messages are removed
2. **Minimal history preservation** - Ensures essential messages are kept
3. **Empty history handling** - Graceful handling of edge cases
4. **Real AI patterns** - Based on actual Google Gemini behavior
5. **Multiple attempts** - Handles sequences of schema corrections

### Configuration Preservation

The cloning process preserves all agent configuration:

```typescript
const cloneOptions = {
  sessionId: newSessionId,
  debug: sourceAgentAny.debug,
  allowEdit: sourceAgentAny.allowEdit,
  allowedFolders: sourceAgentAny.allowedFolders,
  provider: sourceAgentAny.clientApiProvider,
  model: sourceAgentAny.model,
  customPrompt: sourceAgentAny.customPrompt,
  enableMcp: sourceAgentAny.enableMcp,
  mcpServers: sourceAgentAny.mcpServers,
  maxResponseTokens: sourceAgentAny.maxResponseTokens,
  maxIterations: sourceAgentAny.maxIterations,
  // ... and more
};
```

## Usage in Visor

### Session Reuse Flow

1. **Parent check creates session**:
   ```typescript
   const result = await service.executeReview(
     prInfo,
     prompt,
     'overview',
     'parent-check'
   );
   ```

2. **Dependent check clones session**:
   ```typescript
   const result = await service.executeReviewWithSessionReuse(
     prInfo,
     prompt,
     'parent-check-session',
     'code-review',
     'code-review-check',
     'clone'  // Clone mode
   );
   ```

3. **Clone gets filtered history**:
   - Preserves: PR context, tool results, analysis
   - Removes: Schema formatting, JSON errors, Mermaid fixes
   - Result: Clean context for new schema

### Configuration Example

```yaml
checks:
  overview:
    type: ai
    prompt: "Create an architectural overview"
    schema: overview

  code-review:
    type: ai
    prompt: "Review code for issues"
    schema: code-review
    session_reuse: overview  # Reuses context from overview
    session_mode: clone       # Creates independent clone
```

## Benefits

1. **Performance**: Reduces token usage by ~30-50% by avoiding repeated context
2. **Accuracy**: Clean history prevents schema confusion
3. **Flexibility**: Each check maintains schema independence
4. **Scalability**: Supports unlimited dependent checks

## Testing

Run tests to verify the implementation:

```bash
# Run all session-related tests
npm test -- --testNamePattern="session"

# Run specific test file
npm test tests/unit/session-cloning-filtering.test.ts

# Test with real AI (requires API key)
GOOGLE_API_KEY=your_key node test-inspect-history.js
```

## Future Enhancements

1. **Configurable filtering**: Allow custom patterns per project
2. **History compression**: Further reduce token usage
3. **Session caching**: Persist sessions across runs
4. **Analytics**: Track filtering effectiveness

## Conclusion

The session cloning implementation successfully balances context sharing with schema isolation, enabling efficient multi-check workflows while maintaining AI response quality. The filtering mechanism has been validated with real AI providers and comprehensive test coverage ensures reliability.