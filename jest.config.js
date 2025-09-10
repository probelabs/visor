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
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@octokit|@actions|@kie)/)',
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 10000, // Reduced from 30s to 10s for faster CI
  // Prevent Jest from hanging on async operations
  forceExit: true,
  detectOpenHandles: true,
  // Speed up test execution
  maxWorkers: process.env.CI ? 2 : '50%',
};