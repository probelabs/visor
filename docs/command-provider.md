# Command Provider Documentation

The `command` provider executes shell commands and captures their output for processing. It's useful for integrating external tools, running tests, performing custom validations, or gathering system information.

## Basic Usage

```yaml
steps:
  my-command-check:
    type: command
    exec: "npm test"
```

## Features

- **Shell command execution** - Run any shell command
- **JSON output parsing** - Automatically parses JSON output
- **Liquid templating** - Use variables in commands and transforms
- **Dependency support** - Access outputs from other checks
- **Environment variables** - Pass custom environment variables
- **Output transformation** - Transform command output using Liquid templates

## Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `type` | string | Yes | Must be `"command"` |
| `exec` | string | Yes | The shell command to execute |
| `transform` | string | No | Liquid template to transform output |
| `transform_js` | string | No | JavaScript expression to transform output (evaluated in sandbox) |
| `env` | object | No | Environment variables to pass to the command |
| `timeout` | number | No | Command timeout in seconds (default: 60) |
| `depends_on` | array | No | Other checks this depends on |
| `forEach` | object | No | Run command for each item in a collection |
| `group` | string | No | Group name for organizing results |
| `on` | array | No | Events that trigger this check |
| `tags` | array | No | Tags for filtering checks |

## Auto‑JSON Access (no JSON.parse needed)

Visor automatically parses command stdout when it contains valid JSON and exposes it in templates and `transform_js` without requiring `JSON.parse(...)`.

- In Liquid templates: `{{ output.key }}` and `{{ outputs['some-check'].key }}` work directly when the underlying string is JSON.
- In JavaScript transforms: you can write `output.items` instead of `JSON.parse(output).items`.
- Backward compatible: `JSON.parse(output)` still works if you prefer it.

Examples:

```yaml
steps:
  fetch-tickets:
    type: command
    exec: |
      echo '{"tickets":[{"key":"TT-101"},{"key":"TT-102"}]}'
    transform_js: |
      output.tickets      # no JSON.parse required
    forEach: true

  analyze-ticket:
    type: command
    depends_on: [fetch-tickets]
    exec: |
      echo "Processing {{ outputs['fetch-tickets'].key }} (index in batch)"
```

If the command prints plain text (not JSON), `output` behaves as a normal string.

## Examples

### Basic Command Execution

```yaml
steps:
  lint:
    type: command
    exec: "npm run lint"
    group: quality
    on: [pr_opened, pr_updated]
```

### JSON Output Parsing

Commands that output JSON will be automatically parsed:

```yaml
steps:
  security-audit:
    type: command
    exec: "npm audit --json"
    group: security
```

### Using Liquid Templates

The `exec` field fully supports Liquid templating for dynamic command generation. Templates are processed before command execution.

```yaml
steps:
  branch-check:
    type: command
    exec: "git diff {{ pr.base }}..{{ pr.branch }} --stat"
    group: analysis
```

Available template variables:
- `pr.number` - Pull request number
- `pr.title` - Pull request title
- `pr.author` - Pull request author
- `pr.branch` - Source branch (head)
- `pr.base` - Target branch (base)
- `files` - Array of changed files
- `fileCount` - Number of changed files
- `env` - Safe environment variables (see Security section)
- `outputs.<check_name>` - Outputs from dependency checks

### Using Dependencies

Access outputs from other checks:

```yaml
steps:
  get-version:
    type: command
    exec: "node -p 'require(\"./package.json\").version'"

  tag-release:
    type: command
    exec: "git tag v{{ outputs.get_version }}"
    depends_on: [get-version]
```

### Transform Output

Transform command output using Liquid templates (see [Liquid Templates Guide](./liquid-templates.md) for full reference):

```yaml
steps:
  test-coverage:
    type: command
    exec: "npm test -- --coverage --json"
    transform: |
      {
        "coverage": {{ output.coverageMap | json }},
        "summary": "Coverage: {{ output.coverageSummary.total.lines.pct }}%"
      }
```

### Reading Files in Templates

You can read file content directly in your command templates:

```yaml
steps:
  check-config:
    type: command
    exec: |
      # Include config file content in command
      CONFIG='{% readfile "config.json" %}'
      echo "$CONFIG" | jq '.version'

  validate-schema:
    type: command
    exec: |
      # Read and validate against schema
      SCHEMA='{% readfile "schema.json" %}'
      DATA='{% readfile "data.json" %}'
      ajv validate -s <(echo "$SCHEMA") -d <(echo "$DATA")
```

### JavaScript Transform

Transform command output using JavaScript expressions (evaluated in secure sandbox):

