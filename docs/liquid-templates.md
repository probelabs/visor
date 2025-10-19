# Liquid Templates in Visor

Visor uses [LiquidJS](https://liquidjs.com/) for templating in prompts, commands, and transformations. This enables dynamic content generation based on PR context, check outputs, and environment variables.

## Available Variables

### In Prompts and Commands

- `pr` - Pull request information
  - `pr.number` - PR number
  - `pr.title` - PR title
  - `pr.body` - PR description
  - `pr.author` - PR author username
  - `pr.authorAssociation` - Author's association (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, etc.)
  - `pr.baseBranch` - Target branch
  - `pr.headBranch` - Source branch
  - `pr.totalAdditions` - Lines added
  - `pr.totalDeletions` - Lines removed

- `files` - Array of changed files
  - `files[].filename` - File path
  - `files[].status` - Change type (added, modified, deleted)
  - `files[].additions` - Lines added in this file
  - `files[].deletions` - Lines removed in this file
  - `files[].patch` - Diff content

- `event` - GitHub event context (varies by trigger)

- `outputs` - Results from dependency checks (Map)
  - Access current value: `outputs.checkName`
  - Access history: `outputs.history.checkName` - Array of all previous outputs from this check
  - See [Output History](./output-history.md) for detailed usage in loops, retries, and forEach

- `env` - Safe environment variables

- `utils` - Utility functions
  - `utils.timestamp` - Current timestamp
  - `utils.date` - Current date

## Custom Tags

### Reading Files

The `readfile` tag allows you to include content from files within your templates:

```liquid
# Read a file by path
{% readfile "config/settings.json" %}

# Read using a variable
{% readfile configPath %}

# Use in conditionals
{% if includeConfig %}
  Config: {% readfile "config.yaml" %}
{% endif %}

# Use in loops
{% for file in configFiles %}
  {% readfile file %}
{% endfor %}
```

### Parsing JSON from Files

You can read JSON files and parse them into objects using the `parse_json` filter:

```liquid
# Read and parse JSON, then access properties
{% capture config_json %}{% readfile "config.json" %}{% endcapture %}
{% assign config = config_json | parse_json %}
Version: {{ config.version }}
Name: {{ config.name }}

# Use parsed JSON in conditionals
{% if config.enabled %}
  Feature is enabled
{% endif %}

# Iterate over arrays from JSON
{% for item in config.items %}
  - {{ item.name }}: {{ item.value }}
{% endfor %}

# Combine with other filters
{% assign pkg = '{% readfile "package.json" %}' | parse_json %}
Dependencies: {{ pkg.dependencies | json }}
```

**Security notes:**
- Files are read relative to the project root
- Directory traversal attempts are blocked
- Absolute paths are not allowed
- Invalid JSON returns the original string

## Useful Filters

### JSON Serialization

The `json` filter serializes objects to JSON strings, useful for debugging or passing to tools:

```liquid
# Debug output object
{{ outputs | json }}

### Author Permission Filters

> **📖 For complete documentation, see [Author Permissions Guide](./author-permissions.md)**

Check the PR author's permission level in Liquid templates using filters:

```liquid
# Check if author has at least MEMBER permission
{% if pr.authorAssociation | has_min_permission: "MEMBER" %}
  Running quick scan for trusted member...
{% else %}
  Running full security scan for external contributor...
{% endif %}

# Check specific permission levels
{% if pr.authorAssociation | is_owner %}
  🎖️ Repository owner
{% elsif pr.authorAssociation | is_member %}
  👥 Organization member
{% elsif pr.authorAssociation | is_collaborator %}
  🤝 Collaborator
{% elsif pr.authorAssociation | is_first_timer %}
  🎉 First-time contributor - Welcome!
{% endif %}

# Use in prompts
{% if pr.authorAssociation | is_member %}
  Review this PR from team member {{ pr.author }}.
  Focus on logic and design patterns.
{% else %}
  Review this PR from external contributor {{ pr.author }}.
  Pay extra attention to security and best practices.
{% endif %}

# Conditional commands
{% if pr.authorAssociation | has_min_permission: "COLLABORATOR" %}
gh pr review --approve
{% else %}
gh pr review --comment --body "Thanks! A maintainer will review soon."
{% endif %}
```

**Available filters:**
- `has_min_permission: "LEVEL"` - Check if >= permission level
- `is_owner` - Repository owner
- `is_member` - Organization member or owner
- `is_collaborator` - Collaborator or higher
- `is_contributor` - Has contributed before
- `is_first_timer` - First-time contributor

### Auto‑JSON Access

When a dependency's output is a JSON string, Visor exposes it as an object automatically in templates:

```liquid
# If `fetch-tickets` printed '{"tickets":[{"key":"TT-101"}]}'
Ticket key: {{ outputs['fetch-tickets'].tickets[0].key }}
# No JSON.parse required
```

If the underlying value is plain text, it behaves as a normal string.

# Debug specific check output
{{ outputs.security | json }}

# Pass to command safely
echo '{{ pr | json }}' | jq .

# Create JSON payload
{
  "title": {{ pr.title | json }},
  "files": {{ files | json }},
  "outputs": {{ outputs | json }}
}
```

### String Filters

```liquid
{{ pr.title | escape }}        # HTML escape
{{ pr.title | upcase }}        # Uppercase
{{ pr.title | downcase }}      # Lowercase
{{ pr.title | capitalize }}    # Capitalize first letter
{{ pr.title | truncate: 50 }}  # Truncate to 50 chars
```

### Array Filters

```liquid
{{ files | size }}              # Count of files
{{ files | first }}             # First file
{{ files | last }}              # Last file
{{ files | map: "filename" }}   # Array of filenames
```

## Examples

### Debugging Outputs

When you see `[Object]` in your templates, use the `json` filter:

```yaml
steps:
  debug-outputs:
    type: log
    message: |
      Raw outputs object: {{ outputs }}
      JSON serialized: {{ outputs | json }}

      Specific check output:
      {{ outputs.security | json }}
```

### Conditional Content

```liquid
{% if pr.totalAdditions > 500 %}
  Large PR detected with {{ pr.totalAdditions }} additions.
{% endif %}

{% for file in files %}
  {% if file.status == "added" %}
    New file: {{ file.filename }}
  {% endif %}
{% endfor %}
```

### Safe Command Execution

```yaml
steps:
  analyze-with-tool:
    type: command
    exec: |
      # Use json filter for safe data passing
      echo '{{ pr | json }}' > /tmp/pr-data.json
      echo '{{ outputs | json }}' > /tmp/outputs.json

      # Process with external tool
      my-analyzer --pr-file /tmp/pr-data.json --outputs /tmp/outputs.json
```

### Transform Responses

```yaml
steps:
  http-webhook:
    type: http_input
    transform: |
      {
        "processed": true,
        "original": {{ data | json }},
        "pr_context": {{ pr | json }}
      }
```

## Best Practices

1. **Use `json` filter for debugging**: When you need to inspect complex objects
2. **Escape user input**: Use appropriate filters (`escape`, `json`) when including user content
3. **Validate before parsing**: When transforming to JSON, ensure valid syntax
4. **Keep templates readable**: Use proper indentation and comments

## Debugging Techniques

### Using the `json` Filter for Inspection

The `json` filter is your primary debugging tool for inspecting data structures:

```liquid
# Debug all available outputs
All outputs: {{ outputs | json }}

# Debug specific dependency output
Fetch result: {{ outputs["fetch-tickets"] | json }}

# Debug PR context
PR info: {{ pr | json }}

# Debug environment variables
Environment: {{ env | json }}
```

### Debugging in JavaScript Expressions

When using `transform_js` or conditions (`if`, `fail_if`), use the `log()` function:

```yaml
steps:
  my-check:
    type: command
    exec: curl -s https://api.example.com/data
    transform_js: |
      log("Raw output:", output);
      const data = JSON.parse(output);
      log("Parsed data:", data);
      return data.items;
```

See the [Debugging Guide](./debugging.md) for comprehensive debugging techniques.

## Troubleshooting

### "[Object]" in output
This means you're trying to output an object directly. Use the `json` filter:
- Wrong: `{{ outputs }}`
- Right: `{{ outputs | json }}`

### Undefined variable errors
Check variable names match exactly (case-sensitive). Use conditional checks:
```liquid
{% if outputs.security %}
  Security data: {{ outputs.security | json }}
{% else %}
  No security output available
{% endif %}
```

### Debugging missing outputs
```liquid
# Check what outputs are available
Available outputs: {{ outputs | json }}

# Check specific output existence
{% if outputs["fetch-data"] %}
  Data found: {{ outputs["fetch-data"] | json }}
{% else %}
  Warning: fetch-data output not found.
  Available keys: {% for key in outputs %}{{ key }}{% unless forloop.last %}, {% endunless %}{% endfor %}
{% endif %}
```

### JSON parsing errors
Ensure proper escaping when creating JSON:
```liquid
{
  "title": {{ pr.title | json }},  ✓ Properly escaped
  "title": "{{ pr.title }}"        ✗ May break with quotes in title
}
```
