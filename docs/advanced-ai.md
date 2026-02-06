## Advanced AI Features

### AI Session Reuse
Use `reuse_ai_session` on checks to continue conversation context with the AI across steps. This improves follow‑ups and consistency for follow‑on analysis and chat‑style flows.

**Session Modes:**
- **`clone` (default)**: Creates a copy of the conversation history. Each check gets an independent session with the same starting context. Changes made by one check don't affect others.
- **`append`**: Shares the same conversation thread. All checks append to a single shared history, creating a true multi-turn conversation.

```yaml
steps:
  security:
    type: ai
    prompt: "Analyze code for security vulnerabilities..."

  security-remediation:
    type: ai
    prompt: "Based on our security analysis, provide remediation guidance."
    depends_on: [security]
    reuse_ai_session: true
    # session_mode: clone (default - independent copy of history)

  security-verify:
    type: ai
    prompt: "Verify the remediation suggestions are complete."
    depends_on: [security-remediation]
    reuse_ai_session: true
    session_mode: append  # Share history - sees full conversation
```

#### Reusing your own session: `reuse_ai_session: self`

Sometimes the step you want to loop back into is the AI step itself (e.g. Slack assistants or multi‑turn internal tools). For that case you can use:

- `reuse_ai_session: "self"` – the step reuses its **own** Probe session when it runs again in the same engine run.
- `session_mode: append` – makes the follow‑up behave like a normal conversation turn.

On the first run of the step, Visor creates a new ProbeAgent session and registers it. If routing (`on_success.goto`, `goto_js`, etc.) later jumps back to the same step within the same run, the engine:

- Finds the last result for that step in the current run.
- Reads the `sessionId` stored in the result.
- Calls the AI provider again using `executeReviewWithSessionReuse` with that session id.

Simple example (no transport wiring, just CLI/tests):

```yaml
version: "2.0"

steps:
  seed:
    type: script
    content: |
      return { text: "hello from seed" };

  convo:
    type: ai
    depends_on: [seed]
    reuse_ai_session: self
    session_mode: append
    ai:
      provider: mock
      model: mock
      disableTools: true
      allowedTools: []
      system_prompt: "You are a tiny echo assistant."
    prompt: |
      Seed message: {{ outputs['seed'].text }}

      Past convo outputs in this run:
      {% assign hist = outputs_history['convo'] | default: empty %}
      {% if hist and hist.size > 0 %}
      {% for h in hist %}
      - Previous reply {{ forloop.index }}.
      {% endfor %}
      {% else %}
      - No previous replies yet.
      {% endif %}
    on_success:
      goto_js: |
        // Example: re‑enter this step up to 3 times in a single run
        return attempt < 3 ? 'convo' : null;
```

The corresponding testable example lives at:

- `examples/session-reuse-self.yaml`

This keeps the configuration small but shows how to wire `reuse_ai_session: self` and `session_mode: append` without touching higher-level workflows like `tyk-assistant`.

**When to use each mode:**
- Use **`clone`** (default) when you want parallel follow-ups that don't interfere with each other
- Use **`append`** when you want sequential conversation where each check builds on previous responses

### XML-Formatted Analysis
Visor uses structured XML formatting when sending data to AI providers, enabling precise and context-aware analysis for both pull requests and issues.

#### Pull Request Context
For PR events, Visor provides comprehensive code review context:

