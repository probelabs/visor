/**
 * Unit tests for the store backend factory (createStoreBackend)
 *
 * Tests that the factory creates the correct backend for each driver
 * and gates enterprise drivers behind license validation.
 */
import { KnexStoreBackend } from '../../../../src/scheduler/store/knex-store';
import type { StorageConfig } from '../../../../src/scheduler/store/types';

// Mock logger
jest.mock('../../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// We need to import createStoreBackend after mocking
import { createStoreBackend } from '../../../../src/scheduler/store/index';

describe('createStoreBackend (factory)', () => {
  describe('SQLite (default)', () => {
    it('should create a KnexStoreBackend with sqlite driver when no config provided', async () => {
      const backend = await createStoreBackend();

      expect(backend).toBeInstanceOf(KnexStoreBackend);
    });

    it('should create a KnexStoreBackend with explicit sqlite driver', async () => {
      const config: StorageConfig = { driver: 'sqlite' };
      const backend = await createStoreBackend(config);

      expect(backend).toBeInstanceOf(KnexStoreBackend);
    });

    it('should pass storage config to the backend', async () => {
      const config: StorageConfig = {
        driver: 'sqlite',
        connection: { filename: '/tmp/test-factory.db' },
      };
      const backend = await createStoreBackend(config);

      expect(backend).toBeInstanceOf(KnexStoreBackend);
    });
  });

  describe('Enterprise drivers (postgresql, mysql, mssql)', () => {
    it('should throw when enterprise loader is not available for postgresql', async () => {
      const config: StorageConfig = {
        driver: 'postgresql',
        connection: { host: 'localhost' },
      };

      await expect(createStoreBackend(config)).rejects.toThrow(/Enterprise/i);
    });

    it('should throw when enterprise loader is not available for mysql', async () => {
      const config: StorageConfig = {
        driver: 'mysql',
        connection: { host: 'localhost' },
      };

      await expect(createStoreBackend(config)).rejects.toThrow(/Enterprise/i);
    });

    it('should throw when enterprise loader is not available for mssql', async () => {
      const config: StorageConfig = {
        driver: 'mssql',
        connection: { host: 'localhost' },
      };

      await expect(createStoreBackend(config)).rejects.toThrow(/Enterprise/i);
    });

    it('should include the driver name in the error message', async () => {
      const config: StorageConfig = {
        driver: 'postgresql',
        connection: { host: 'localhost' },
      };

      await expect(createStoreBackend(config)).rejects.toThrow(/postgresql/);
    });

    it('should suggest using sqlite as fallback', async () => {
      const config: StorageConfig = {
        driver: 'postgresql',
        connection: { host: 'localhost' },
      };

      await expect(createStoreBackend(config)).rejects.toThrow(/sqlite/i);
    });
  });

  describe('HA config passthrough', () => {
    it('should accept HA config for sqlite', async () => {
      const config: StorageConfig = { driver: 'sqlite' };
      const haConfig = {
        enabled: true,
        node_id: 'node-1',
        lock_ttl: 30,
        heartbeat_interval: 10,
      };

      const backend = await createStoreBackend(config, haConfig);
      expect(backend).toBeInstanceOf(KnexStoreBackend);
    });
  });
});
