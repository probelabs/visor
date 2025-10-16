# SDK Config Validation - Fix Complete ✅

**Date:** 2025-10-16
**Branch:** buger/validate-sdk-docs

---

## Summary

Fixed critical validation bug in Visor SDK where manually constructed configs bypassed validation entirely.

## What Was Fixed

### 1. Config Validation Bug ✅
- **Problem:** `runChecks({ config: {...} })` bypassed validation
- **Solution:** Added `cm.validateConfig(opts.config)` call in SDK
- **Result:** All configs now validated regardless of how they're provided

### 2. Documentation Accuracy ✅
- **Problem:** Docs showed invalid config structures
- **Solution:** Updated to show minimal valid configs only
- **Result:** Users learn correct patterns from the start

### 3. Example Code ✅
- **Problem:** Examples used non-existent fields like `schema: 'issues'`
- **Solution:** Simplified to minimal required fields
- **Result:** Examples work without warnings

## Code Changes

### `src/config.ts`
```diff
- private validateConfig(config: Partial<VisorConfig>): void {
+ public validateConfig(config: Partial<VisorConfig>): void {
```

### `src/sdk.ts`
```diff
export async function runChecks(opts: RunOptions = {}): Promise<AnalysisResult> {
  const cm = new ConfigManager();
- const config: VisorConfig = opts.config
-   ? opts.config
-   : opts.configPath
-     ? await cm.loadConfig(opts.configPath)
-     : await cm.findAndLoadConfig();
+ let config: VisorConfig;
+
+ if (opts.config) {
+   cm.validateConfig(opts.config);  // ✅ Now validates!
+   config = opts.config;
+ } else if (opts.configPath) {
+   config = await cm.loadConfig(opts.configPath);
+ } else {
+   config = await cm.findAndLoadConfig();
+ }
```

### `docs/sdk.md`
- Removed invalid `output: { format: 'json', comments: {...} }` from config
- Clarified that only `version` and `checks` are required
- Added note about `output` parameter vs config field difference

### `examples/sdk-manual-config.mjs`
- Removed invalid `output` config structure
- Simplified to minimal required fields
- Added helpful comments

## Validation Results

### Required Field Validation
```bash
✅ Missing 'version' → Error: Missing required field: version
✅ Missing 'checks' → Error: Missing required field: checks
✅ Valid config → Accepted without warnings
```

### Example Test Results
```bash
✅ sdk-basic.mjs → Works (totalIssues: 1)
✅ sdk-cjs.cjs → Works (Issues: 1)
✅ sdk-manual-config.mjs → Works (2 checks executed, 0 issues)
```

## What We Learned

### Config Structure
1. **Required fields:** Only `version` and `checks`
2. **Valid schemas:** `'code-review'`, `'plain'`, `'overview'`, `'issue-assistant'`
   - ❌ NO `'issues'` schema exists
3. **Output field:** For GitHub PR comments, not CLI output
   - Structure: `{ pr_comment: { format: 'markdown', group_by: 'check', collapse: true } }`
   - Not: `{ format: 'json', comments: {...} }`

### SDK vs Config Output
- `runChecks({ output: { format: 'json' } })` → Controls CLI/SDK output format
- `config.output` → Controls GitHub PR comment rendering (optional for SDK)

## Files Modified

1. ✅ `src/config.ts` - Made validateConfig() public
2. ✅ `src/sdk.ts` - Added validation for manual configs
3. ✅ `docs/sdk.md` - Corrected examples and documentation
4. ✅ `examples/sdk-manual-config.mjs` - Fixed to use valid config
5. ✅ `SDK_FIX_SUMMARY.md` - Detailed technical summary
6. ✅ `SDK_VALIDATION.md` - Updated validation report

## Migration Guide

If you have existing code using invalid configs:

### Before (Invalid - but was silently accepted)
```typescript
const config = {
  version: '1.0',
  checks: { ... },
  output: {
    format: 'json',  // ❌ Invalid structure
    comments: { enabled: false }
  }
};
```

### After (Valid)
```typescript
const config = {
  version: '1.0',
  checks: { ... },
  // output field is optional for SDK use
  // Defaults will be applied automatically
};

// Control output format via runChecks options instead:
await runChecks({
  config,
  output: { format: 'json' }  // ✅ Correct place
});
```

## Testing

To verify the fix works:

```bash
# Build SDK
npm run build:sdk

# Test all examples
node examples/sdk-basic.mjs
node examples/sdk-cjs.cjs
node examples/sdk-manual-config.mjs
```

All should run without validation warnings.

## Impact Assessment

**Breaking Change:** Technically yes, but only for invalid configs that shouldn't have worked

**Risk:** Low - invalid configs were broken by definition

**Benefit:** High - prevents silent failures and incorrect usage

## Recommendation

✅ **Ready to merge** - Fixes critical bug and improves SDK reliability

---

**Validation Status:** ✅ COMPLETE
**All Tests Passing:** ✅ YES
**Documentation Updated:** ✅ YES
**Examples Working:** ✅ YES
