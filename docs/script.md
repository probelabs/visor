## Script Step (`type: script`)

The `script` provider executes JavaScript in a secure sandbox with access to PR context, dependency outputs, workflow inputs, environment variables, and the Visor memory store. Scripts can also call external tools, MCP servers, and built-in functions like `schedule()`, `fetch()`, `github()`, and `bash()`.

## Configuration

| Property | Required | Description |
|----------|----------|-------------|
| `type` | Yes | Must be `script` |
| `content` | Yes | JavaScript code to execute (max 1MB) |
| `tools` | No | List of tool names or workflow references to expose as callable functions |
| `tools_js` | No | JavaScript expression to dynamically compute tools at runtime |
| `mcp_servers` | No | MCP servers whose tools are exposed as callable functions |
| `enable_fetch` | No | Enable the `fetch()` built-in for HTTP requests (default: `false`) |
| `enable_bash` | No | Enable the `bash()` built-in for shell commands (default: `false`) |
| `timeout` | No | Execution timeout in milliseconds (default: 60000) |
| `depends_on` | No | Array of step IDs this step depends on |
| `group` | No | Group name for organizing steps |
| `on` | No | Event triggers for this step |
| `if` | No | Condition to evaluate before running |
| `fail_if` | No | Condition to fail the step |
| `on_fail` | No | Routing configuration on failure |
| `on_success` | No | Routing configuration on success |

## Sandbox Context

The secure sandbox exposes these objects and functions:

### Data Objects

| Object | Description |
|--------|-------------|
| `pr` | PR metadata: `number`, `title`, `body`, `author`, `base`, `head`, `totalAdditions`, `totalDeletions`, `files[]` |
| `outputs` | Map of dependency outputs (current values). Access via `outputs['step-name']` |
| `outputs.history` | Map of all historical outputs per step (arrays). See [Output History](./output-history.md) |
| `outputs_history` | Alias for `outputs.history` (top-level access) |
| `outputs_raw` | Aggregated values from `-raw` suffix dependencies |
| `outputs_history_stage` | Per-stage output history slice (used by test framework) |
| `inputs` | Workflow inputs (when running inside a workflow) |
| `args` | Arguments passed via `with:` directive in `on_init` |
| `env` | Environment variables (`process.env`) |

### Memory Operations

| Method | Description |
|--------|-------------|
| `memory.get(key, namespace?)` | Retrieve a value |
| `memory.has(key, namespace?)` | Check if key exists |
| `memory.list(namespace?)` | List all keys in namespace |
| `memory.getAll(namespace?)` | Get all key-value pairs |
| `memory.set(key, value, namespace?)` | Set a value |
| `memory.append(key, value, namespace?)` | Append to an array |
| `memory.increment(key, amount?, namespace?)` | Increment numeric value (default: 1) |
| `memory.delete(key, namespace?)` | Delete a key |
| `memory.clear(namespace?)` | Clear all keys in namespace |

### Utility Functions

| Function | Description |
|----------|-------------|
| `log(...args)` | Debug logging (outputs with prefix for identification) |
| `escapeXml(str)` | Escape string for XML output |
| `btoa(str)` | Base64 encode a string |
| `atob(str)` | Base64 decode a string |

## Return Value

The value you `return` from the script becomes the step's `output`, accessible to dependent steps via `outputs['step-name']`.

---

## Built-in Functions

Script steps have access to built-in async functions. You write normal synchronous-looking code — `await` is automatically injected by an AST transformer at compile time.

### `schedule(args)` — Always Available

Create, list, cancel, pause, and resume scheduled workflows or reminders.

```javascript
// Create a recurring schedule
const result = schedule({
  action: 'create',
  workflow: 'daily-review',
  cron: '0 9 * * 1-5',       // weekdays at 9am
  is_recurring: true
});
log(result.success, result.message);

// List active schedules
const list = schedule({ action: 'list' });
log(list.schedules);

// Cancel a schedule
schedule({ action: 'cancel', schedule_id: 'abc123' });

// Pause / resume
schedule({ action: 'pause', schedule_id: 'abc123' });
schedule({ action: 'resume', schedule_id: 'abc123' });
```

**Arguments for `action: 'create'`:**

