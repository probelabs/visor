## 🧠 Advanced AI Features

### AI Session Reuse
Use `reuse_ai_session: true` on dependent checks to continue conversation context with the AI across checks. This improves follow‑ups and consistency.

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

**When to use each mode:**
- Use **`clone`** (default) when you want parallel follow-ups that don't interfere with each other
- Use **`append`** when you want sequential conversation where each check builds on previous responses

### XML-Formatted Analysis
Visor uses structured XML formatting when sending data to AI providers, enabling precise and context-aware analysis for both pull requests and issues.

#### Pull Request Context
For PR events, Visor provides comprehensive code review context:

```xml
<pull_request>
  <metadata>
    <number>123</number>                    <!-- PR number -->
    <title>Add user authentication</title>  <!-- PR title -->
    <author>developer</author>               <!-- PR author username -->
    <base_branch>main</base_branch>         <!-- Target branch (where changes will be merged) -->
    <target_branch>feature-auth</target_branch> <!-- Source branch (contains the changes) -->
    <total_additions>250</total_additions>  <!-- Total lines added across all files -->
    <total_deletions>50</total_deletions>   <!-- Total lines removed across all files -->
    <files_changed_count>3</files_changed_count> <!-- Number of files modified -->
  </metadata>

  <description>
    <!-- PR description/body text provided by the author -->
    This PR implements JWT-based authentication with refresh token support
  </description>

  <full_diff>
    <!-- Complete unified diff of all changes (present for all PR analyses) -->
    --- src/auth.ts
    +++ src/auth.ts
    @@ -1,3 +1,10 @@
    +import jwt from 'jsonwebtoken';
    ...
  </full_diff>

  <commit_diff>
    <!-- Only present for incremental analysis (pr_updated events) -->
    <!-- Contains diff of just the latest commit pushed -->
  </commit_diff>

  <files_summary>
    <!-- List of all modified files with change statistics -->
    <file index="1">
      <filename>src/auth.ts</filename>
      <status>modified</status>          <!-- added/modified/removed/renamed -->
      <additions>120</additions>          <!-- Lines added in this file -->
      <deletions>10</deletions>           <!-- Lines removed from this file -->
    </file>
  </files_summary>

  <!-- Only present for issue_comment events on PRs -->
  <triggering_comment>
    <author>reviewer1</author>
    <created_at>2024-01-16T15:30:00Z</created_at>
    <body>/review --check security</body>
  </triggering_comment>

  <!-- Historical comments on the PR (excludes triggering comment) -->
  <comment_history>
    <comment index="1">
      <author>reviewer2</author>
      <created_at>2024-01-15T11:00:00Z</created_at>
      <body>Please add unit tests for the authentication logic</body>
    </comment>
    <comment index="2">
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
  <metadata>
    <number>456</number>                   <!-- Issue number -->
    <title>Feature request: Add dark mode</title> <!-- Issue title -->
    <author>user123</author>                <!-- Issue author username -->
    <state>open</state>                     <!-- Issue state: open/closed -->
    <created_at>2024-01-15T10:30:00Z</created_at> <!-- When issue was created -->
    <updated_at>2024-01-16T14:20:00Z</updated_at> <!-- Last update timestamp -->
    <comments_count>5</comments_count>      <!-- Total number of comments -->
  </metadata>

  <description>
    <!-- Issue body/description text provided by the author -->
    I would like to request a dark mode feature for better accessibility...
  </description>

  <labels>
    <!-- GitHub labels applied to categorize the issue -->
    <label>enhancement</label>
    <label>good first issue</label>
    <label>ui/ux</label>
  </labels>

  <assignees>
    <!-- Users assigned to work on this issue -->
    <assignee>developer1</assignee>
    <assignee>developer2</assignee>
  </assignees>

  <milestone>
    <!-- Project milestone this issue is part of (if any) -->
    <title>v2.0 Release</title>
    <state>open</state>                     <!-- Milestone state: open/closed -->
    <due_on>2024-03-01T00:00:00Z</due_on>  <!-- Milestone due date -->
  </milestone>

  <!-- Only present for issue_comment events -->
  <triggering_comment>
    <author>user456</author>                <!-- User who posted the triggering comment -->
    <created_at>2024-01-16T15:30:00Z</created_at> <!-- When comment was posted -->
    <body>/review security --focus authentication</body> <!-- The comment text -->
  </triggering_comment>

  <!-- Historical comments on the issue (excludes triggering comment) -->
  <comment_history>
    <comment index="1">                     <!-- Comments ordered by creation time -->
      <author>developer1</author>
      <created_at>2024-01-15T11:00:00Z</created_at>
      <body>This is a great idea! I'll start working on it.</body>
    </comment>
    <comment index="2">
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
