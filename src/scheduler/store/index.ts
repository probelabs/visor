/**
 * Store backend factory
 *
 * Creates the appropriate ScheduleStoreBackend based on configuration:
 * - 'sqlite' (default) → KnexStoreBackend with better-sqlite3
 * - 'postgresql' / 'mysql' / 'mssql' → KnexStoreBackend (requires Enterprise license)
 */
import { logger } from '../../logger';
import type { ScheduleStoreBackend, StorageConfig, HAConfig } from './types';
import { KnexStoreBackend } from './knex-store';

export type { ScheduleStoreBackend, ScheduleStoreStats, StorageConfig, HAConfig } from './types';

/**
 * Create a store backend based on configuration
 */
export async function createStoreBackend(
  storageConfig?: StorageConfig,
  haConfig?: HAConfig
): Promise<ScheduleStoreBackend> {
  const driver = storageConfig?.driver || 'sqlite';

  if (driver !== 'sqlite') {
    // Enterprise-only: dynamic import to keep OSS code clean
    try {
      // Variable path prevents ncc from tracing into enterprise/ (stashed during OSS builds)
      const loaderPath = '../../enterprise/loader';
      // @ts-ignore — enterprise/ may not exist in OSS builds (caught at runtime)
      const { validateEnterpriseSchedulerLicense } = await import(loaderPath);
      await validateEnterpriseSchedulerLicense(driver);
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

  return new KnexStoreBackend(driver, storageConfig || { driver: 'sqlite' }, haConfig);
}
