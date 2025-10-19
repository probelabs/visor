# MCP Provider

The MCP (Model Context Protocol) provider allows you to call MCP tools directly from Visor checks without requiring an AI provider. This is useful for integrating external tools, services, or custom logic into your review workflows.

## Overview

Unlike the AI provider's MCP support (which enhances AI models with additional tools), the standalone MCP provider directly invokes MCP tools and returns their results. This enables you to:

- Call external APIs and services via MCP tools
- Execute custom analysis tools
- Integrate third-party MCP servers
- Chain MCP tool outputs with other checks using dependencies

## Transport Types

The MCP provider supports three transport mechanisms:

### 1. stdio (default)

Execute a local command that implements the MCP protocol over standard input/output.

```yaml
checks:
  probe-analysis:
    type: mcp
    transport: stdio
    command: npx
    args: ["-y", "@probelabs/probe@latest", "mcp"]
    method: search_code
    methodArgs:
      query: "TODO"
```

**Configuration:**
- `command` (required): Command to execute
- `args` (optional): Array of command arguments
- `env` (optional): Environment variables
- `workingDirectory` (optional): Working directory for the command

**Security:** Commands are validated to prevent shell injection. Metacharacters like `;`, `|`, `&`, `` ` ``, `$`, `()`, `{}`, `[]` are rejected.

### 2. SSE (Server-Sent Events)

Connect to an MCP server via SSE (legacy transport).

```yaml
checks:
  remote-analysis:
    type: mcp
    transport: sse
    url: https://mcp-server.example.com/sse
    headers:
      Authorization: "Bearer ${MCP_TOKEN}"
    method: analyze
    methodArgs:
      file: "{{ pr.files[0].filename }}"
```

**Configuration:**
- `url` (required): SSE endpoint URL
- `headers` (optional): HTTP headers for authentication

### 3. HTTP (Streamable HTTP)

Connect to an MCP server via modern Streamable HTTP transport.

```yaml
checks:
  http-tool:
    type: mcp
    transport: http
    url: https://mcp-server.example.com/mcp
    sessionId: "my-session-123"  # Optional, server may generate one
    headers:
      Authorization: "Bearer ${MCP_TOKEN}"
    method: process
    methodArgs:
      data: "{{ pr.title }}"
```

**Configuration:**
- `url` (required): HTTP endpoint URL
- `sessionId` (optional): Session ID for stateful interactions
- `headers` (optional): HTTP headers

**Note:** HTTP transport supports stateful sessions. The server may generate a session ID if not provided.

## Method Arguments

### Static Arguments

Provide method arguments directly:

```yaml
checks:
  search-todos:
    type: mcp
    command: npx
    args: ["-y", "@probelabs/probe@latest", "mcp"]
    method: search_code
    methodArgs:
      query: "TODO"
      limit: 10
```

### Templated Arguments with Liquid

Use Liquid templates to build arguments from PR context:

```yaml
checks:
  dynamic-search:
    type: mcp
    command: npx
    args: ["-y", "@probelabs/probe@latest", "mcp"]
    method: search_code
    argsTransform: |
      {
        "query": "{{ pr.title | split: ' ' | first }}",
        "files": [{% for file in pr.files %}"{{ file.filename }}"{% unless forloop.last %},{% endunless %}{% endfor %}]
      }
```

**Template Context:**
- `pr` - PR metadata (number, title, author, branch, base)
- `files` - Array of changed files
- `fileCount` - Number of changed files
- `outputs` - Results from dependent checks (see Dependencies)
- `env` - Safe environment variables (CI_*, GITHUB_*, etc.)

## Output Transformation

### Liquid Transform

Transform MCP output using Liquid templates:

```yaml
checks:
  format-results:
    type: mcp
    command: npx
    args: ["-y", "@probelabs/probe@latest", "mcp"]
    method: search_code
    methodArgs:
      query: "FIXME"
    transform: |
      {
        "count": {{ output.results | size }},
        "files": [{% for result in output.results %}"{{ result.file }}"{% unless forloop.last %},{% endunless %}{% endfor %}]
      }
```

**Transform Context:**
- `output` - MCP method result
- All context from `argsTransform` (pr, files, outputs, env)

### JavaScript Transform

Apply JavaScript transformations in a secure sandbox:

```yaml
checks:
  js-transform:
    type: mcp
    command: npx
    args: ["-y", "@probelabs/probe@latest", "mcp"]
    method: search_code
    methodArgs:
      query: "TODO"
    transform_js: |
      // Filter and map results
      output.results
        .filter(r => r.severity === 'high')
        .map(r => ({
          file: r.file,
          message: `TODO found: ${r.text}`
        }))