```yaml
steps:
  # Extract specific fields using JavaScript
  extract-vulnerabilities:
    type: command
    exec: "security-scan --json"
    transform_js: |
      output.vulnerabilities.filter(v => v.severity === 'critical')
    forEach: true

  # Complex data manipulation
  aggregate-metrics:
    type: command
    exec: "get-metrics --json"
    transform_js: |
      ({
        total: output.metrics.reduce((sum, m) => sum + m.value, 0),
        average: output.metrics.reduce((sum, m) => sum + m.value, 0) / output.metrics.length,
        critical: output.metrics.filter(m => m.level === 'critical').map(m => m.name)
      })

  # Array extraction with conditions
  get-failed-tests:
    type: command
    exec: "npm test --json"
    transform_js: |
      output.tests
        .filter(t => !t.passed)
        .map(t => ({ name: t.name, error: t.error }))

  # Combine with Liquid transform (Liquid runs first, then JavaScript)
  process-data:
    type: command
    exec: "api-call --json"
    transform: |
      {{ output.data | json }}
    transform_js: |
      output.filter(item => item.active && item.priority > 5)
```

**Available in JavaScript transform context:**
- `output` - The command output (or result of Liquid transform if present)
- `pr` - Pull request context (number, title, author, branch, base)
- `files` - Array of changed files
- `outputs` - Results from dependency checks
- `env` - Environment variables
- `log()` - Debug function that prints to console with 🔍 prefix

**Debugging JavaScript transforms:**
```yaml
steps:
  debug-transform:
    type: command
    exec: "echo '{\"items\":[1,2,3]}'"
    transform_js: |
      log("Raw output:", output);
      const data = JSON.parse(output);
      log("Parsed data:", data);
      log("Item count:", data.items.length);
      return data.items;
```
- `JSON` - JSON object for parsing/stringifying

### Environment Variables

You can use environment variables in three ways:

#### 1. Shell Variable Expansion (Recommended for defaults)
```yaml
steps:
  jira-query:
    type: command
    exec: |
      # Shell expansion with defaults
      JQL="${VISOR_JQL:-project = MYPROJ}"
      LIMIT="${VISOR_LIMIT:-10}"

      curl -s "https://jira.example.com/rest/api/2/search?jql=${JQL}&maxResults=${LIMIT}"
```

#### 2. Liquid Templates
```yaml
steps:
  api-check:
    type: command
    exec: |
      curl "{{ env.API_URL | default: 'https://api.example.com' }}/status"
```

#### 3. Custom Environment Variables
```yaml
steps:
  integration-test:
    type: command
    exec: "npm run test:integration"
    env:
      NODE_ENV: test
      API_URL: https://api.example.com
      TIMEOUT: "30000"
```

**Note**: Commands inherit all parent process environment variables. Custom `env` values override inherited ones.

### For Each Execution

Run a command for each item in a collection:

```yaml
steps:
  validate-files:
    type: command
    exec: "jsonlint {{ item }}"
    forEach:
      items: "{{ files | where: 'extension', '.json' }}"
    group: validation
```

### Conditional Execution

Run checks only under certain conditions:

```yaml
steps:
  deploy-check:
    type: command
    exec: "npm run deploy:dry-run"
    on: [pr_opened]
    if: "pr.base == 'main'"
    tags: [deployment, validation]
```

### Timeout Configuration

Configure longer timeouts for commands that take more time:

```yaml
steps:
  build-project:
    type: command
    exec: "npm run build"
    timeout: 300  # 5 minutes
    group: build

  quick-lint:
    type: command
    exec: "eslint src/"
    timeout: 30   # 30 seconds
    group: quality

  long-test-suite:
    type: command
    exec: "npm run test:e2e"
    timeout: 600  # 10 minutes
    group: testing
```

### Complex Example

A comprehensive example combining multiple features:

```yaml
steps:
  # First, get dependencies that need updating
  outdated-deps:
    type: command
    exec: "npm outdated --json || true"
    timeout: 120  # 2 minutes for npm operations
    group: dependencies
    tags: [dependencies, maintenance]

  # Then check for security issues in those dependencies
  security-check:
    type: command
    exec: |
      if [ -n '{{ outputs.outdated_deps }}' ]; then
        npm audit --json
      else
        echo '{"vulnerabilities": {}}'
      fi
    depends_on: [outdated-deps]
    timeout: 180  # 3 minutes for audit
    transform: |
      {
        "critical": {{ output.metadata.vulnerabilities.critical | default: 0 }},
        "high": {{ output.metadata.vulnerabilities.high | default: 0 }},
        "message": "Found {{ output.metadata.vulnerabilities.total | default: 0 }} vulnerabilities"
      }
    group: security
    tags: [security, dependencies]
```

## Error Handling

The command provider handles errors gracefully:

1. **Command failures** - Non-zero exit codes are captured as errors
2. **Timeout** - Commands timeout after 60 seconds by default
3. **Buffer limits** - Output is limited to 10MB
4. **Transform errors** - Invalid transforms are reported as issues

Example error output:
```json
{
  "issues": [
    {
      "file": "command",
      "line": 0,
      "ruleId": "command/execution_error",
      "message": "Command execution failed: npm test exited with code 1",
      "severity": "error",
      "category": "logic"
    }
  ]
}
```

## Security Considerations

### ⚠️ CRITICAL: Command Injection Prevention

