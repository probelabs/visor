/**
 * Store backend factory
 *
 * Creates the appropriate ScheduleStoreBackend based on configuration:
 * - 'sqlite' (default) → SqliteStoreBackend (OSS, zero-config)
 * - 'postgresql' / 'mysql' → Enterprise KnexStoreBackend (requires license)
 */
import { logger } from '../../logger';
import type {
  ScheduleStoreBackend,
  StorageConfig,
  HAConfig,
  SqliteConnectionConfig,
} from './types';
import { SqliteStoreBackend } from './sqlite-store';

export type { ScheduleStoreBackend, ScheduleStoreStats, StorageConfig, HAConfig } from './types';

/**
 * Create a store backend based on configuration
 */
export async function createStoreBackend(
  storageConfig?: StorageConfig,
  haConfig?: HAConfig
): Promise<ScheduleStoreBackend> {
  const driver = storageConfig?.driver || 'sqlite';

  switch (driver) {
    case 'sqlite': {
      const conn = storageConfig?.connection as SqliteConnectionConfig | undefined;
      return new SqliteStoreBackend(conn?.filename);
    }

    case 'postgresql':
    case 'mysql':
    case 'mssql': {
      // Enterprise-only: dynamic import to keep OSS code clean
      try {
        // Variable path prevents ncc from tracing into enterprise/ (stashed during OSS builds)
        const loaderPath = '../../enterprise/loader';
        // @ts-ignore — enterprise/ may not exist in OSS builds (caught at runtime)
        const { loadEnterpriseStoreBackend } = await import(loaderPath);
        return await loadEnterpriseStoreBackend(driver, storageConfig!, haConfig);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[StoreFactory] Failed to load enterprise ${driver} backend: ${msg}`);
        throw new Error(
          `The ${driver} schedule storage driver requires a Visor Enterprise license. ` +
            `Install the enterprise package or use driver: 'sqlite' (default). ` +
            `Original error: ${msg}`
        );
      }
    }

    default:
      throw new Error(`Unknown schedule storage driver: ${driver}`);
  }
}
