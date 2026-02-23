module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  testPathIgnorePatterns: ['/node_modules/', '/tests/ee/'],
  transform: {
    // Fix @swc/jest bug: const __dirname in ESM -> CJS conflicts with CJS wrapper param
    'node_modules/@probelabs/probe/.+\\.js$': '<rootDir>/tests/transforms/probe-esm-fix.js',
    '^.+\\.(t|j)sx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: {
            syntax: 'typescript',
            tsx: false,
          },
          target: 'es2022',
        },
        module: {
          type: 'commonjs',
        },
      },
    ],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  moduleNameMapper: {
    '^@octokit/auth-app$': '<rootDir>/__mocks__/@octokit/auth-app.ts',
    '^@octokit/rest$': '<rootDir>/__mocks__/@octokit/rest.ts',
    '^@probelabs/probe$': '<rootDir>/__mocks__/@probelabs/probe.ts',
    '^open$': '<rootDir>/__mocks__/open.ts',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@octokit|@actions|@kie|@probelabs|open)/)',
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  // Log per-test heap usage in CI (or when explicitly enabled)
  logHeapUsage: process.env.CI === 'true' || process.env.VISOR_LOG_HEAP === 'true',
  testTimeout: 10000, // Reduced from 30s to 10s for faster CI
  // Prevent Jest from hanging on async operations
  forceExit: true,
  detectOpenHandles: process.env.CI ? false : true,
  // Speed up test execution
  maxWorkers: process.env.CI ? 1 : '50%',
  // Use child processes on CI for better memory reclamation
  workerThreads: process.env.CI ? false : true,
  // Recycle workers if they retain too much memory
  workerIdleMemoryLimit: process.env.CI ? '256MB' : undefined,
};