| Field | Type | Description |
|-------|------|-------------|
| `action` | `string` | Required. One of: `create`, `list`, `cancel`, `pause`, `resume` |
| `workflow` | `string` | Workflow to execute on schedule |
| `workflow_inputs` | `object` | Inputs to pass to the workflow |
| `reminder_text` | `string` | Text reminder (if not running a workflow) |
| `cron` | `string` | Cron expression for recurring schedules (e.g., `"0 9 * * 1-5"`) |
| `run_at` | `string` | ISO 8601 timestamp for one-time schedules |
| `is_recurring` | `boolean` | Whether this is a recurring schedule |
| `schedule_id` | `string` | Schedule ID (for `cancel`, `pause`, `resume`) |

**Returns:** `{ success: boolean, message: string, schedule?: object, schedules?: object[], error?: string }`

### `fetch(args)` — Requires `enable_fetch: true`

Make HTTP requests from scripts. Responses are automatically parsed as JSON when the Content-Type header indicates JSON.

```yaml
checks:
  call-api:
    type: script
    enable_fetch: true
    content: |
      const data = fetch({
        url: 'https://api.example.com/data',
        headers: { Authorization: 'Bearer ' + env.API_TOKEN }
      });
      return data;
```

**Arguments:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | — | Required. The URL to fetch |
| `method` | `string` | `"GET"` | HTTP method |
| `headers` | `object` | `{}` | Request headers |
| `body` | `string` | — | Request body (ignored for GET) |
| `timeout` | `number` | `30000` | Timeout in milliseconds |

**Returns:** Parsed JSON object, or string for non-JSON responses. Returns `"ERROR: ..."` on failure.

```javascript
// POST with JSON body
const result = fetch({
  url: 'https://api.example.com/webhook',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ event: 'deploy', version: '1.2.3' })
});

// GET with query params
const users = fetch({
  url: 'https://api.example.com/users?role=admin',
  headers: { Authorization: 'Bearer ' + env.API_TOKEN },
  timeout: 10000
});
```

### `github(args)` — Available in GitHub Context

Perform GitHub operations (labels, comments) directly from scripts. This function is only available when running in a GitHub context (GitHub Actions, PR events) where an authenticated Octokit instance exists.

```yaml
checks:
  label-pr:
    type: script
    content: |
      // Add labels based on file changes
      const hasTests = pr.files.some(f => f.filename.includes('test'));
      const labels = [];
      if (hasTests) labels.push('has-tests');
      if (pr.totalAdditions > 500) labels.push('large-pr');

      if (labels.length > 0) {
        github({ op: 'labels.add', values: labels });
      }

      return { labels };
```

**Arguments:**

| Field | Type | Description |
|-------|------|-------------|
| `op` | `string` | Required. Operation: `labels.add`, `labels.remove`, or `comment.create` |
| `values` | `string[]` | Array of values (label names or comment text) |
| `value` | `string` | Single value (alternative to `values`) |

**Supported operations:**

| Operation | Description | Values |
|-----------|-------------|--------|
| `labels.add` | Add labels to the PR | Array of label names |
| `labels.remove` | Remove labels from the PR | Array of label names |
| `comment.create` | Post a comment on the PR | Single comment body string |

**Returns:** `{ success: true, op: string }` or `"ERROR: ..."` on failure.

```javascript
// Add labels
github({ op: 'labels.add', values: ['reviewed', 'approved'] });

// Remove a label
github({ op: 'labels.remove', value: 'needs-review' });

// Post a comment
github({
  op: 'comment.create',
  value: '## Automated Review\nAll checks passed.'
});
```

### `bash(args)` — Requires `enable_bash: true`

Execute shell commands from scripts. This is gated behind the `enable_bash` flag for security.

```yaml
checks:
  run-analysis:
    type: script
    enable_bash: true
    content: |
      const result = bash({ command: 'wc -l src/**/*.ts' });
      log('stdout:', result.stdout);
      log('exit code:', result.exitCode);

      if (result.exitCode !== 0) {
        return { error: result.stderr };
      }
      return { lineCount: result.stdout.trim() };
```

