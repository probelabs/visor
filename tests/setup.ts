// Test setup file to configure mocks and prevent external API calls

// Mock child_process spawn globally to prevent real process spawns
jest.mock('child_process', () => ({
  spawn: jest.fn().mockImplementation(() => {
    const { EventEmitter } = require('events');
    const mockChild = new EventEmitter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockChild as any).stdin = { write: jest.fn(), end: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockChild as any).stdout = new EventEmitter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockChild as any).stderr = new EventEmitter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockChild as any).kill = jest.fn();

    // Immediately resolve with success for tests
    setTimeout(() => {
      mockChild.emit('close', 0);
    }, 10);

    return mockChild;
  }),
  execSync: jest.fn().mockReturnValue(''),
}));

// Note: Not mocking fs globally anymore as individual tests need control over it
// Individual tests will mock fs as needed

// Set up environment variables to prevent real API calls
const originalEnv = process.env;
beforeEach(() => {
  // Ensure API keys are set to prevent "No API key" errors but won't make real calls due to mocking
  process.env.GOOGLE_API_KEY = 'mock-test-key';
  process.env.ANTHROPIC_API_KEY = 'mock-test-key';
  process.env.OPENAI_API_KEY = 'mock-test-key';
  process.env.MODEL_NAME = 'mock-model';
});

afterEach(() => {
  // Reset environment (individual tests may override this)
  Object.keys(process.env).forEach(key => {
    if (key.includes('API_KEY') || key === 'MODEL_NAME') {
      if (originalEnv[key]) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });
});

// Set global Jest timeout for all tests
jest.setTimeout(10000); // 10 seconds max per test

// Configure console to reduce noise in test output
const originalConsole = global.console;
global.console = {
  ...originalConsole,
  log: jest.fn(), // Silence console.log during tests
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as Console;
