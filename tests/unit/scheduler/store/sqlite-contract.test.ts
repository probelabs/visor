/**
 * Run backend contract tests against the SQLite implementation
 */
import { SqliteStoreBackend } from '../../../../src/scheduler/store/sqlite-store';
import { runBackendContractTests } from './backend-contract';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Mock logger
jest.mock('../../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('SqliteStoreBackend (contract)', () => {
  runBackendContractTests(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-contract-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const backend = new SqliteStoreBackend(dbPath);
    return {
      backend,
      cleanup: async () => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  });
});
