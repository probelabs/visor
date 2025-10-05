## 🧭 Developer Experience Playbook

- Start with defaults: copy `defaults/.visor.yaml` or an example; run `npx @probelabs/visor --check all --debug`.
- Treat config as code: review `.visor.yaml` and templates; pin providers/models for reproducibility.
- Roll out gradually: gate heavier checks with tags (`local`, `fast`, `critical`).
- Secure credentials: prefer GitHub App in production; scope/rotate API keys.
- Make feedback actionable: group related checks; use `/review --check ...` triggers; enable `reuse_ai_session` for follow-ups.
- Keep suppressions intentional: annotate context; audit `visor-disable-file` periodically.
- Validate locally: `npx @probelabs/visor --check security --output markdown`; run tests; `--fail-fast` for fast lanes.
