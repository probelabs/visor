# forEach with Dependencies and transform_js

This document explains how to use `forEach` with `transform_js` to process arrays and pass individual items to dependent checks.

## Overview

When a check uses `forEach` with `transform_js`, it can extract and transform arrays from command output, and dependent checks will receive individual items from that array.

## Basic Usage

### Simple Array Processing

```yaml
checks:
  fetch-items:
    type: command
    exec: echo '[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]'
    transform_js: output
    forEach: true

  process-item:
    type: command
    depends_on: [fetch-items]
    exec: |
      echo "Processing {{ outputs['fetch-items'].name }} with ID {{ outputs['fetch-items'].id }}"
```

In this example:
- `fetch-items` returns a JSON array and uses `transform_js` to parse it
- `forEach: true` tells Visor to iterate over the array
- `process-item` depends on `fetch-items` and will be executed once for each item
- Each execution receives one item from the array

### Extracting Nested Arrays

```yaml
checks:
  fetch-data:
    type: command
    exec: |
      echo '{"status":"ok","users":[{"id":1,"active":true},{"id":2,"active":false}]}'
    transform_js: |
      output.users
    forEach: true

  check-user:
    type: command
    depends_on: [fetch-data]
    exec: |
      if [ "{{ outputs['fetch-data'].active }}" = "true" ]; then
        echo "User {{ outputs['fetch-data'].id }} is active"
      else
        echo "User {{ outputs['fetch-data'].id }} is inactive"
      fi
```

## Raw Array Access

Sometimes you need access to both the current item AND the full array. Visor provides a special `-raw` key for this purpose.

### Accessing the Full Array

```yaml
checks:
  fetch-items:
    type: command
    exec: echo '[{"id":1,"value":10},{"id":2,"value":20},{"id":3,"value":30}]'
    transform_js: output
    forEach: true

  analyze-item:
    type: command
    depends_on: [fetch-items]
    exec: |
      # Access current item
      current_value="{{ outputs['fetch-items'].value }}"

      # Access full array via -raw key
      total_count="{{ outputs['fetch-items-raw'] | size }}"

      # Access specific item from full array
      first_value="{{ outputs['fetch-items-raw'][0].value }}"

      # Calculate position
      echo "Processing item with value $current_value (1 of $total_count)"
      echo "Difference from first: $((current_value - first_value))"
```

### Comparing with Other Items

```yaml
checks:
  fetch-scores:
    type: command
    exec: echo '[{"name":"Alice","score":85},{"name":"Bob","score":92},{"name":"Charlie","score":78}]'
    transform_js: output
    forEach: true

  compare-score:
    type: command
    depends_on: [fetch-scores]
    exec: |
      # Current person's score
      current_score="{{ outputs['fetch-scores'].score }}"
      current_name="{{ outputs['fetch-scores'].name }}"

      # Calculate average from all scores
      {% assign total = 0 %}
      {% for person in outputs['fetch-scores-raw'] %}
        {% assign total = total | plus: person.score %}
      {% endfor %}
      {% assign avg = total | divided_by: outputs['fetch-scores-raw'].size %}

      if [ "$current_score" -gt "$avg" ]; then
        echo "$current_name scored above average ($current_score vs $avg)"
      else
        echo "$current_name scored below average ($current_score vs $avg)"
      fi
```

## Complex Transformations

### Flattening Nested Structures

```yaml
checks:
  fetch-groups:
    type: command
    exec: |
      echo '{
        "groups": [
          {"name": "TeamA", "members": [{"id": "u1", "role": "dev"}, {"id": "u2", "role": "qa"}]},
          {"name": "TeamB", "members": [{"id": "u3", "role": "dev"}]}
        ]
      }'
    transform_js: |
      const data = JSON.parse(output);
      const flattened = [];
      data.groups.forEach(group => {
        group.members.forEach(member => {
          flattened.push({
            team: group.name,
            userId: member.id,
            role: member.role
          });
        });
      });
      flattened
    forEach: true

  check-member:
    type: command
    depends_on: [fetch-groups]
    exec: |
      echo "User {{ outputs['fetch-groups'].userId }} is a {{ outputs['fetch-groups'].role }} in {{ outputs['fetch-groups'].team }}"
```

### Filtering and Transforming

