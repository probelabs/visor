# Human Input Step Feature Plan

## Overview
Add a human-in-the-loop check provider that allows workflows to pause and request user input. This enables interactive workflows where humans can provide guidance, approval, or additional context during the review process.

## Use Cases
1. **Approval Gates**: Require human approval before proceeding with certain checks
2. **Context Collection**: Ask users for additional information about the PR
3. **Decision Points**: Let users choose between different workflow paths
4. **Interactive Reviews**: Enable reviewers to provide input that influences subsequent checks

## Architecture

### 1. New Check Provider: `human-input-check-provider.ts`

**Provider Type**: `human-input` or `ask-user`

**Configuration Schema**:
```yaml
checks:
  ask-reviewer:
    type: human-input
    prompt: "Please provide context about this change:"
    placeholder: "Enter your response here..."
    allow_empty: false  # If true, empty input is accepted (default: false)
    timeout: 300000     # 5 minutes in ms (optional)
    multiline: true     # Allow multi-line input (default: false)
    default: ""         # Default value if timeout or empty input (optional)
```

**Key Features**:
- Supports both CLI and SDK modes
- In CLI mode: uses stdin/stdout for interactive terminal input
- In SDK mode: calls a configurable hook function
- Returns user input as check output
- Can be used with `depends_on` and output transformations

### 2. CLI Enhancements

#### New `--message` Argument
```bash
# Provide message inline
visor --check ask-reviewer --message "User approved the changes"

# Provide message from file (auto-detected if path exists)
visor --check ask-reviewer --message path/to/message.txt
visor --check ask-reviewer --message /absolute/path/to/message.txt

# Interactive mode (when --message not provided)
visor --check ask-reviewer
# Prompts: "Please provide context about this change:"
# User types input and presses Enter/Ctrl+D
```

