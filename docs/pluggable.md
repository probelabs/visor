## 🔧 Pluggable Architecture

Visor supports multiple provider types (ai, mcp, http, http_client, log, command, github, claude-code). You can also add custom providers.

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

#### Logger Provider (`type: logger`)
Log messages for debugging and workflow visibility.

```yaml
steps:
  debug:
    type: logger
    message: "PR #{{ pr.number }}: {{ fileCount }} files changed"
```

[Learn more](./debugging.md)

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

#### Claude Code Provider (`type: claude-code`)
Use Claude Code SDK with MCP tools and advanced agent capabilities.

```yaml
steps:
  claude-analysis:
    type: claude-code
    prompt: "Analyze code architecture"
```

[Learn more](./claude-code.md)

