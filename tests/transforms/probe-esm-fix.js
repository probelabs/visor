/**
 * Custom Jest transform for @probelabs/probe ESM files.
 *
 * Works around an @swc/jest bug where `const __dirname = ...` in ESM files
 * is not renamed during CJS transform, conflicting with the CJS wrapper's
 * `__dirname` parameter.  We post-process the output to use `var` instead
 * of `const`, which is safe because `var` can redeclare function parameters.
 */
const { createTransformer } = require('@swc/jest');

const base = createTransformer({
  jsc: {
    parser: { syntax: 'ecmascript' },
    target: 'es2022',
  },
  module: { type: 'commonjs' },
});

module.exports = {
  process(src, filename, config) {
    const result = base.process(src, filename, config);
    let code = typeof result === 'string' ? result : result.code;
    // Fix: const __dirname / const __filename cannot redeclare CJS wrapper params
    code = code.replace(/\bconst (__dirname)\b/g, 'var $1');
    code = code.replace(/\bconst (__filename)\b/g, 'var $1');
    if (typeof result === 'string') return code;
    return { ...result, code };
  },
  getCacheKey(src, filename, ...rest) {
    return base.getCacheKey(src, filename, ...rest) + '-probe-esm-fix';
  },
};
