module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  moduleNameMapper: {
    '^@octokit/auth-app$': '<rootDir>/__mocks__/@octokit/auth-app.ts',
    '^@probelabs/probe$': '<rootDir>/__mocks__/@probelabs/probe.ts',
    '^open$': '<rootDir>/__mocks__/open.ts',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@octokit|@actions|@kie|@probelabs|open)/)',
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 10000, // Reduced from 30s to 10s for faster CI
  // Prevent Jest from hanging on async operations
  forceExit: true,
  detectOpenHandles: process.env.CI ? false : true,
  // Speed up test execution
  maxWorkers: process.env.CI ? 1 : '50%',
  // Use child processes on CI for better memory reclamation
  workerThreads: process.env.CI ? false : true,
  // Recycle workers if they retain too much memory
  workerIdleMemoryLimit: process.env.CI ? '512MB' : undefined,
};
