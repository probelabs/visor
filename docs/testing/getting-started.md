# Visor Tests — Getting Started

This is the developer-facing guide for writing and running integration tests for your Visor config. It focuses on minimal setup, helpful errors, and clear output.

## TL;DR

- Put your tests in `defaults/.visor.tests.yaml`.
- Reference your base config with `extends: ".visor.yaml"`.
- Use built-in GitHub fixtures like `gh.pr_open.minimal`.
- Run with `visor test --config defaults/.visor.tests.yaml`.
- Validate only with `visor test --validate`.

```yaml
version: "1.0"
extends: ".visor.yaml"

tests:
  defaults:
    strict: true           # every executed step must be asserted
    ai_provider: mock      # offline by default
  cases:
    - name: label-flow
      event: pr_opened
      fixture: gh.pr_open.minimal
      mocks:
        overview:
          text: "Overview body"
          tags: { label: feature, review-effort: 2 }
      expect:
        calls:
          - step: overview
            exactly: 1
          - step: apply-overview-labels
            exactly: 1
          - provider: github
            op: labels.add
            at_least: 1
            args: { contains: [feature] }
```

## Why integration tests in YAML?

- You test the same thing you ship: events → checks → outputs → effects.
- No network required; GitHub calls are recorded, AI is mocked.
- Flows let you simulate real user journeys across multiple events.

## Strict by default

If a step runs and you didn’t assert it under `expect.calls`, the case fails. This prevents silent regressions and “accidental” work.

Turn off per-case via `strict: false` if you need to iterate.

## CLI recipes

- List cases: `visor test --list`
- Run a subset: `visor test --only pr-review`
- Stop on first failure: `--bail`
- Validate tests file only: `--validate`
- Parallelize cases: `--max-parallel 4`
- Throttle prompt capture: `--prompt-max-chars 16000`

## Coverage output

After each case/stage, a compact table shows expected vs actual step calls:

```
Coverage (label-flow):
  • overview                 want =1     got  1  ok
  • apply-overview-labels    want =1     got  1  ok
```

Unexpected executed steps are listed under `unexpected:` to help you add missing assertions quickly.

## Helpful validation errors

Run `visor test --validate` to get precise YAML-path errors and suggestions:

```
❌ Tests file has 2 error(s):
   • tests.cases[0].expext: must NOT have additional properties (Did you mean "expect"?)
   • tests.cases[3].event: must be equal to one of the allowed values (allowed: manual, pr_opened, pr_updated, pr_closed, issue_opened, issue_comment)
```

Next steps:
- Core reference: `docs/testing/dsl-reference.md`
- Flows: `docs/testing/flows.md`
- Mocks & fixtures: `docs/testing/fixtures-and-mocks.md`
- Assertions: `docs/testing/assertions.md`
- Cookbook: `docs/testing/cookbook.md`
- CLI & reporters: `docs/testing/cli.md`
- CI integration: `docs/testing/ci.md`
- Troubleshooting: `docs/testing/troubleshooting.md`
- Browse `defaults/.visor.tests.yaml` for full examples.
