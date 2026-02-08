module.exports = [
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: require('@typescript-eslint/parser'),
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    linterOptions: {
      // Do not warn about legacy disable comments as we migrate types
      reportUnusedDisableDirectives: false,
    },
    plugins: {
      '@typescript-eslint': require('@typescript-eslint/eslint-plugin'),
    },
    rules: {
      // Basic rules
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      // Prefer our extended Liquid engine everywhere; enforce enterprise import boundary
      'no-restricted-imports': [
        'warn',
        {
          paths: [
            {
              name: 'liquidjs',
              message: 'Use createExtendedLiquid() from src/liquid-extensions instead of raw Liquid.',
            },
          ],
          patterns: [{
            group: ['*/enterprise/*', '!*/enterprise/loader'],
            message: 'Enterprise code must only be imported via src/enterprise/loader.ts',
          }],
        },
      ],
      
      // TypeScript rules
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // Older engine files intentionally use narrow 'any' in a few places.
      // Treat as disabled to keep CI and pre-commit green; we can re-enable
      // per-file with explicit types in a follow-up.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      '*.js.map',
      '*.d.ts',
    ],
  },
  {
    files: ['tests/**/*.{ts,tsx}', '__mocks__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
];
