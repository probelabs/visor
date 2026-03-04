/**
 * Run backend contract tests against the KnexStoreBackend with SQLite driver
 */
import { KnexStoreBackend } from '../../../../src/scheduler/store/knex-store';
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

describe('KnexStoreBackend sqlite (contract)', () => {
  runBackendContractTests(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-contract-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const backend = new KnexStoreBackend('sqlite', {
      driver: 'sqlite',
      connection: { filename: dbPath },
    });
    return {
      backend,
      cleanup: async () => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  });
});
