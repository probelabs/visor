// Test setup file to configure mocks and prevent external API calls
import { MemoryStore } from '../src/memory-store';
import { SessionRegistry } from '../src/session-registry';

// Default test caps to reduce memory pressure (can be overridden by env)
if (!process.env.VISOR_TEST_PROMPT_MAX_CHARS) {
  process.env.VISOR_TEST_PROMPT_MAX_CHARS = process.env.CI === 'true' ? '4000' : '8000';
}
if (!process.env.VISOR_TEST_HISTORY_LIMIT) {
  process.env.VISOR_TEST_HISTORY_LIMIT = process.env.CI === 'true' ? '200' : '500';
}

// Mock child_process.spawn globally to prevent real process spawns while leaving other methods intact
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  const { EventEmitter } = require('events');

  const mockSpawn = jest.fn().mockImplementation(() => {
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
  });

  return {
    ...actual,
    spawn: mockSpawn,
  };
});

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
  // Default E2E-related env for headless runs; do NOT force-run entrypoints for imports
  process.env.VISOR_NOBROWSER = 'true';
  // Harden git-related environment: ensure tests cannot target parent repo via hooks
  const gitVars = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR'];
  for (const k of gitVars) delete (process.env as NodeJS.ProcessEnv)[k];
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
  // Ensure leaked git vars are cleared after each test
  const gitVars = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR'];
  for (const k of gitVars) delete (process.env as NodeJS.ProcessEnv)[k];

  // Clear global singletons between tests to avoid cross-test memory leaks
  try {
    MemoryStore.resetInstance();
  } catch {}
  try {
    SessionRegistry.getInstance().clearAllSessions();
  } catch {}
});

// Set global Jest timeout for all tests
jest.setTimeout(10000); // 10 seconds max per test

// Configure console to reduce noise in test output.
// When VISOR_DEBUG=true or VISOR_TEST_SHOW_LOGS=true, keep real console to allow debugging logs.
const originalConsole = global.console;
const SHOW_LOGS = process.env.VISOR_DEBUG === 'true' || process.env.VISOR_TEST_SHOW_LOGS === 'true';
if (!SHOW_LOGS) {
  global.console = {
    ...originalConsole,
    log: jest.fn(), // Silence console.log during tests
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as Console;
}
