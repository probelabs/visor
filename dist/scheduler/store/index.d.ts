import type { ScheduleStoreBackend, StorageConfig, HAConfig } from './types';
export type { ScheduleStoreBackend, ScheduleStoreStats, StorageConfig, HAConfig } from './types';
/**
 * Create a store backend based on configuration
 */
export declare function createStoreBackend(storageConfig?: StorageConfig, haConfig?: HAConfig): Promise<ScheduleStoreBackend>;
//# sourceMappingURL=index.d.ts.map