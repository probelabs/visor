import type { ConfigSnapshot, ConfigSnapshotSummary } from './types';
import type { VisorConfig } from '../types/config';
export declare class ConfigSnapshotStore {
    private db;
    private dbPath;
    constructor(filename?: string);
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    private migrateSchema;
    private getDb;
    save(snapshot: Omit<ConfigSnapshot, 'id'>, maxCount?: number): Promise<ConfigSnapshot>;
    private getLastInsertId;
    list(): Promise<ConfigSnapshotSummary[]>;
    get(id: number): Promise<ConfigSnapshot | undefined>;
    prune(maxCount?: number): Promise<number>;
}
/**
 * Create a snapshot record from a resolved VisorConfig.
 */
export declare function createSnapshotFromConfig(config: VisorConfig, trigger: 'startup' | 'reload', sourcePath: string | null): Omit<ConfigSnapshot, 'id'>;
//# sourceMappingURL=config-snapshot-store.d.ts.map