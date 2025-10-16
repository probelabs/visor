# SDK Config Validation Fix - Summary

**Date:** 2025-10-16
**Branch:** buger/validate-sdk-docs

## Problem Identified

The SDK had a **critical validation bug**: when passing a config object directly to `runChecks()`, validation was completely bypassed. Only configs loaded from files were validated.

```typescript
// This bypassed validation entirely! ❌
await runChecks({
  config: { invalid: 'config' },  // No validation!
  checks: []
});

// Only this was validated ✅
await runChecks({
  configPath: './config.yaml'  // Validated via loadConfig()
});
```

## Root Cause

In `src/sdk.ts`, the code path for manual configs skipped validation:

```typescript
// BEFORE (buggy):
const config: VisorConfig = opts.config
  ? opts.config  // ❌ No validation!
  : opts.configPath
    ? await cm.loadConfig(opts.configPath)  // ✅ Validated
    : await cm.findAndLoadConfig();  // ✅ Validated
```

## Fix Applied

### 1. Made `validateConfig()` Public

**File:** `src/config.ts:364`

Changed from:
```typescript
private validateConfig(config: Partial<VisorConfig>): void {
```

To:
```typescript
public validateConfig(config: Partial<VisorConfig>): void {
```

### 2. Added Validation to SDK

**File:** `src/sdk.ts:66-78`

```typescript
// AFTER (fixed):
export async function runChecks(opts: RunOptions = {}): Promise<AnalysisResult> {
  const cm = new ConfigManager();
  let config: VisorConfig;

  if (opts.config) {
    // ✅ Now validates manually constructed config
    cm.validateConfig(opts.config);
    config = opts.config;
  } else if (opts.configPath) {
    config = await cm.loadConfig(opts.configPath);
  } else {
    config = await cm.findAndLoadConfig();
  }
  // ... rest of implementation
}
```

## Validation Behavior

The validation now:

1. **Throws errors** for missing required fields:
   - Missing `version` → `Error: Missing required field: version`
   - Missing `checks` → `Error: Missing required field: checks`

2. **Warns** about unknown/invalid fields (but doesn't block execution):
   - Unknown keys like `output.format` → Warning logged
   - This is intentional for backward compatibility

## Testing Results

### Before Fix
```bash
❌ Invalid configs silently accepted
❌ No validation warnings
❌ Execution proceeded with malformed config
```

### After Fix
```bash
✅ Missing 'version' → Error thrown
✅ Missing 'checks' → Error thrown
✅ Valid minimal config → Accepted
✅ Unknown keys → Warning logged (not blocking)
```

## Documentation Updates

### Updated `docs/sdk.md`

1. **Clarified minimal config requirements:**
   ```typescript
   // Only version and checks required
   const config = {
     version: '1.0',
     checks: { ... }
   };
   ```

2. **Documented output parameter confusion:**
   - `runChecks({ output: { format: 'json' } })` - Controls CLI output format
   - `config.output` - Controls GitHub PR comments (optional for SDK)

3. **Removed invalid examples:**
   - ❌ Removed: `schema: 'issues'` (doesn't exist)
   - ❌ Removed: `output: { format: 'json', comments: {...} }` (wrong structure)

### Updated Examples

**File:** `examples/sdk-manual-config.mjs`

- Removed invalid `output` config structure
- Added comments clarifying required vs optional fields
- Simplified to minimal valid config

## Files Modified

1. `src/config.ts` - Made `validateConfig()` public
2. `src/sdk.ts` - Added validation call for manual configs
3. `docs/sdk.md` - Corrected documentation and examples
4. `examples/sdk-manual-config.mjs` - Fixed to use valid minimal config
5. `SDK_FIX_SUMMARY.md` - This document

## Test Files Created

1. `test-validation.mjs` - Validates required field checks work
2. `test-invalid-config.mjs` - Tests various invalid configs

## Verification

Run these to verify the fix:

```bash
# Build SDK with fix
npm run build:sdk

# Test validation works
node test-validation.mjs

# Test example works without warnings
node examples/sdk-manual-config.mjs
```

## Impact

**Before:**
- Invalid configs silently accepted ❌
- Documentation showed incorrect examples ❌
- Users could create broken configs without errors ❌

**After:**
- Invalid configs rejected with clear errors ✅
- Documentation shows correct minimal examples ✅
- Users get immediate feedback on config issues ✅

## Recommendation

This fix should be:
1. ✅ **Merged immediately** - fixes critical validation bug
2. ✅ **Documented in changelog** - breaking change if users relied on invalid configs
3. ⚠️ **Consider semver** - technically breaking if anyone relied on lack of validation

## Additional Findings

During this investigation, we also discovered:

1. **No `'issues'` schema exists** - Valid schemas: `'code-review'`, `'plain'`, `'overview'`, `'issue-assistant'`
2. **Config `output` structure is complex** - Not just `{ format: 'json' }` but `{ pr_comment: { format: 'markdown', ... } }`
3. **Schema is optional for command checks** - Most check types don't require a schema field
