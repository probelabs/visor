# Default Output Schema and Timestamps

Visor normalizes check outputs to make prompts and history handling predictable. There are exactly two modes:

1) Checks with a schema (e.g., `schema: {...}` on the check)
- The provider's output shape is respected.
- If the final output is an Object (map), Visor injects a `ts` field (milliseconds since epoch) if it is missing.
- If the final output is a primitive or an array, it is passed through unchanged (no wrapping, no `ts`).

2) Checks without a schema
- Visor uses a default schema: `{ text: string, ts: number }`.
- If the provider returned a primitive (string/number/boolean), it is wrapped into `{ text, ts }`.
- If it returned an Object, Visor injects `ts` if it is missing.
- If it returned an array, it is passed through unchanged.

This normalization happens after the provider returns and before outputs are recorded into `outputs` and `outputs_history`.

Why this exists
- Prompts and templates can reliably access `.text` and `.ts` for no‑schema checks (e.g., human‑input), and can still trust custom shapes for schema’d checks.
- `ts` allows you to sort/merge histories across steps without bespoke engines or roles.

Practical tips
- Human input defaults to `{ text, ts }`. In Liquid, read `outputs_history.ask[i].text` safely with a fallback: `{% if u.text %}{{ u.text }}{% else %}{{ u }}{% endif %}` for legacy mocks.
- For schema’d AI checks, add `ts` to your schema if you want it persisted by validators; otherwise Visor will add it at runtime (not validated).
- Arrays are passed through untouched; if you need timestamps per item, include them in your own schema.

Related
- See `docs/human-input-provider.md` for default output shape of human input.