**Arguments:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | `string` | — | Required. Shell command to execute |
| `cwd` | `string` | — | Working directory |
| `env` | `object` | — | Additional environment variables |
| `timeout` | `number` | `30000` | Timeout in milliseconds |

**Returns:** `{ stdout: string, stderr: string, exitCode: number }` or `"ERROR: ..."` on failure.

```javascript
// Run a command with custom working directory
const out = bash({
  command: 'npm test -- --coverage',
  cwd: '/workspace/project',
  timeout: 120000
});

// Chain commands
const build = bash({ command: 'npm run build && npm run lint' });
if (build.exitCode !== 0) {
  return { success: false, error: build.stderr };
}
```

---

## External Tools

Script steps can call external tools defined in the global `tools:` section, workflow tools, and MCP server tools. Tools are exposed as regular functions — just call them by name.

### Configuring Tools

Use `tools` to reference global tools and workflows, and `mcp_servers` for MCP server tools:

```yaml
tools:
  fetch-jira:
    name: fetch-jira
    description: Fetch a Jira ticket by key
    exec: 'curl -s -H "Authorization: Bearer ${JIRA_TOKEN}" https://jira.example.com/rest/api/2/issue/{{ args.key }}'
    parseJson: true
    inputSchema:
      type: object
      properties:
        key: { type: string, description: Jira issue key }
      required: [key]

  run-linter:
    name: run-linter
    exec: 'eslint {{ args.file }} --format json'
    parseJson: true
    inputSchema:
      type: object
      properties:
        file: { type: string }

checks:
  analyze:
    type: script
    tools:
      - fetch-jira
      - run-linter
    content: |
      // Tools are available as functions — just call them by name
      const ticket = fetch_jira({ key: 'PROJ-123' });
      log('Ticket:', ticket.fields.summary);

      const lint = run_linter({ file: 'src/index.ts' });
      return { ticket: ticket.fields.summary, lintErrors: lint.length };
```

### Tool Naming Convention

Tool names are converted to valid JavaScript identifiers:
- Hyphens in tool names become underscores: `fetch-jira` → `fetch_jira()`
- MCP tools are prefixed with the server name: `github` server's `get_pull_request` tool → `github_get_pull_request()`

### Using MCP Server Tools

Connect to external MCP servers and call their tools directly:

```yaml
checks:
  mcp-analysis:
    type: script
    mcp_servers:
      github:
        command: github-mcp-server
        args: [--token, "${GITHUB_TOKEN}"]
      jira:
        command: npx
        args: [-y, "@aashari/mcp-server-atlassian-jira"]
        env:
          ATLASSIAN_SITE_NAME: mysite
    content: |
      // MCP tools are namespaced: {serverName}_{toolName}
      const pr = github_get_pull_request({
        owner: 'myorg',
        repo: 'myrepo',
        pull_number: pr.number
      });

      const issues = jira_search_issues({
        jql: 'project = PROJ AND status = Open'
      });

      return { pr: pr.title, openIssues: issues.total };
```

MCP servers support three transport types:

| Property | Description |
|----------|-------------|
| `command` + `args` | Stdio transport — spawn an MCP server as a subprocess |
| `url` | SSE or HTTP transport — connect to a remote MCP server |
| `transport` | Explicit transport type: `stdio`, `sse`, or `http` |
| `env` | Environment variables passed to the MCP server process |
| `allowedMethods` | Whitelist specific tools (supports wildcards: `search_*`) |
| `blockedMethods` | Block specific tools (supports wildcards: `*_delete`) |

### Using Workflow Tools

Reference other workflows as tools:

```yaml
checks:
  orchestrate:
    type: script
    tools:
      - workflow: security-scan
        args: { depth: full }
      - workflow: lint-check
    content: |
      const security = security_scan({ target: 'src/' });
      const lint = lint_check({ files: pr.files.map(f => f.filename) });

      return {
        secure: security.passed,
        clean: lint.errors === 0
      };
```

### Dynamic Tools with `tools_js`

Compute tools dynamically based on dependency outputs or context:

