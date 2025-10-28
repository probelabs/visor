# Test Runner Troubleshooting

Common issues and how to fix them quickly.

## “Unmocked AI step executed” warnings

- The runner forces `ai_provider=mock` by default, but if a step overrides the provider to a real one, it can execute with keys from your env.
- Add a mock under `mocks:` for that step to silence the warning, or keep `ai_provider: mock` and avoid overriding providers in tests.

## “No captured prompt for step … at index …”

- The step may not have executed in that stage (strict mode would also flag it).
- Your `index` might be out of bounds (e.g., `last` when there are no prompts). Drop the `index` or use `where` to select by content.
- Ensure the step is an AI provider (prompts are only captured for AI steps).

## GitHub op not recorded (e.g., `labels.add`)

- Check that your AI mock provides the fields your provider expects to do the op (e.g., `overview.tags.label`).
- Use `VISOR_DEBUG=true` to print provider debug. Confirm the step ran and the recorder printed the intended op.

## Strict mode failure (“Step executed without expect”)

- Add the missing step to `expect.calls` with a count. If the step should not run, add it to `expect.no_calls` and fix your config to avoid running it.
- Temporarily set `strict: false` at the case or stage level to iterate quickly (not recommended long term).

## Fact validation behaves unexpectedly

- Provide array mocks for `extract-facts` and per‑call list mocks for `validate-fact[]`.
- Remember that aggregation uses the latest validation wave (size inferred from the last `extract-facts` output).

## Prompts are huge or contain entire diffs

- Use `--prompt-max-chars` (or `tests.defaults.prompt_max_chars`) to truncate captured text for assertions.
- In config, you can keep AI focused with `skip_code_context` if available, or provide narrower mocks in tests.

## How do I see more logs?

- Set `VISOR_DEBUG=true`.
- To isolate the problem, run a single stage: `visor test --only case#stage`.