```xml
<pull_request>
  <!-- Core pull request metadata including identification, branches, and change statistics -->
  <metadata>
    <number>123</number>
    <title>Add user authentication</title>
    <author>developer</author>
    <base_branch>main</base_branch>
    <target_branch>feature-auth</target_branch>
    <total_additions>250</total_additions>
    <total_deletions>50</total_deletions>
    <files_changed_count>3</files_changed_count>
  </metadata>

  <!-- Raw diff header snippet for compatibility -->
  <raw_diff_header>
diff --git a/src/auth.ts b/src/auth.ts
  </raw_diff_header>

  <!-- Full pull request description provided by the author -->
  <description>
This PR implements JWT-based authentication with refresh token support
  </description>

  <!-- Complete unified diff showing all changes (processed with outline-diff) -->
  <full_diff>
--- src/auth.ts
+++ src/auth.ts
@@ -1,3 +1,10 @@
+import jwt from 'jsonwebtoken';
...
  </full_diff>

  <!-- Diff of only the latest commit for incremental analysis (only present for pr_updated events) -->
  <commit_diff>
<!-- Contains diff of just the latest commit pushed -->
  </commit_diff>

  <!-- Summary of all files changed with statistics -->
  <files_summary>
    <file>
      <filename>src/auth.ts</filename>
      <status>modified</status>
      <additions>120</additions>
      <deletions>10</deletions>
    </file>
  </files_summary>

  <!-- The comment that triggered this analysis (only present for issue_comment events) -->
  <triggering_comment>
    <author>reviewer1</author>
    <created_at>2024-01-16T15:30:00Z</created_at>
    <body>/review --check security</body>
  </triggering_comment>

  <!-- Previous comments in chronological order (excluding triggering comment) -->
  <comment_history>
    <comment>
      <author>reviewer2</author>
      <created_at>2024-01-15T11:00:00Z</created_at>
      <body>Please add unit tests for the authentication logic</body>
    </comment>
    <comment>
      <author>developer</author>
      <created_at>2024-01-15T14:30:00Z</created_at>
      <body>Tests added in latest commit</body>
    </comment>
  </comment_history>
</pull_request>
```

#### Issue Context
For issue events, Visor provides issue-specific context for intelligent assistance:

```xml
<issue>
  <!-- Core issue metadata including identification, status, and timeline information -->
  <metadata>
    <number>456</number>
    <title>Feature request: Add dark mode</title>
    <author>user123</author>
    <state>open</state>
    <created_at>2024-01-15T10:30:00Z</created_at>
    <updated_at>2024-01-16T14:20:00Z</updated_at>
    <comments_count>5</comments_count>
  </metadata>

  <!-- Full issue description and body text provided by the issue author -->
  <description>
I would like to request a dark mode feature for better accessibility...
  </description>

  <!-- Applied labels for issue categorization and organization -->
  <labels>
    <label>enhancement</label>
    <label>good first issue</label>
    <label>ui/ux</label>
  </labels>

  <!-- Users assigned to work on this issue -->
  <assignees>
    <assignee>developer1</assignee>
    <assignee>developer2</assignee>
  </assignees>

  <!-- Associated project milestone information -->
  <milestone>
    <title>v2.0 Release</title>
    <state>open</state>
    <due_on>2024-03-01T00:00:00Z</due_on>
  </milestone>

  <!-- The comment that triggered this analysis (only present for issue_comment events) -->
  <triggering_comment>
    <author>user456</author>
    <created_at>2024-01-16T15:30:00Z</created_at>
    <body>/review security --focus authentication</body>
  </triggering_comment>

  <!-- Previous comments in chronological order (excluding triggering comment) -->
  <comment_history>
    <comment>
      <author>developer1</author>
      <created_at>2024-01-15T11:00:00Z</created_at>
      <body>This is a great idea! I'll start working on it.</body>
    </comment>
    <comment>
      <author>user123</author>
      <created_at>2024-01-15T14:30:00Z</created_at>
      <body>Thanks! Please consider accessibility standards.</body>
    </comment>
  </comment_history>
</issue>
```

### Incremental Commit Analysis
When new commits are pushed to a PR, Visor performs incremental analysis:
- Full Analysis: Reviews the entire PR on initial creation
- Incremental Analysis: On new commits, focuses only on the latest changes
- Smart Updates: Updates existing review comments instead of creating duplicates

### Intelligent Comment Management
- Unique Comment IDs: Each PR gets a unique review comment that persists across updates
- Collision Detection: Prevents conflicts when multiple reviews run simultaneously
- Context-Aware Updates: Comments are updated with relevant context (PR opened, updated, synchronized)
