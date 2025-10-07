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
    plugins: {
      '@typescript-eslint': require('@typescript-eslint/eslint-plugin'),
    },
    rules: {
      // Basic rules
<<<<<<< Updated upstream
      'no-console': 'warn',
=======
      'no-console': 'error',
>>>>>>> Stashed changes
      'prefer-const': 'error',
      'no-var': 'error',

      // TypeScript rules
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
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
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
];
