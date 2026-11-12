import type { ScheduleStoreBackend } from './types';
/**
 * Migrate schedules from a JSON file into a ScheduleStoreBackend.
 *
 * @param jsonPath Path to the JSON file (absolute or relative to cwd)
 * @param backend  Already-initialized store backend to migrate into
 * @returns Number of schedules migrated (0 if file doesn't exist or already migrated)
 */
export declare function migrateJsonToBackend(jsonPath: string, backend: ScheduleStoreBackend): Promise<number>;
//# sourceMappingURL=json-migrator.d.ts.map