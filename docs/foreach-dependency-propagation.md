# ForEach output: validation and dependent propagation

This doc clarifies how `forEach` output is validated and how it affects dependent checks.

## Valid and invalid outputs

- `transform_js` or provider output must resolve to a value. If it is `undefined`, the engine emits an error:
  - Issue: `forEach/undefined_output`
  - Effect: direct dependents are skipped (`dependency_failed`).
- If the value is an array, the engine iterates items.
- If the value is a string, the engine tries to JSON.parse it; if it parses to an array, that array is used; otherwise it treats the string as a single item.
- If the value is `null`, it is normalized to an empty array (0 iterations).

## Empty arrays vs undefined

- `[]` (empty array): valid — the check runs zero iterations. Dependents that rely on items are effectively skipped (no provider execution), and you’ll see a log like:

```
forEach: no items from "fetch-tickets", skipping check...
```

- `undefined`: invalid — treated as a configuration/transform error. The engine emits a `forEach/undefined_output` issue and skips direct dependents.

## Example

```yaml
steps:
  fetch-tickets:
    type: command
    exec: echo '{"tickets": []}'
    transform_js: JSON.parse(output).tickets
    forEach: true

  analyze-ticket:
    type: command
    depends_on: [fetch-tickets]
    exec: echo "TICKET: {{ outputs['fetch-tickets'].key }}"
```

- If `tickets` is `[]`, `analyze-ticket` is effectively skipped (no per‑item execution).
- If `transform_js` returns `undefined`, the engine raises `forEach/undefined_output` and `analyze-ticket` is skipped due to a failed dependency.

## Output History with forEach

When a check has `forEach: true`, each iteration's output is tracked in `outputs.history`. After processing multiple items, `outputs.history['check-name']` will contain an array with one entry per iteration.

```yaml
steps:
  process-items:
    type: memory
    depends_on: [fetch-tickets]
    forEach: true
    operation: exec_js
    memory_js: |
      return { itemId: item.key, processed: true };

  summarize:
    type: memory
    depends_on: [process-items]
    operation: exec_js
    memory_js: |
      // Access all forEach iteration results
      const allProcessed = outputs.history['process-items'];
      return { totalProcessed: allProcessed.length };
```

See [Output History](./output-history.md) for more details on tracking outputs across iterations.

## Tips

- Always `return` from `transform_js`. Missing `return` is the most common cause of `undefined`.
- Prefer returning arrays directly from `transform_js` (avoid stringifying) to keep types clear and avoid parsing surprises.
- Use `outputs.history` to access all forEach iteration results in dependent checks.

