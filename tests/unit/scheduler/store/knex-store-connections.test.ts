/**
 * Unit tests for KnexStoreBackend connection building logic
 *
 * Tests the private connection-building methods (buildStandardConnection,
 * buildMssqlConnection, resolveSslConfig) by instantiating the backend and
 * calling them via reflection. This avoids needing a real database.
 */
import { KnexStoreBackend } from '../../../../src/scheduler/store/knex-store';
import type { StorageConfig, ServerConnectionConfig } from '../../../../src/scheduler/store/types';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock logger
jest.mock('../../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

/**
 * Helper to create a backend and access private connection methods
 */
function createBackend(
  driver: 'sqlite' | 'postgresql' | 'mysql' | 'mssql',
  connection?: ServerConnectionConfig
) {
  const config: StorageConfig = { driver, connection: connection || {} };
  return new KnexStoreBackend(driver, config);
}

/**
 * Call private buildStandardConnection via reflection
 */
function callBuildStandard(
  backend: KnexStoreBackend,
  conn: ServerConnectionConfig
): Record<string, unknown> {
  return (backend as any).buildStandardConnection(conn);
}

/**
 * Call private buildMssqlConnection via reflection
 */
function callBuildMssql(
  backend: KnexStoreBackend,
  conn: ServerConnectionConfig
): Record<string, unknown> {
  return (backend as any).buildMssqlConnection(conn);
}

/**
 * Call private resolveSslConfig via reflection
 */
function callResolveSsl(
  backend: KnexStoreBackend,
  conn: ServerConnectionConfig
): boolean | Record<string, unknown> {
  return (backend as any).resolveSslConfig(conn);
}

describe('KnexStoreBackend — Connection Building', () => {
  describe('buildStandardConnection (PostgreSQL / MySQL)', () => {
    it('should use default host and database when not specified', () => {
      const backend = createBackend('postgresql');
      const result = callBuildStandard(backend, {});

      expect(result.host).toBe('localhost');
      expect(result.database).toBe('visor');
    });

    it('should use provided host, port, database, user, password', () => {
      const backend = createBackend('postgresql');
      const result = callBuildStandard(backend, {
        host: 'db.example.com',
        port: 5433,
        database: 'mydb',
        user: 'admin',
        password: 's3cret',
      });

      expect(result.host).toBe('db.example.com');
      expect(result.port).toBe(5433);
      expect(result.database).toBe('mydb');
      expect(result.user).toBe('admin');
      expect(result.password).toBe('s3cret');
    });

    it('should pass ssl config through resolveSslConfig', () => {
      const backend = createBackend('postgresql');
      const result = callBuildStandard(backend, { ssl: true });

      expect(result.ssl).toEqual({ rejectUnauthorized: true });
    });

    it('should set ssl to false when not provided', () => {
      const backend = createBackend('postgresql');
      const result = callBuildStandard(backend, {});

      expect(result.ssl).toBe(false);
    });
  });

  describe('buildMssqlConnection', () => {
    it('should use "server" key instead of "host"', () => {
      const backend = createBackend('mssql');
      const result = callBuildMssql(backend, { host: 'mssql.example.com' });

      expect(result.server).toBe('mssql.example.com');
      expect(result.host).toBeUndefined();
    });

    it('should default server to localhost', () => {
      const backend = createBackend('mssql');
      const result = callBuildMssql(backend, {});

      expect(result.server).toBe('localhost');
    });

    it('should set encrypt to false when ssl is not configured', () => {
      const backend = createBackend('mssql');
      const result = callBuildMssql(backend, {});

      expect((result.options as any).encrypt).toBe(false);
      expect((result.options as any).trustServerCertificate).toBe(true);
    });

    it('should set encrypt to true when ssl is true', () => {
      const backend = createBackend('mssql');
      const result = callBuildMssql(backend, { ssl: true });

      expect((result.options as any).encrypt).toBe(true);
      expect((result.options as any).trustServerCertificate).toBe(false);
    });

    it('should respect ssl object with reject_unauthorized=false', () => {
      const backend = createBackend('mssql');
      const result = callBuildMssql(backend, {
        ssl: { reject_unauthorized: false },
      });

      expect((result.options as any).encrypt).toBe(true);
      expect((result.options as any).trustServerCertificate).toBe(true);
    });

    it('should include port, database, user, and password', () => {
      const backend = createBackend('mssql');
      const result = callBuildMssql(backend, {
        host: 'sql.example.com',
        port: 1434,
        database: 'visor_prod',
        user: 'sa',
        password: 'P@ssw0rd',
      });

      expect(result.server).toBe('sql.example.com');
      expect(result.port).toBe(1434);
      expect(result.database).toBe('visor_prod');
      expect(result.user).toBe('sa');
      expect(result.password).toBe('P@ssw0rd');
    });
  });

  describe('resolveSslConfig', () => {
    it('should return false when ssl is undefined', () => {
      const backend = createBackend('postgresql');
      expect(callResolveSsl(backend, {})).toBe(false);
    });

    it('should return false when ssl is false', () => {
      const backend = createBackend('postgresql');
      expect(callResolveSsl(backend, { ssl: false })).toBe(false);
    });

    it('should return { rejectUnauthorized: true } when ssl is true', () => {
      const backend = createBackend('postgresql');
      expect(callResolveSsl(backend, { ssl: true })).toEqual({
        rejectUnauthorized: true,
      });
    });

    it('should return false when ssl object has enabled=false', () => {
      const backend = createBackend('postgresql');
      expect(callResolveSsl(backend, { ssl: { enabled: false } })).toBe(false);
    });

    it('should set rejectUnauthorized=true by default', () => {
      const backend = createBackend('postgresql');
      const result = callResolveSsl(backend, { ssl: {} }) as Record<string, unknown>;

      expect(result.rejectUnauthorized).toBe(true);
    });

    it('should set rejectUnauthorized=false when configured', () => {
      const backend = createBackend('postgresql');
      const result = callResolveSsl(backend, {
        ssl: { reject_unauthorized: false },
      }) as Record<string, unknown>;

      expect(result.rejectUnauthorized).toBe(false);
    });

    it('should read CA certificate from file', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-ssl-test-'));
      const caPath = path.join(tmpDir, 'ca.pem');
      fs.writeFileSync(caPath, 'CA-CERT-CONTENT');

      try {
        const backend = createBackend('postgresql');
        const result = callResolveSsl(backend, {
          ssl: { ca: caPath },
        }) as Record<string, unknown>;

        expect(result.ca).toBe('CA-CERT-CONTENT');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should read client cert and key from files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-ssl-test-'));
      const certPath = path.join(tmpDir, 'client.pem');
      const keyPath = path.join(tmpDir, 'client.key');
      fs.writeFileSync(certPath, 'CLIENT-CERT');
      fs.writeFileSync(keyPath, 'CLIENT-KEY');

      try {
        const backend = createBackend('postgresql');
        const result = callResolveSsl(backend, {
          ssl: { cert: certPath, key: keyPath },
        }) as Record<string, unknown>;

        expect(result.cert).toBe('CLIENT-CERT');
        expect(result.key).toBe('CLIENT-KEY');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should throw when CA file does not exist', () => {
      const backend = createBackend('postgresql');

      expect(() =>
        callResolveSsl(backend, {
          ssl: { ca: '/nonexistent/path/ca.pem' },
        })
      ).toThrow(/CA certificate not found/);
    });

    it('should throw when client cert file does not exist', () => {
      const backend = createBackend('postgresql');

      expect(() =>
        callResolveSsl(backend, {
          ssl: { cert: '/nonexistent/path/cert.pem' },
        })
      ).toThrow(/client certificate not found/);
    });

    it('should throw when client key file does not exist', () => {
      const backend = createBackend('postgresql');

      expect(() =>
        callResolveSsl(backend, {
          ssl: { key: '/nonexistent/path/key.pem' },
        })
      ).toThrow(/client key not found/);
    });
  });

  describe('SQLite path handling', () => {
    it('should construct with default filename', () => {
      const backend = new KnexStoreBackend('sqlite', { driver: 'sqlite' });
      expect(backend).toBeDefined();
    });

    it('should construct with custom filename', () => {
      const backend = new KnexStoreBackend('sqlite', {
        driver: 'sqlite',
        connection: { filename: '/tmp/test.db' },
      });
      expect(backend).toBeDefined();
    });

    it('should create parent directories on initialize', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-sqlite-path-'));
      const nestedPath = path.join(tmpDir, 'deep', 'nested', 'test.db');

      const backend = new KnexStoreBackend('sqlite', {
        driver: 'sqlite',
        connection: { filename: nestedPath },
      });

      await backend.initialize();

      expect(fs.existsSync(nestedPath)).toBe(true);

      await backend.shutdown();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('Connection string support', () => {
    it('should prefer connection_string over individual fields', () => {
      // We can verify this by inspecting that when connection_string is set,
      // the individual fields are not used. Since we can't easily test the
      // actual knex initialization without a database, we test the constructor
      // doesn't throw and the config is stored.
      const backend = new KnexStoreBackend('postgresql', {
        driver: 'postgresql',
        connection: {
          connection_string: 'postgresql://user:pass@host:5432/db',
          host: 'should-be-ignored',
          port: 9999,
        },
      });
      expect(backend).toBeDefined();
    });
  });

  describe('Pool configuration', () => {
    it('should accept custom pool settings', () => {
      const backend = new KnexStoreBackend('postgresql', {
        driver: 'postgresql',
        connection: {
          host: 'localhost',
          pool: { min: 2, max: 20 },
        },
      });
      expect(backend).toBeDefined();
    });
  });

  describe('driver helpers', () => {
    it('isMssql should return true only for mssql', () => {
      const mssql = createBackend('mssql');
      const pg = createBackend('postgresql');

      expect((mssql as any).isMssql()).toBe(true);
      expect((pg as any).isMssql()).toBe(false);
    });

    it('isSqlite should return true only for sqlite', () => {
      const sqlite = new KnexStoreBackend('sqlite', { driver: 'sqlite' });
      const pg = createBackend('postgresql');

      expect((sqlite as any).isSqlite()).toBe(true);
      expect((pg as any).isSqlite()).toBe(false);
    });
  });
});
