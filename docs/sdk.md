# Visor SDK (Programmatic Usage)

Run Visor from Node.js without shelling out. The SDK is a thin façade over the existing engine: it just wires inputs/outputs and reuses all core behavior (routing, providers, templates, etc.).

## Install

```bash
npm i -D @probelabs/visor
```

## Quick Start

### JavaScript (ESM)
```ts
import { loadConfig, runChecks } from '@probelabs/visor/sdk';

// Load config from object (not file!) - validation and defaults applied
const config = await loadConfig({
  version: '1.0',
  checks: {
    'security': { type: 'command', exec: 'npm audit' },
    'lint': { type: 'command', exec: 'npm run lint' },
  }
});

const result = await runChecks({
  config,
  checks: Object.keys(config.checks),
  output: { format: 'json' },
});
console.log('Total issues:', result.reviewSummary.issues?.length ?? 0);
```

### TypeScript
```typescript
import { loadConfig, runChecks, type VisorConfig, type RunOptions } from '@probelabs/visor/sdk';

// Type-safe config construction
const rawConfig: Partial<VisorConfig> = {
  version: '1.0',
  checks: {
    'security': { type: 'command', exec: 'npm audit' },
    'lint': { type: 'command', exec: 'npm run lint' },
  }
};

const config = await loadConfig(rawConfig);
const result = await runChecks({
  config,
  checks: Object.keys(config.checks),
  output: { format: 'json' },
});

// Type-safe result access with full type inference
console.log('Total issues:', result.reviewSummary.issues?.length ?? 0);
console.log('Checks executed:', result.checksExecuted);
console.log('Execution time:', result.executionTime);
```

CommonJS
```js
const { loadConfig, runChecks } = require('@probelabs/visor/sdk');
(async () => {
  const config = await loadConfig({
    version: '1.0',
    checks: { test: { type: 'command', exec: 'echo test' } }
  });
  const result = await runChecks({ config, checks: Object.keys(config.checks), output: { format: 'json' } });
  console.log('Total issues:', result.reviewSummary.issues?.length ?? 0);
})();
```

### Loading from Files

You can also load config from files:

```ts
import { loadConfig, runChecks } from '@probelabs/visor/sdk';

// Load from specific file path
const config = await loadConfig('./my-config.yaml');

// Or discover default (.visor.yaml/.visor.yml)
const config2 = await loadConfig();

const result = await runChecks({
  config,
  checks: Object.keys(config.checks),
  output: { format: 'json' },
});
```

**Note:** The `output` parameter in `runChecks()` options controls the CLI output format (table/json/markdown/sarif). The config's `output` field is for GitHub PR comments and is optional for programmatic use.

### Strict Validation Mode

By default, unknown config keys generate warnings but don't fail. Enable strict mode to catch config errors early:

```ts
import { runChecks } from '@probelabs/visor/sdk';

const config = {
  version: '1.0',
  checks: { test: { type: 'command', exec: 'echo test' } },
  typo_field: 'oops'  // This would normally just warn
};

try {
  await runChecks({
    config,
    checks: ['test'],
    strictValidation: true  // Now throws error for unknown keys
  });
} catch (error) {
  console.error('Config error:', error.message);
  // Error: Unknown top-level key 'typo_field' will be ignored.
}
```

## API

- `loadConfig(configOrPath?: string | Partial<VisorConfig>, options?: { strict?: boolean }): Promise<VisorConfig>`
  - Loads and validates a config from an object, file path, or discovers defaults
  - Accepts config objects (validates and applies defaults) or file paths
  - Returns fully validated config with all defaults applied
  - Set `options.strict` to treat warnings as errors
- `resolveChecks(checkIds: string[], config: VisorConfig | undefined): string[]`
  - Expands check IDs to include dependencies in the correct order.
- `runChecks(options: RunOptions): Promise<AnalysisResult>`
  - Runs checks programmatically. Thin wrapper around the engine's `executeChecks`.

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
  - `strictValidation?: boolean` - Treat config warnings (unknown keys) as errors (default: false)

- `AnalysisResult`
  - `reviewSummary.issues: Issue[]`
  - `executionTime: number`, `timestamp: string`, `checksExecuted: string[]`

Refer to `src/types/config.ts` for `VisorConfig`, `Issue`, and related types.

## Notes

- SDK adds no new sandboxing or providers; all safety lives in the core engine.
- For offline demos, unset provider env vars if you rely on mock providers.
- You can still use all CLI features alongside the SDK in the same project.

## Examples (in repo)

- `examples/sdk-basic.mjs` (ESM) – Minimal example with raw config object
- `examples/sdk-cjs.cjs` (CJS) – CommonJS usage
- `examples/sdk-manual-config.mjs` (ESM) – Manual config construction with validation
- `examples/sdk-typescript.ts` (TypeScript) – **Type-safe example** showing:
  - Full TypeScript type safety with SDK type definitions
  - Importing types from `@probelabs/visor/sdk`
  - Type inference for configs and results
  - Compile-time type checking
  - Using exported types (`VisorConfig`, `RunOptions`)
  - To run: `npx tsc examples/sdk-typescript.ts --module esnext --target es2022 --moduleResolution bundler --esModuleInterop --skipLibCheck && node examples/sdk-typescript.js`
- `examples/sdk-comprehensive.mjs` (ESM) – **Complex example** showing:
  - Multi-level check dependencies (`depends_on`)
  - Tag filtering
  - Parallel execution control
  - Dependency resolution with `resolveChecks()`
  - Strict validation mode
  - Complete pipeline execution

These are also exercised by CI smoke tests.
