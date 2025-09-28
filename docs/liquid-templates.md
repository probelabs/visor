# Liquid Templates in Visor

Visor uses [LiquidJS](https://liquidjs.com/) for templating in prompts, commands, and transformations. This enables dynamic content generation based on PR context, check outputs, and environment variables.

## Available Variables

### In Prompts and Commands

- `pr` - Pull request information
  - `pr.number` - PR number
  - `pr.title` - PR title
  - `pr.body` - PR description
  - `pr.author` - PR author username
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
  - Access with: `outputs.checkName`

- `env` - Safe environment variables

- `utils` - Utility functions
  - `utils.timestamp` - Current timestamp
  - `utils.date` - Current date

## Useful Filters

### JSON Serialization

The `json` filter serializes objects to JSON strings, useful for debugging or passing to tools:

```liquid
# Debug output object
{{ outputs | json }}

### Auto‑JSON Access

When a dependency’s output is a JSON string, Visor exposes it as an object automatically in templates:

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
checks:
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
checks:
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
checks:
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

## Troubleshooting

### "[Object]" in output
This means you're trying to output an object directly. Use the `json` filter:
- Wrong: `{{ outputs }}`
- Right: `{{ outputs | json }}`

### Undefined variable errors
Check variable names match exactly (case-sensitive). Use conditional checks:
```liquid
{% if outputs.security %}
  {{ outputs.security | json }}
{% else %}
  No security output available
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