**NEVER use uncontrolled user input directly in commands!** This includes PR titles, branch names, commit messages, or any other user-provided data.

#### ❌ DANGEROUS - Command Injection Vulnerable
```yaml
# DON'T DO THIS - PR title could contain malicious commands
steps:
  bad-example:
    type: command
    exec: "echo 'Reviewing: {{ pr.title }}'"  # VULNERABLE!
    # If pr.title is: '; rm -rf / #
    # Command becomes: echo 'Reviewing: '; rm -rf / #'
```

#### ✅ SAFE - Properly Escaped
```yaml
steps:
  # Option 1: Use Liquid filters to escape
  safe-echo:
    type: command
    exec: "echo 'Reviewing: {{ pr.title | escape }}'"

  # Option 2: Pass as environment variable (shell handles escaping)
  safe-with-env:
    type: command
    exec: |
      PR_TITLE="{{ pr.title }}"
      echo "Reviewing: $PR_TITLE"

  # Option 3: Use JSON encoding for complex data
  safe-json:
    type: command
    exec: |
      cat << 'EOF' | jq .
      {
        "title": {{ pr.title | json }},
        "author": {{ pr.author | json }}
      }
      EOF

  # Option 4: Avoid user input entirely
  safest:
    type: command
    exec: "echo 'PR #{{ pr.number }} needs review'"  # number is safe
```

### Input Sanitization Examples

#### Handling File Paths
```yaml
steps:
  # DANGEROUS - file names could contain special characters
  bad-lint:
    type: command
    exec: "eslint {{ files | join: ' ' }}"  # VULNERABLE!

  # SAFE - quote each file properly
  safe-lint:
    type: command
    exec: |
      {% for file in files %}
      eslint "{{ file | escape }}"
      {% endfor %}
```

#### Working with Branch Names
```yaml
steps:
  # DANGEROUS
  bad-branch:
    type: command
    exec: "git checkout {{ pr.branch }}"  # VULNERABLE!

  # SAFE - use quotes and escape
  safe-branch:
    type: command
    exec: "git checkout '{{ pr.branch | escape }}'"
```

### Additional Security Best Practices

1. **Environment Variables in Liquid** - Only safe environment variables are exposed in Liquid templates:
   - Allowed prefixes: `CI_`, `GITHUB_`, `RUNNER_`, `NODE_`, `npm_`
   - Always available: `PATH`, `HOME`, `USER`, `PWD`
   - All others are filtered out for security

2. **Shell Environment** - Commands inherit the full process environment, so shell expansion (`$VAR`) has access to all variables

3. **Secrets Management**:
   ```yaml
   checks:
     # BAD - Don't echo secrets
     bad-secret:
       type: command
       exec: "echo $API_KEY"  # DON'T DO THIS

     # GOOD - Use secrets safely
     good-secret:
       type: command
       exec: "curl -H 'Authorization: Bearer $API_KEY' https://api.example.com"
   ```

4. **File System Access** - Commands run with the same permissions as the visor process:
   ```yaml
   checks:
     # Be careful with file operations
     file-check:
       type: command
       exec: |
         # Validate path is within project
         FILE="{{ files[0] | escape }}"
         if [[ "$FILE" == *".."* ]]; then
           echo "Invalid file path"
           exit 1
         fi
         cat "$FILE"
   ```

5. **Timeout Protection** - Commands timeout after 60 seconds by default (configurable via `timeout` field)
6. **Output Limits** - Command output is limited to 10MB to prevent memory exhaustion

## Integration with Other Providers

The command provider works well with other providers:

```yaml
steps:
  # Run tests first
  test:
    type: command
    exec: "npm test -- --json"
    group: quality

  # Then analyze results with AI
  test-analysis:
    type: ai
    prompt: |
      Analyze these test results and identify patterns:
      {{ outputs.test | json }}
    depends_on: [test]
    group: analysis
```

## Tips and Best Practices

1. **Use JSON output** when possible for better integration
2. **Set appropriate groups** to organize related checks
3. **Use tags** for filtering check execution
4. **Handle errors gracefully** - consider using `|| true` for info-mode commands
5. **Keep commands simple** - complex logic should be in scripts
6. **Use dependencies** to chain related commands
7. **Set timeouts** for long-running commands if needed
8. **Test locally** using the CLI before deploying

## Common Use Cases

- **Running tests**: `npm test`, `pytest`, `go test`
- **Linting**: `eslint`, `ruff`, `golangci-lint`
- **Security scanning**: `npm audit`, `safety check`, `gosec`
- **Build verification**: `npm run build`, `make`, `cargo build`
- **Documentation generation**: `typedoc`, `sphinx-build`
- **Deployment checks**: `terraform plan`, `kubectl diff`
- **Custom validations**: Any shell script or command

## Comparison with Script Provider

Note: There is no "script" provider. The `command` provider is used for executing shell commands. If you see references to a "script" type in error messages or old documentation, use `type: command` instead.