```yaml
checks:
  fetch-issues:
    type: command
    exec: |
      gh api repos/owner/repo/issues --jq '.[].{number,title,state,labels}'
    transform_js: |
      const issues = JSON.parse(output);
      // Only process open bugs
      issues.filter(issue =>
        issue.state === 'open' &&
        issue.labels.some(label => label.name === 'bug')
      ).map(issue => ({
        number: issue.number,
        title: issue.title,
        labelCount: issue.labels.length
      }))
    forEach: true

  analyze-bug:
    type: command
    depends_on: [fetch-issues]
    exec: |
      echo "Bug #{{ outputs['fetch-issues'].number }}: {{ outputs['fetch-issues'].title }}"
      echo "Has {{ outputs['fetch-issues'].labelCount }} labels"
      echo "Total open bugs: {{ outputs['fetch-issues-raw'] | size }}"
```

## Error Handling

### Invalid JSON

If `transform_js` encounters an error (e.g., invalid JSON), it will report an error issue:

```yaml
checks:
  fetch-invalid:
    type: command
    exec: echo "not valid json"
    transform_js: JSON.parse(output)  # This will fail
    forEach: true
```

Result: An issue with `ruleId: command/transform_js_error`

### Empty Arrays

Empty arrays are handled gracefully - dependent checks simply won't execute:

```yaml
checks:
  fetch-empty:
    type: command
    exec: echo '{"items":[]}'
    transform_js: JSON.parse(output).items
    forEach: true

  process-item:
    type: command
    depends_on: [fetch-empty]
    exec: echo "This won't run"
```

### Non-Array Results

If `transform_js` returns a non-array value, it's automatically wrapped in an array:

```yaml
checks:
  fetch-single:
    type: command
    exec: echo '{"item":{"id":1}}'
    transform_js: JSON.parse(output).item  # Returns object, not array
    forEach: true

  process-single:
    type: command
    depends_on: [fetch-single]
    exec: echo "Processing {{ outputs['fetch-single'].id }}"  # Works fine
```

## Best Practices

1. **Always validate JSON before parsing**: Consider using try-catch in transform_js
2. **Use descriptive check names**: They become the keys in `outputs`
3. **Document expected array structure**: Add comments explaining the data format
4. **Handle empty arrays gracefully**: Dependent checks won't run for empty arrays
5. **Use `-raw` sparingly**: Only when you need aggregate information

## Common Use Cases

### Processing JIRA Tickets

```yaml
checks:
  fetch-tickets:
    type: command
    exec: |
      curl -s -H "Authorization: Bearer $JIRA_TOKEN" \
        "https://jira.example.com/rest/api/2/search?jql=project=MYPROJ"
    transform_js: |
      JSON.parse(output).issues.map(issue => ({
        key: issue.key,
        summary: issue.fields.summary,
        priority: issue.fields.priority.name,
        assignee: issue.fields.assignee?.displayName || 'Unassigned'
      }))
    forEach: true

  analyze-ticket:
    type: command
    depends_on: [fetch-tickets]
    exec: |
      echo "Analyzing {{ outputs['fetch-tickets'].key }}: {{ outputs['fetch-tickets'].summary }}"
      echo "Priority: {{ outputs['fetch-tickets'].priority }}"
      echo "Total tickets in batch: {{ outputs['fetch-tickets-raw'] | size }}"
```

### Processing Test Results

```yaml
checks:
  get-test-results:
    type: command
    exec: npm test --json
    transform_js: |
      const results = JSON.parse(output);
      results.testResults.flatMap(suite =>
        suite.assertionResults.filter(test => test.status === 'failed')
          .map(test => ({
            suite: suite.name,
            test: test.title,
            error: test.failureMessages[0]
          }))
      )
    forEach: true

  report-failure:
    type: command
    depends_on: [get-test-results]
    exec: |
      echo "❌ Test failure in {{ outputs['get-test-results'].suite }}"
      echo "   Test: {{ outputs['get-test-results'].test }}"
      echo "   Error: {{ outputs['get-test-results'].error | truncate: 100 }}"
```

### Batch Processing Files

```yaml
checks:
  find-large-files:
    type: command
    exec: |
      find . -type f -size +1M -exec stat -c '%s %n' {} \; | head -20
    transform_js: |
      output.split('\n').filter(line => line.trim())
        .map(line => {
          const [size, ...pathParts] = line.split(' ');
          return {
            path: pathParts.join(' '),
            sizeMB: (parseInt(size) / 1048576).toFixed(2)
          };
        })
    forEach: true

  check-file:
    type: command
    depends_on: [find-large-files]
    exec: |
      echo "Large file: {{ outputs['find-large-files'].path }} ({{ outputs['find-large-files'].sizeMB }} MB)"
      echo "Total large files found: {{ outputs['find-large-files-raw'] | size }}"
```

## See Also

- [Command Provider Documentation](./command-provider.md)
- [Dependencies Documentation](./dependencies.md)
- [Liquid Templates Documentation](./liquid-templates.md)
