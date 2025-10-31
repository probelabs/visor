## Script step (type: `script`)

The `script` provider executes JavaScript in a secure sandbox with access to
PR context, dependency outputs, and the Visor memory store.

- Use `type: script` with a `content` block containing your code.
- The sandbox exposes these objects:
  - `pr`: basic PR metadata and file list.
  - `outputs`: map of dependency outputs (plus `outputs.history`).
  - `outputs_raw`: aggregated values from `-raw` dependencies.
  - `outputs_history_stage`: per-stage output history slice for tests.
  - `memory`: synchronous helpers `get`, `set`, `append`, `increment`, `delete`, `clear`.
- The value you `return` becomes this step’s `output` (for `depends_on`).

Example:

```yaml
steps:
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

The script context and memory helpers mirror other providers’ contexts.
