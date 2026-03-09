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

- Use the `--debug` CLI flag or set `VISOR_DEBUG=true`.
- To isolate the problem, run a single stage: `visor test --only case#stage` (name substring match) or `--only case#N` (1-based index).
- Example: `visor test --debug --only pr-review-e2e-flow#facts-invalid`

## Pause at “on_finish: no result found … — skip”

Symptom: a short pause appears before the runner prints the coverage table, often preceded by a line like:

```
⏭ on_finish: no result found for "extract-facts" — skip
```

What it was: the engine always entered the `on_finish` scan, even when none of the forEach parents had produced any results in the current run. Internally it waited for a (now redundant) scan window to complete.

What we changed: we added an early return in `handleOnFinishHooks` when there are zero forEach parents with results in the current grouped run. This preserves behavior (no hooks to run) and removes the delay entirely.

Downsides: none functionally. The only trade‑off is that debug visibility is slightly reduced in that specific “no parents ran” case; enable `VISOR_DEBUG=true` if you need to trace the discovery step regardless.

Guarantee: if a check executed and defines `on_finish`, `on_finish` still executes for that check once its forEach finishes. The early return only triggers when no eligible parent produced results in the run.

## Mock structure does not match expected output

- Ensure mock shapes match what the step schema expects. For AI steps with a schema, provide structured fields directly (not wrapped in `returns:`).
- For command/HTTP provider steps, include `stdout`, `exit_code`, `status`, or `body` as appropriate.
- Review [Fixtures and Mocks](./fixtures-and-mocks.md) for detailed mock examples.

## Flow stage fails unexpectedly

- Each stage computes coverage as a delta from the previous stage. If a step from a prior stage executes again, you need to account for it in the current stage's `expect.calls`.
- Check that mocks are merged correctly: stage mocks override flow-level mocks (`{...flow.mocks, ...stage.mocks}`).
- Use `--only case#stage` to isolate and debug a single stage.

## CI test runs slower than expected

- Ensure `ai_provider: mock` is set in `tests.defaults` for offline, fast execution.
- Use `--max-parallel` to run cases concurrently within a suite.
- Use `--max-suites` when running multiple test files.
- Consider `--prompt-max-chars` to reduce memory usage for large diffs.

## Tests pass locally but fail in CI

- Check for environment variable differences. CI auto-detects and adjusts some defaults (e.g., `VISOR_TEST_PROMPT_MAX_CHARS`).
- Ensure fixtures don't depend on local file paths or network access.
- Run with `--debug` in CI to capture more diagnostic output.

## LLM judge errors

### "LLM judge error: API key not valid"

- The judge uses ProbeAgent which needs API keys in the environment. Set `GOOGLE_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` depending on your provider.
- Configure the provider in test defaults: `tests.defaults.llm_judge.provider: google`
- The default model is `gemini-2.0-flash`. Override with `VISOR_JUDGE_MODEL` env var or `tests.defaults.llm_judge.model`.

### "LLM judge: no output history for step"

- The step name doesn't match any executed step. Check your mock structure — with `max_loops: 0` and `chat[]` mocks, outputs land at `chat` not `chat.generate-response`.
- Use `--debug` to see which steps executed and their output history keys.

### LLM judge field assertion fails unexpectedly

- LLM judgments are inherently non-deterministic. Use broader assertions (e.g., check `mentions_redis: true` rather than exact string matches).
- For enum fields, consider if the LLM might reasonably choose a different value (e.g., "moderate" vs "deep").
- The `pass`/`reason` fields are always present — check the `reason` in test output for the LLM's explanation.

### "Failed to parse LLM judge response as JSON"

- The LLM didn't return valid JSON. This is rare with schema-constrained output but can happen with some models.
- Try a more capable model (e.g., `gemini-2.0-flash` or `gpt-4o`).
- The judge handles markdown-wrapped JSON (`\`\`\`json ... \`\`\``) automatically.

## Related Documentation

- [Getting Started](./getting-started.md) - Introduction to the test framework
- [DSL Reference](./dsl-reference.md) - Complete test YAML schema
- [Assertions](./assertions.md) - Available assertion types
- [Fixtures and Mocks](./fixtures-and-mocks.md) - Managing test data
- [Flows](./flows.md) - Multi-stage test flows
- [Cookbook](./cookbook.md) - Copy-pasteable test recipes
- [CLI](./cli.md) - Test runner command line options
- [CI Integration](./ci.md) - Running tests in CI pipelines
