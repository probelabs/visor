# Default Output Schema and Timestamps

Visor adds timestamps to check outputs to make history handling predictable.

## Timestamp Injection

When a check completes successfully:
- If the output is a plain **Object** (not an array, not null), Visor injects a `ts` field (milliseconds since epoch) if it is missing.
- If the output is a **primitive** (string, number, boolean), **array**, or **null**, it is passed through unchanged (no wrapping, no `ts`).

This injection happens after the provider returns and before outputs are recorded into `outputs` and `outputs_history`.

## Provider-Specific Defaults

Some providers return structured output by default:
- **human-input**: Returns `{ text: string, ts: number }` directly from the provider (not via central normalization).
- **Other providers**: Return whatever their implementation produces; Visor only adds `ts` to objects.

## Why Timestamps Exist

- `ts` allows you to sort/merge histories across steps without custom logic.
- Providers that need structured output (like human-input) implement it directly.

## Practical Tips

- Human input always returns `{ text, ts }`. In Liquid, access via `outputs['my-check'].text`.
- For AI checks with custom schemas, add `ts` to your schema if you want it persisted by validators; otherwise Visor adds it at runtime (not validated).
- Arrays are passed through untouched; if you need timestamps per item, include them in your schema.

## Related

- See [Human Input Provider](./human-input-provider.md) for the default output shape of human input.