```yaml
checks:
  dynamic-step:
    type: script
    depends_on: [route-intent]
    tools_js: |
      const tools = [];
      const tags = outputs['route-intent']?.tags || [];
      if (tags.includes('jira')) tools.push('fetch-jira');
      if (tags.includes('security')) tools.push('run-security-scan');
      return tools;
    content: |
      // Only the dynamically selected tools are available
      const result = fetch_jira({ key: 'PROJ-456' });
      return result;
```

### Tool Discovery

Use `listTools()` to see all available tools at runtime:

```yaml
checks:
  discover:
    type: script
    tools: [fetch-jira, run-linter]
    content: |
      const tools = listTools();
      log('Available tools:', tools.map(t => t.name));
      // [{ name: 'fetch_jira', description: '...' }, { name: 'run_linter', description: '...' }]
      return { toolCount: tools.length };
```

You can also use `callTool(name, args)` as an alternative to calling tools by name directly:

```javascript
const result = callTool('fetch_jira', { key: 'PROJ-123' });
```

---

## Error Handling

All built-in functions and tools return `"ERROR: ..."` strings on failure instead of throwing exceptions. This makes error handling straightforward:

```javascript
const result = fetch_jira({ key: 'INVALID' });

if (typeof result === 'string' && result.startsWith('ERROR:')) {
  log('Tool failed:', result);
  return { success: false, error: result };
}

return { success: true, data: result };
```

This pattern is consistent across all functions: `schedule()`, `fetch()`, `github()`, `bash()`, custom tools, and MCP tools.

---

## Security Considerations

- **Sandbox Isolation**: Scripts run in a secure sandbox (`@nyariv/sandboxjs`) with no access to `process`, `require`, `fs`, or other Node.js globals
- **`enable_bash`**: Shell execution is disabled by default. Enable only when needed and be aware that bash commands run with the Visor process permissions
- **`enable_fetch`**: HTTP access is disabled by default. Enable only when the script needs to call external APIs
- **`github()`**: Only available when an authenticated Octokit instance exists in the execution context (GitHub Actions). Cannot be enabled manually
- **MCP Servers**: Use `allowedMethods` and `blockedMethods` to restrict which tools a server exposes
- **Tool Inputs**: Global tools with `inputSchema` validate arguments before execution
- **Loop Protection**: `while`, `for`, `for...of`, and `for...in` loops are capped at 10,000 iterations

---

## Examples

### Basic Example

```yaml
checks:
  extract-facts:
    type: command
    exec: node ./scripts/extract-facts.js

  aggregate:
    type: script
    depends_on: [extract-facts]
    content: |
      const facts = outputs['extract-facts'] || [];
      memory.set('total_facts', Array.isArray(facts) ? facts.length : 0, 'fact-validation');
      const allValid = Array.isArray(facts) && facts.every(f => f.valid === true);
      memory.set('all_valid', allValid, 'fact-validation');
      return { total: memory.get('total_facts', 'fact-validation'), allValid };
```

### Using PR Context

```yaml
checks:
  analyze-pr:
    type: script
    content: |
      const largeFiles = pr.files.filter(f => f.additions > 100);
      const totalChanges = pr.totalAdditions + pr.totalDeletions;

      return {
        largeFileCount: largeFiles.length,
        totalChanges,
        isLargePR: totalChanges > 500,
        author: pr.author
      };
```

### Fetching External Data and Labeling

```yaml
checks:
  enrich-pr:
    type: script
    enable_fetch: true
    content: |
      // Fetch deployment status from an external API
      const status = fetch({
        url: 'https://deploy.example.com/api/status/' + pr.head,
        headers: { Authorization: 'Bearer ' + env.DEPLOY_TOKEN }
      });

      if (typeof status === 'string' && status.startsWith('ERROR:')) {
        return { deployed: false, error: status };
      }

      // Label the PR based on deployment status
      if (status.state === 'deployed') {
        github({ op: 'labels.add', values: ['deployed'] });
      }

      return { deployed: status.state === 'deployed', environment: status.env };
```

### Running Tests and Scheduling Follow-up

```yaml
checks:
  test-and-schedule:
    type: script
    enable_bash: true
    content: |
      // Run tests
      const result = bash({
        command: 'npm test -- --coverage --json',
        timeout: 120000
      });

      if (result.exitCode !== 0) {
        // Schedule a retry in 30 minutes
        schedule({
          action: 'create',
          workflow: 'test-and-schedule',
          run_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        });
        return { passed: false, stderr: result.stderr };
      }

      return { passed: true, output: result.stdout };
```