```

**Available in sandbox:**
- Standard JavaScript: `Array`, `String`, `Object`, `Math`, `JSON`
- Context variables: `output`, `pr`, `files`, `outputs`, `env`
- Safe methods only (no `eval`, `Function`, `require`, etc.)

**Note:** Both transforms can be used together. Liquid runs first, then JavaScript.

## Issue Extraction

The MCP provider automatically extracts issues from output in several formats:

### Array of Issues

```json
[
  {
    "file": "src/index.ts",
    "line": 42,
    "message": "Security vulnerability detected",
    "severity": "error",
    "category": "security"
  }
]
```

### Object with Issues Property

```json
{
  "issues": [...],
  "metadata": { "scanned": 15 }
}
```

The `issues` array is extracted and remaining properties are preserved in `output`.

### Single Issue Object

```json
{
  "file": "src/app.ts",
  "line": 10,
  "message": "Performance issue",
  "severity": "warning"
}
```

**Supported Issue Fields:**
- `message` (required): Issue description (aliases: `text`, `description`, `summary`)
- `file`: File path (aliases: `path`, `filename`, defaults to "system")
- `line`: Line number (aliases: `startLine`, `lineNumber`, defaults to 0)
- `endLine`: End line number (aliases: `end_line`, `stopLine`)
- `severity`: info/warning/error/critical (aliases: `level`, `priority`, defaults to "warning")
- `category`: security/performance/style/logic/documentation (aliases: `type`, `group`, defaults to "logic")
- `ruleId`: Rule identifier (aliases: `rule`, `id`, `check`, defaults to "mcp")
- `suggestion`: Suggested fix
- `replacement`: Replacement code

## Dependencies

Use outputs from other checks in MCP arguments:

```yaml
checks:
  fetch-data:
    type: http_client
    url: https://api.example.com/issues

  analyze-issues:
    type: mcp
    depends_on: [fetch-data]
    command: npx
    args: ["-y", "@probelabs/probe@latest", "mcp"]
    method: analyze
    argsTransform: |
      {
        "issues": {{ outputs["fetch-data"] | json }}
      }
```

Outputs are available as:
- `outputs["check-name"]` - Full result object or `output` property if present
- Safe to use in both `argsTransform` and `transform`

## Configuration Reference

### Required Fields

- `type: mcp` - Provider type
- `method` - MCP tool/method name to call

### Transport Configuration

**stdio transport:**
- `transport: stdio` (optional, default)
- `command` - Command to execute
- `args` - Command arguments (optional)
- `env` - Environment variables (optional)
- `workingDirectory` - Working directory (optional)

**sse transport:**
- `transport: sse`
- `url` - SSE endpoint URL
- `headers` - HTTP headers (optional)

**http transport:**
- `transport: http`
- `url` - HTTP endpoint URL
- `sessionId` - Session ID (optional)
- `headers` - HTTP headers (optional)

### Method Configuration

- `methodArgs` - Static method arguments (optional)
- `argsTransform` - Liquid template for dynamic arguments (optional)
- `transform` - Liquid template for output transformation (optional)
- `transform_js` - JavaScript expression for output transformation (optional)

### General

- `timeout` - Timeout in seconds (default: 60)
- `depends_on` - Array of check names this depends on
- `if` - Conditional execution (JavaScript expression)
- `on` - Event filter (pr_opened, pr_updated, etc.)
- `tags` - Array of tags for filtering
- `group` - Comment group name

## Real-World Examples

See [examples/mcp-provider-example.yaml](../examples/mcp-provider-example.yaml) for comprehensive production-ready workflows.

### Security Scanning with Semgrep

Detect vulnerabilities in changed code:

```yaml
checks:
  semgrep-scan:
    type: mcp
    command: npx
    args: ["-y", "@semgrep/mcp"]
    method: scan
    methodArgs:
      paths: "{{ files | map: 'filename' | json }}"
      rules: ["security", "owasp-top-10"]
```

### GitHub Issue Detection

Find related or duplicate issues:

```yaml
checks:
  check-duplicates:
    type: mcp
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    method: search_issues
    methodArgs:
      query: "{{ pr.title }}"
      state: "open"
    transform_js: |
      output.items
        .filter(issue => issue.number !== pr.number)
        .map(issue => ({
          file: 'github',
          line: 0,
          message: `Related: #${issue.number} - ${issue.title}`,
          severity: 'info',
          category: 'documentation'
        }))
```

### Database Schema Validation

Verify migrations don't break schema:

```yaml
checks:
  validate-schema:
    type: mcp
    command: npx
    args: ["-y", "@modelcontextprotocol/server-postgres"]
    if: "files.some(f => f.filename.includes('migrations/'))"
    method: query
    methodArgs:
      query: "SELECT * FROM information_schema.tables WHERE table_schema = 'public'"
    transform_js: |
      const criticalTables = ['users', 'sessions', 'payments'];
      const existing = output.rows.map(r => r.table_name);
      const missing = criticalTables.filter(t => !existing.includes(t));

      return missing.map(table => ({
        file: 'database',
        line: 0,
        message: `Critical table '${table}' missing after migration`,
        severity: 'error',
        category: 'logic'
      }));
