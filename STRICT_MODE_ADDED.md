# Strict Validation Mode - Feature Added

**Date:** 2025-10-16
**Branch:** buger/validate-sdk-docs

## Feature

Added `strictValidation` option to SDK that treats config warnings (like unknown keys) as errors.

## Motivation

By default, Visor config validation logs warnings for unknown keys but doesn't fail. This is good for backward compatibility but can hide typos and config mistakes. Users requested the ability to make validation strict to catch these errors early.

## Implementation

### 1. Updated `ConfigManager.validateConfig()`

**File:** `src/config.ts:366`

Added optional `strict` parameter:

```typescript
// Before
public validateConfig(config: Partial<VisorConfig>): void {

// After
public validateConfig(config: Partial<VisorConfig>, strict = false): void {
```

**Logic at line 521-535:**

```typescript
// In strict mode, treat warnings as errors
if (strict && warnings.length > 0) {
  errors.push(...warnings);
}

if (errors.length > 0) {
  throw new Error(errors[0].message);
}

// Emit warnings (do not block execution) - only in non-strict mode
if (!strict && warnings.length > 0) {
  for (const w of warnings) {
    logger.warn(`⚠️  Config warning [${w.field}]: ${w.message}`);
  }
}
```

### 2. Added `strictValidation` to RunOptions

**File:** `src/sdk.ts:22-30`

```typescript
export interface RunOptions extends VisorOptions {
  config?: VisorConfig;
  configPath?: string;
  checks?: string[];
  timeoutMs?: number;
  output?: { format?: 'table' | 'json' | 'markdown' | 'sarif' };
  /** Strict mode: treat config warnings (like unknown keys) as errors (default: false) */
  strictValidation?: boolean;
}
```

### 3. Passed strictValidation to validateConfig

**File:** `src/sdk.ts:72-76`

```typescript
if (opts.config) {
  // Validate manually constructed config
  // In strict mode, unknown keys are treated as errors
  cm.validateConfig(opts.config, opts.strictValidation ?? false);
  config = opts.config;
}
```

## Usage

### Non-Strict Mode (Default)

```typescript
await runChecks({
  config: {
    version: '1.0',
    checks: { test: { type: 'command', exec: 'echo test' } },
    unknownKey: 'value'  // ⚠️ Logs warning, continues
  },
  checks: ['test']
});
// Output: ⚠️ Config warning [unknownKey]: Unknown top-level key 'unknownKey' will be ignored.
```

### Strict Mode

```typescript
try {
  await runChecks({
    config: {
      version: '1.0',
      checks: { test: { type: 'command', exec: 'echo test' } },
      unknownKey: 'value'  // ❌ Throws error
    },
    checks: ['test'],
    strictValidation: true
  });
} catch (error) {
  console.error(error.message);
  // Output: Unknown top-level key 'unknownKey' will be ignored.
}
```

## Test Results

```bash
✅ strictValidation=false → Unknown keys logged as warnings
✅ strictValidation=true → Unknown keys throw errors
✅ strictValidation=true with valid config → No errors
```

## Documentation

Updated `docs/sdk.md`:

1. Added `strictValidation` to `RunOptions` type documentation
2. Added "Strict Validation Mode" section with example
3. Explained when to use strict mode

## Backward Compatibility

✅ **Fully backward compatible**
- Default behavior unchanged (`strictValidation: false`)
- Existing code continues to work
- Opt-in feature for stricter validation

## Use Cases

### 1. Development/Testing
Enable strict mode during development to catch typos early:

```typescript
const config = {
  version: '1.0',
  checks: {
    'my-check': {
      type: 'command',
      exec: 'npm test',
      dependsOn: ['setup']  // Typo! Should be depends_on
    }
  }
};

await runChecks({ config, strictValidation: true });
// Error: Unknown key 'dependsOn' will be ignored
```

### 2. CI/CD Pipelines
Fail fast in CI if config has errors:

```typescript
await runChecks({
  configPath: '.visor.yaml',
  strictValidation: process.env.CI === 'true'
});
```

### 3. Config Validation Scripts
Validate configs without running checks:

```typescript
import { ConfigManager } from '@probelabs/visor';

const cm = new ConfigManager();
const config = await cm.loadConfig('.visor.yaml');

try {
  cm.validateConfig(config, true);  // Strict mode
  console.log('✅ Config is valid');
} catch (error) {
  console.error('❌ Config error:', error.message);
  process.exit(1);
}
```

## Files Modified

1. `src/config.ts` - Added `strict` parameter to `validateConfig()`
2. `src/sdk.ts` - Added `strictValidation` to `RunOptions`, passed to validation
3. `docs/sdk.md` - Documented the new option with examples

## Related

This feature complements the earlier fix where we made SDK always validate manually constructed configs. Now users can choose how strict that validation should be.

---

**Status:** ✅ Complete and Tested
**Breaking Change:** No
**Opt-in:** Yes
