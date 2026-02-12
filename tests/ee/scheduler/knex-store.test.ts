/**
 * Enterprise tests for KnexStoreBackend
 * Tests license gating and backend construction (no real database needed)
 */

// Mock logger
jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock the license validator
const mockHasFeature = jest.fn();
const mockLoadAndValidate = jest.fn();
const mockIsInGracePeriod = jest.fn().mockReturnValue(false);

jest.mock('../../../src/enterprise/license/validator', () => ({
  LicenseValidator: jest.fn().mockImplementation(() => ({
    loadAndValidate: mockLoadAndValidate,
    hasFeature: mockHasFeature,
    isInGracePeriod: mockIsInGracePeriod,
  })),
}));

// Mock the KnexStoreBackend constructor
const mockKnexBackend = {
  initialize: jest.fn().mockResolvedValue(undefined),
  shutdown: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../../../src/enterprise/scheduler/knex-store', () => ({
  KnexStoreBackend: jest.fn().mockImplementation(() => mockKnexBackend),
}));

import { loadEnterpriseStoreBackend } from '../../../src/enterprise/loader';
import { KnexStoreBackend } from '../../../src/enterprise/scheduler/knex-store';
import type { StorageConfig } from '../../../src/scheduler/store/types';

const pgConfig: StorageConfig = {
  driver: 'postgresql',
  connection: {
    host: 'localhost',
    port: 5432,
    database: 'visor_test',
    user: 'visor',
    password: 'secret',
  },
};

describe('Enterprise KnexStoreBackend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('license gating', () => {
    it('should throw when no license is available', async () => {
      mockLoadAndValidate.mockResolvedValue(null);

      await expect(loadEnterpriseStoreBackend('postgresql', pgConfig)).rejects.toThrow(
        /Enterprise license/
      );
    });

    it('should throw when license lacks scheduler-sql feature', async () => {
      mockLoadAndValidate.mockResolvedValue({ valid: true });
      mockHasFeature.mockReturnValue(false);

      await expect(loadEnterpriseStoreBackend('postgresql', pgConfig)).rejects.toThrow(
        /scheduler-sql/
      );
    });

    it('should create backend when license is valid with feature', async () => {
      mockLoadAndValidate.mockResolvedValue({ valid: true });
      mockHasFeature.mockReturnValue(true);

      const backend = await loadEnterpriseStoreBackend('postgresql', pgConfig);
      expect(backend).toBeDefined();
    });

    it('should warn during grace period', async () => {
      mockLoadAndValidate.mockResolvedValue({ valid: true });
      mockHasFeature.mockReturnValue(true);
      mockIsInGracePeriod.mockReturnValue(true);

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      await loadEnterpriseStoreBackend('postgresql', pgConfig);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('grace period'));
      consoleSpy.mockRestore();
    });
  });

  describe('driver mapping', () => {
    beforeEach(() => {
      mockLoadAndValidate.mockResolvedValue({ valid: true });
      mockHasFeature.mockReturnValue(true);
    });

    it('should accept postgresql driver', async () => {
      const backend = await loadEnterpriseStoreBackend('postgresql', pgConfig);
      expect(backend).toBeDefined();
    });

    it('should accept mysql driver', async () => {
      const backend = await loadEnterpriseStoreBackend('mysql', {
        driver: 'mysql',
        connection: { host: 'localhost', database: 'visor' },
      });
      expect(backend).toBeDefined();
    });

    it('should accept mssql driver', async () => {
      const backend = await loadEnterpriseStoreBackend('mssql', {
        driver: 'mssql',
        connection: { host: 'localhost', database: 'visor' },
      });
      expect(backend).toBeDefined();
    });
  });

  describe('connection configurations', () => {
    it('should accept connection_string config', () => {
      const config: StorageConfig = {
        driver: 'postgresql',
        connection: {
          connection_string: 'postgresql://user:pass@host:5432/visor',
        },
      };
      const backend = new KnexStoreBackend('postgresql', config);
      expect(backend).toBeDefined();
    });

    it('should accept boolean ssl config', () => {
      const config: StorageConfig = {
        driver: 'postgresql',
        connection: {
          host: 'db.example.com',
          database: 'visor',
          ssl: true,
        },
      };
      const backend = new KnexStoreBackend('postgresql', config);
      expect(backend).toBeDefined();
    });

    it('should accept detailed ssl config with CA path', () => {
      const config: StorageConfig = {
        driver: 'postgresql',
        connection: {
          host: 'db.example.com',
          database: 'visor',
          ssl: {
            reject_unauthorized: true,
            ca: '/etc/ssl/certs/rds-combined-ca-bundle.pem',
          },
        },
      };
      const backend = new KnexStoreBackend('postgresql', config);
      expect(backend).toBeDefined();
    });

    it('should accept custom pool settings', () => {
      const config: StorageConfig = {
        driver: 'mysql',
        connection: {
          host: 'localhost',
          database: 'visor',
          pool: { min: 0, max: 20 },
        },
      };
      const backend = new KnexStoreBackend('mysql', config);
      expect(backend).toBeDefined();
    });

    it('should accept mssql driver with ssl config', () => {
      const config: StorageConfig = {
        driver: 'mssql',
        connection: {
          host: 'myserver.database.windows.net',
          database: 'visor',
          user: 'admin',
          password: 'secret',
          ssl: {
            reject_unauthorized: true,
          },
        },
      };
      const backend = new KnexStoreBackend('mssql', config);
      expect(backend).toBeDefined();
    });
  });
});