### Multi-Tool Orchestration

```yaml
tools:
  fetch-jira:
    name: fetch-jira
    description: Fetch Jira ticket details
    exec: 'curl -s -H "Authorization: Bearer ${JIRA_TOKEN}" https://jira.example.com/rest/api/2/issue/{{ args.key }}'
    parseJson: true
    inputSchema:
      type: object
      properties:
        key: { type: string }
      required: [key]

checks:
  full-analysis:
    type: script
    enable_fetch: true
    tools:
      - fetch-jira
    mcp_servers:
      github:
        command: github-mcp-server
        args: [--token, "${GITHUB_TOKEN}"]
    content: |
      // Extract Jira key from PR title (e.g., "PROJ-123: Fix bug")
      const match = pr.title.match(/([A-Z]+-\d+)/);
      if (!match) return { jira: null, message: 'No Jira key in PR title' };

      // Fetch Jira ticket using a custom tool
      const ticket = fetch_jira({ key: match[1] });
      if (typeof ticket === 'string' && ticket.startsWith('ERROR:')) {
        return { error: ticket };
      }

      // Get reviewer suggestions from an API
      const reviewers = fetch({
        url: 'https://internal.example.com/api/reviewers',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          component: ticket.fields.components?.[0]?.name,
          files: pr.files.map(f => f.filename)
        })
      });

      // Label PR with Jira status
      github({
        op: 'labels.add',
        values: ['jira:' + ticket.fields.status.name.toLowerCase()]
      });

      return {
        jira: {
          key: match[1],
          summary: ticket.fields.summary,
          status: ticket.fields.status.name
        },
        suggestedReviewers: reviewers?.users || []
      };
```

### Using Output History

```yaml
checks:
  track-retries:
    type: script
    depends_on: [some-check]
    content: |
      // Access all previous outputs from a check
      const history = outputs.history['some-check'] || [];
      const retryCount = history.length;

      log('Retry count:', retryCount);
      log('Previous outputs:', history);

      return {
        retryCount,
        lastOutput: history[history.length - 1]
      };
```

### Using Workflow Inputs

```yaml
# In a workflow file
inputs:
  - name: threshold
    default: 10

checks:
  check-threshold:
    type: script
    content: |
      const threshold = inputs.threshold || 10;
      const count = outputs['counter'].value;

      return {
        passed: count < threshold,
        message: count < threshold
          ? 'Within threshold'
          : `Exceeded threshold of ${threshold}`
      };
```

---

## How Async Works

You don't need to write `async`/`await` yourself. The script engine uses an AST transformer that:

1. Parses your code to find calls to async functions (`schedule`, `fetch`, `github`, `bash`, tool names, MCP tools)
2. Automatically injects `await` before those calls
3. Wraps the script in an `async` IIFE for execution

So this code:

```javascript
const data = fetch({ url: 'https://api.example.com/data' });
const ticket = fetch_jira({ key: 'PROJ-123' });
return { data, ticket };
```

Is transparently transformed to:

```javascript
return (async () => {
  const data = await fetch({ url: 'https://api.example.com/data' });
  const ticket = await fetch_jira({ key: 'PROJ-123' });
  return { data, ticket };
})()
```

Callbacks inside `.map()` are also handled — the transformer marks them as `async` when they contain tool calls.

---

## Related Documentation

- [Custom Tools](./custom-tools.md) - Define reusable command-line tools in YAML
- [AI Custom Tools](./ai-custom-tools.md) - Using custom tools with AI providers
- [MCP Provider](./mcp-provider.md) - Direct MCP tool execution
- [GitHub Operations](./github-ops.md) - Native GitHub operations provider
- [Memory Provider](./memory.md) - Persistent key-value storage
- [Output History](./output-history.md) - Tracking outputs across iterations
- [Dependencies](./dependencies.md) - Step dependency system
- [Liquid Templates](./liquid-templates.md) - Template syntax for other providers
- [Debugging](./debugging.md) - Debugging techniques including the `log()` function
