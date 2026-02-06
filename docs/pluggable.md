## Pluggable Architecture

Visor supports multiple provider types. You can also add custom providers.

**Built-in Providers:** ai, mcp, command, script, http, http_input, http_client, log, memory, noop, github, human-input, workflow, git-checkout, claude-code

### Custom Provider Skeleton (TypeScript)

```ts
class CustomCheckProvider {
  name = 'custom';
  async run(input) {
    // ... implement your logic
    return { issues: [] };
  }
}
```

### Built-in Providers

#### AI Provider (`type: ai`)
Execute AI-powered analysis using Google Gemini, Anthropic Claude, OpenAI, or AWS Bedrock.

```yaml
steps:
  security:
    type: ai
    prompt: "Review for security issues"
    schema: code-review
```

[Learn more](./ai-configuration.md)

#### MCP Provider (`type: mcp`)
Call MCP (Model Context Protocol) tools directly via stdio, SSE, or HTTP transports. Unlike AI provider MCP support, this provider directly invokes MCP tools without an AI model.

```yaml
steps:
  probe-search:
    type: mcp
    transport: stdio
    command: npx
    args: ["-y", "@probelabs/probe@latest", "mcp"]
    method: search_code
    methodArgs:
      query: "TODO"
```

[Learn more](./mcp-provider.md)

#### Command Provider (`type: command`)
Execute shell commands with templating and security controls.

```yaml
steps:
  lint:
    type: command
    exec: npm run lint
```

[Learn more](./command-provider.md)

#### Script Provider (`type: script`)
Execute JavaScript in a secure sandbox with access to PR context, outputs, and memory.

```yaml
steps:
  analyze:
    type: script
    content: |
      const issues = outputs['lint-check'] || [];
      memory.set('issue_count', issues.length);
      return { total: issues.length };
```

[Learn more](./script.md)

#### HTTP Client Provider (`type: http_client`)
Make HTTP requests to external APIs.

```yaml
steps:
  api-check:
    type: http_client
    url: https://api.example.com/analyze
    method: POST
    body: '{{ pr | json }}'
```

[Learn more](./http.md)

#### HTTP Provider (`type: http`)
Send check results to external webhooks.

```yaml
steps:
  notify:
    type: http
    url: https://webhook.example.com/notify
    method: POST
```

[Learn more](./http.md)

#### HTTP Input Provider (`type: http_input`)
Receive and process HTTP webhook input data for use by dependent checks.

```yaml
steps:
  webhook-data:
    type: http_input
    endpoint: /webhook/incoming
```

[Learn more](./http.md)

#### Log Provider (`type: log`)
Log messages for debugging and workflow visibility.

```yaml
steps:
  debug:
    type: log
    message: "PR #{{ pr.number }}: {{ fileCount }} files changed"
```

[Learn more](./debugging.md)

#### Memory Provider (`type: memory`)
Persistent key-value storage across checks for stateful workflows.

```yaml
steps:
  init-counter:
    type: memory
    operation: set
    key: retry_count
    value: 0
```

[Learn more](./memory.md)

#### Noop Provider (`type: noop`)
No-operation provider for command orchestration and dependency triggering.

```yaml
steps:
  trigger-all:
    type: noop
    depends_on: [check1, check2, check3]
```

#### GitHub Provider (`type: github`)
Interact with GitHub API for labels, comments, and status checks.

```yaml
steps:
  label-pr:
    type: github
    op: labels.add
    values: ["security", "needs-review"]
```

[Learn more](./github-ops.md)

#### Human Input Provider (`type: human-input`)
Pause workflow execution to request input from a human user.

```yaml
steps:
  approval:
    type: human-input
    prompt: "Approve deployment? (yes/no)"
```

[Learn more](./human-input-provider.md)

#### Workflow Provider (`type: workflow`)
Execute reusable workflow definitions as steps.

```yaml
steps:
  security-scan:
    type: workflow
    workflow: security-scan
    args:
      severity_threshold: high
```

[Learn more](./workflows.md)

#### Git Checkout Provider (`type: git-checkout`)
Checkout code from git repositories using efficient worktree management.

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
```

[Learn more](./providers/git-checkout.md)

#### Claude Code Provider (`type: claude-code`)
Use Claude Code SDK with MCP tools and advanced agent capabilities.

```yaml
steps:
  claude-analysis:
    type: claude-code
    prompt: "Analyze code architecture"
```

[Learn more](./claude-code.md)

