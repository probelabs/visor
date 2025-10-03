# Visor SDK (Programmatic Usage)

Run Visor from Node.js without shelling out. The SDK is a thin façade over the existing engine: it just wires inputs/outputs and reuses all core behavior (routing, providers, templates, etc.).

## Install

```bash
npm i -D @probelabs/visor
```

## Quick Start

ESM
```ts
import { loadConfig, runChecks } from '@probelabs/visor/sdk';

const config = await loadConfig();
const result = await runChecks({
  config,
  checks: Object.keys(config.checks || {}),
  output: { format: 'json' },
});
console.log('Total issues:', result.reviewSummary.issues?.length ?? 0);
```

CommonJS
```js
const { loadConfig, runChecks } = require('@probelabs/visor/sdk');
(async () => {
  const config = await loadConfig();
  const result = await runChecks({ config, checks: Object.keys(config.checks || {}), output: { format: 'json' } });
  console.log('Total issues:', result.reviewSummary.issues?.length ?? 0);
})();
```

## API

- `loadConfig(configPath?: string): Promise<VisorConfig>`
  - Loads a Visor config from `configPath`, or discovers defaults (`.visor.yaml`/`.visor.yml`) if omitted.
- `resolveChecks(checkIds: string[], config: VisorConfig | undefined): string[]`
  - Expands check IDs to include dependencies in the correct order.
- `runChecks(options: RunOptions): Promise<AnalysisResult>`
  - Runs checks programmatically. Thin wrapper around the engine’s `executeChecks`.

### Types

- `RunOptions`
  - `config?: VisorConfig` | `configPath?: string`
  - `checks?: string[]`
  - `cwd?: string`
  - `timeoutMs?: number`
  - `output?: { format?: 'table'|'json'|'markdown'|'sarif' }`
  - `debug?: boolean`
  - `maxParallelism?: number`
  - `failFast?: boolean`
  - `tagFilter?: { include?: string[]; exclude?: string[] }`

- `AnalysisResult`
  - `reviewSummary.issues: Issue[]`
  - `executionTime: number`, `timestamp: string`, `checksExecuted: string[]`

Refer to `src/types/config.ts` for `VisorConfig`, `Issue`, and related types.

## Notes

- SDK adds no new sandboxing or providers; all safety lives in the core engine.
- For offline demos, unset provider env vars if you rely on mock providers.
- You can still use all CLI features alongside the SDK in the same project.

## Examples (in repo)

- `examples/sdk-basic.mjs` (ESM) – runs with local bundle `dist/sdk/sdk.mjs`.
- `examples/sdk-cjs.cjs` (CJS) – runs with local bundle `dist/sdk/sdk.js`.

These are also exercised by CI smoke tests.