```

### Jira Ticket Validation

Ensure PR links to valid Jira ticket:

```yaml
checks:
  jira-check:
    type: mcp
    command: npx
    args: ["-y", "@atlassian/mcp-server-jira"]
    method: get_issue
    argsTransform: |
      {
        "issueKey": "{{ pr.title | split: ' ' | first | upcase }}"
      }
    transform_js: |
      if (output.error || !output.fields) {
        return [{
          file: 'jira',
          line: 0,
          message: 'PR must reference valid Jira ticket (e.g., PROJ-123)',
          severity: 'error',
          category: 'documentation'
        }];
      }
      return [];
```

### Slack Notifications

Alert team when critical issues found:

```yaml
checks:
  notify-security:
    type: mcp
    depends_on: [semgrep-scan]
    command: npx
    args: ["-y", "@modelcontextprotocol/server-slack"]
    if: "outputs['semgrep-scan']?.issues?.filter(i => i.severity === 'error').length > 0"
    method: post_message
    argsTransform: |
      {
        "channel": "#security-alerts",
        "text": "🚨 PR #{{ pr.number }} has critical security issues"
      }
```

### License Header Validation

Check all source files have license headers:

```yaml
checks:
  check-licenses:
    type: mcp
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    method: read_file
    forEach:
      items: "{{ files | map: 'filename' | json }}"
      itemVar: filepath
    methodArgs:
      path: "{{ filepath }}"
    transform_js: |
      const content = output.content || '';
      const hasLicense = content.includes('Copyright') || content.includes('SPDX-License');

      if (!hasLicense && filepath.match(/\.(ts|js|py|go)$/)) {
        return [{
          file: filepath,
          line: 1,
          message: 'Missing license header',
          severity: 'warning',
          category: 'documentation',
          suggestion: 'Add SPDX-License-Identifier comment'
        }];
      }
      return [];
```

### Web Scraping with Puppeteer

Validate external documentation links:

```yaml
checks:
  validate-links:
    type: mcp
    command: npx
    args: ["-y", "@modelcontextprotocol/server-puppeteer"]
    if: "files.some(f => f.filename.endsWith('.md'))"
    method: navigate
    methodArgs:
      url: "https://docs.example.com"
      waitUntil: "networkidle2"
    transform_js: |
      if (output.statusCode >= 400) {
        return [{
          file: 'documentation',
          line: 0,
          message: `Broken link: ${output.url} (${output.statusCode})`,
          severity: 'warning',
          category: 'documentation'
        }];
      }
      return [];
```

### CVE Checking with Brave Search

Search for known vulnerabilities:

```yaml
checks:
  check-cves:
    type: mcp
    command: npx
    args: ["-y", "@modelcontextprotocol/server-brave-search"]
    if: "files.some(f => f.filename.match(/package\\.json|requirements\\.txt/))"
    method: search
    argsTransform: |
      {
        "query": "CVE {{ pr.title }} vulnerability"
      }
    transform_js: |
      const cvePattern = /CVE-\d{4}-\d{4,7}/g;
      const results = output.web?.results || [];
      const cves = new Set();

      results.forEach(result => {
        const matches = result.description?.match(cvePattern) || [];
        matches.forEach(cve => cves.add(cve));
      });

      if (cves.size > 0) {
        return [{
          file: 'dependencies',
          line: 0,
          message: `Potential CVEs: ${Array.from(cves).join(', ')}`,
          severity: 'warning',
          category: 'security'
        }];
      }
      return [];
```

## Security Considerations

1. **Command Validation**: stdio commands are validated to prevent injection attacks
2. **Sandboxed JavaScript**: `transform_js` runs in a secure sandbox without access to system resources
3. **Safe Environment**: Only whitelisted environment variables are exposed (CI_*, GITHUB_*, etc.)
4. **URL Validation**: Only http: and https: protocols are allowed for SSE/HTTP transports
5. **Timeout Protection**: All MCP calls have configurable timeouts (default 60s)

## Debugging

Enable debug mode to see MCP interactions:

```bash
visor --check my-mcp-check --debug
```

Debug output includes:
- MCP server connection details
- Available tools from the server
- Method call arguments and results
- Session IDs for HTTP transport
- Transform errors and outputs

## Related Documentation

- [MCP Tools for AI Providers](./mcp.md) - Using MCP to enhance AI analysis
- [Command Provider](./command-provider.md) - Execute shell commands
- [HTTP Integration](./http.md) - HTTP client and webhook providers
- [Dependencies](./dependencies.md) - Check dependency management
- [Liquid Templates](./liquid-templates.md) - Template syntax reference