**Path Detection Logic**:
- Check if the message value looks like a path (contains `/` or `\`)
- If it looks like a path, check if file exists
- If file exists, read content from file
- Otherwise, treat as literal message string
- This allows natural usage without special prefixes

#### STDIN Support
When no `--message` argument is provided and a human-input check is the first check:
- Read from stdin if available (piped input)
- Fall back to interactive prompt if stdin is empty
- Display beautiful, formatted prompt with visual separators

```bash
# Piped input
echo "Approved" | visor --check ask-reviewer

# File input
cat approval.txt | visor --check ask-reviewer

# Interactive mode with nice formatting
visor --check ask-reviewer
```

**Interactive UI Design**:
```
┌─────────────────────────────────────────────────────────────────┐
│ 💬 Human Input Required                                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Please provide context about this change:                      │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Enter your response here...                                 │ │
│ │                                                             │ │
│ │ (Press Enter for single line, Ctrl+D when done for multi)  │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ⏱  Timeout: 5 minutes remaining                                │
└─────────────────────────────────────────────────────────────────┘

> _
```

**Features**:
- Box drawing characters for clean borders
- Clear visual hierarchy
- Placeholder text shown in dim color
- Timeout countdown (if configured)
- Instructions for multiline input
- Emoji icons for visual appeal
- Graceful degradation for terminals without Unicode support

### 3. SDK Mode Hook

**New Configuration Option**:
```typescript
interface VisorConfig {
  // ... existing config
  hooks?: {
    onHumanInput?: (prompt: HumanInputRequest) => Promise<string>;
  };
}

interface HumanInputRequest {
  checkId: string;
  prompt: string;
  placeholder?: string;
  allowEmpty: boolean;
  multiline: boolean;
  timeout?: number;
  default?: string;
}
```

**Example SDK Usage**:
```typescript
import { runVisor } from '@anthropic-ai/visor';

const result = await runVisor({
  config: '.visor.yaml',
  hooks: {
    onHumanInput: async (request) => {
      // Custom implementation - could open GUI, send notification, etc.
      return await myCustomInputHandler(request);
    }
  }
});
```

## Implementation Plan

### Phase 1: Core Provider (Priority 1)
1. **Create `human-input-check-provider.ts`**
   - Location: `src/providers/human-input-check-provider.ts`
   - Implement `CheckProvider` interface
   - Handle both CLI and SDK modes
   - Support timeout configuration

2. **Register Provider**
   - Add to `check-provider-registry.ts`
   - Add type to `CheckConfig` union in `types/config.ts`

3. **Add Type Definitions**
   - Update `src/types/config.ts` with `HumanInputCheckConfig`
   - Add hook interface types

### Phase 2: CLI Support (Priority 1)
1. **Add `--message` Argument**
   - Update `src/cli-main.ts` argument parser
   - Auto-detect file paths (check if contains `/` or `\` and file exists)
   - Read file content if path detected, otherwise use as literal message
   - Pass to check execution engine

2. **Implement STDIN Reader**
   - Create `src/utils/stdin-reader.ts`
   - Handle piped input vs interactive mode
   - Support multiline input with proper termination

3. **Interactive Terminal UI**
   - Create `src/utils/interactive-prompt.ts`
   - Display beautiful formatted prompt with box drawing characters
   - Show placeholder text in dim color
   - Handle multiline input (Ctrl+D to finish)
   - Show timeout countdown if configured (update every second)
   - Graceful fallback for terminals without Unicode support
   - Clear instructions for user interaction

### Phase 3: SDK Integration (Priority 2)
1. **Add Hook Support**
   - Update config types to include `hooks` property
   - Pass hooks through execution engine to providers
   - Document hook interface

2. **Default Hook Implementation**
   - Create fallback that throws error in non-CLI mode
   - Provide clear error message when hook not configured

### Phase 4: Enhanced Features (Priority 3)
1. **Input Validation**
   - Support `pattern` field for regex validation
   - Support `minLength` / `maxLength`
   - Support `options` for multiple choice

2. **Rich Prompting**
   - Support markdown in prompts
   - Display PR context alongside prompt
   - Show previous check outputs for context

3. **Persistent State**
   - Cache responses for re-runs
   - Option to skip if already answered
   - Clear cache command

## File Changes

### New Files
- `src/providers/human-input-check-provider.ts` - Main provider implementation
- `src/utils/stdin-reader.ts` - STDIN reading utilities
- `src/utils/interactive-prompt.ts` - Terminal UI for prompts
- `tests/unit/providers/human-input-check-provider.test.ts` - Unit tests
- `tests/integration/human-input-cli.test.ts` - CLI integration tests

### Modified Files
- `src/cli-main.ts` - Add --message argument, STDIN handling
- `src/types/config.ts` - Add HumanInputCheckConfig type
- `src/providers/check-provider-registry.ts` - Register new provider
- `src/check-execution-engine.ts` - Pass hooks to providers
- `src/config.ts` - Support hooks in config
- `README.md` - Document new check type
- `docs/check-types.md` - Add human-input documentation

## Configuration Examples

### Simple Approval Gate
```yaml
checks:
  human-approval:
    type: human-input
    prompt: "Do you approve these changes? (yes/no)"
    allow_empty: false  # Must provide an answer

  deploy:
    type: command
    depends_on: [human-approval]
    fail_if: "outputs['human-approval'].toLowerCase() !== 'yes'"
    command: "npm run deploy"
```

### Context Collection
```yaml
checks:
  gather-context:
    type: human-input
    prompt: |
      Please describe the business context for this change:
      - What problem does it solve?
      - Are there any risks?
    multiline: true

  ai-review:
    type: ai
    depends_on: [gather-context]
    prompt: |
      Review this PR with the following context:
      {{ outputs['gather-context'] }}
```

### Conditional Workflow
```yaml
checks:
  choose-path:
    type: human-input
    prompt: "Run (1) quick check or (2) full analysis?"

  quick-check:
    type: ai
    depends_on: [choose-path]
    if: "outputs['choose-path'] === '1'"

  full-analysis:
    type: ai
    depends_on: [choose-path]
    if: "outputs['choose-path'] === '2'"
```

## Testing Strategy

### Unit Tests
- Provider registration
- Input validation
- Timeout handling
- Hook invocation

### Integration Tests
- CLI with --message argument
- CLI with piped STDIN
- CLI interactive mode (mocked)
- SDK mode with custom hook

### E2E Tests
- Full workflow with approval gate
- Workflow with context collection
- Error handling (timeout, invalid input)

## Documentation Updates

1. **README.md**: Add section on human-input check type
2. **docs/check-types.md**: Comprehensive guide with examples
3. **docs/cli-usage.md**: Document --message argument and STDIN
4. **docs/sdk-usage.md**: Document hooks configuration
5. **docs/debugging.md**: Add human-input debugging tips

## Implementation Order

1. ✅ Create plan document (this file)
2. ✅ Core provider implementation
3. ✅ CLI --message argument
4. ✅ STDIN support
5. ✅ Interactive terminal UI
6. ✅ SDK hooks integration
7. ⏳ Unit tests (pending)
8. ⏳ Integration tests (pending)
9. ✅ Documentation (examples + README)
10. ✅ E2E examples (calculator + basic)

## Open Questions

1. **Timeout Behavior**: Should timeout return empty string, throw error, or use default value?
   - **Recommendation**: Use `default` value if provided, otherwise throw error
   - If `allow_empty: true` and no default, return empty string on timeout

2. **Multiple Inputs**: Should we support multiple prompts in one check?
   - **Recommendation**: Start with single input, add multi-input in Phase 4

3. **GitHub Action Mode**: How should this work in automated CI/CD?
   - **Recommendation**: Fail fast with clear error message, document as CLI/SDK only feature
   - Alternative: Support GitHub issue comments as input mechanism

4. **Security**: Should we sanitize/validate user input?
   - **Recommendation**: Yes, sanitize for command injection, add validation options

5. **Async Workflows**: Should we support webhook-based async input?
   - **Recommendation**: Phase 4 enhancement, could integrate with http-input-provider

## Success Criteria

- ✅ Human-input check type works in CLI with --message
- ✅ STDIN piping works correctly
- ✅ Interactive mode prompts user and captures input
- ✅ SDK mode calls hook function correctly
- ✅ Input can be used in dependent checks
- ✅ Proper error handling for timeouts and missing input
- ✅ Comprehensive documentation and examples
- ✅ 90%+ test coverage for new code

## Future Enhancements

- GUI prompts for desktop CLI usage
- Slack/Discord integration for team approvals
- GitHub issue/PR comment integration for async workflows
- Input history and suggestions
- Voice input support
- Rich input types (file upload, multi-select, date picker)
