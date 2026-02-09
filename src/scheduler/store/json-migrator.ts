/**
 * One-time migration from .visor/schedules.json to a SQL backend
 *
 * - Reads the JSON file, inserts each schedule into the backend
 * - Skips schedules whose ID already exists (idempotent)
 * - Renames the JSON file to .json.migrated as a backup
 * - Called automatically during ScheduleStore.initialize() when the JSON file exists
 */
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../logger';
import type { Schedule } from '../schedule-store';
import type { ScheduleStoreBackend } from './types';

/**
 * Migrate schedules from a JSON file into a ScheduleStoreBackend.
 *
 * @param jsonPath Path to the JSON file (absolute or relative to cwd)
 * @param backend  Already-initialized store backend to migrate into
 * @returns Number of schedules migrated (0 if file doesn't exist or already migrated)
 */
export async function migrateJsonToBackend(
  jsonPath: string,
  backend: ScheduleStoreBackend
): Promise<number> {
  const resolvedPath = path.resolve(process.cwd(), jsonPath);

  // Check if JSON file exists
  let content: string;
  try {
    content = await fs.readFile(resolvedPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No file to migrate — nothing to do
      return 0;
    }
    throw err;
  }

  // Parse the JSON
  let data: { schedules?: Schedule[] };
  try {
    data = JSON.parse(content);
  } catch {
    logger.warn(`[JsonMigrator] Failed to parse ${jsonPath}, skipping migration`);
    return 0;
  }

  const schedules = data.schedules;
  if (!Array.isArray(schedules) || schedules.length === 0) {
    logger.debug('[JsonMigrator] No schedules to migrate');
    // Still rename to mark as processed
    await renameToMigrated(resolvedPath);
    return 0;
  }

  let migrated = 0;

  for (const schedule of schedules) {
    if (!schedule.id) {
      logger.warn('[JsonMigrator] Skipping schedule without ID');
      continue;
    }

    // Check if already migrated (idempotent)
    const existing = await backend.get(schedule.id);
    if (existing) {
      logger.debug(`[JsonMigrator] Schedule ${schedule.id} already exists, skipping`);
      continue;
    }

    try {
      // Import preserving original ID (idempotent — skips if ID already exists)
      await backend.importSchedule(schedule);
      migrated++;
    } catch (err) {
      logger.warn(
        `[JsonMigrator] Failed to migrate schedule ${schedule.id}: ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }

  // Rename original file as backup
  await renameToMigrated(resolvedPath);

  logger.info(`[JsonMigrator] Migrated ${migrated}/${schedules.length} schedules from ${jsonPath}`);
  return migrated;
}

/**
 * Rename the JSON file to .migrated as a backup
 */
async function renameToMigrated(resolvedPath: string): Promise<void> {
  const migratedPath = `${resolvedPath}.migrated`;
  try {
    await fs.rename(resolvedPath, migratedPath);
    logger.info(`[JsonMigrator] Backed up ${resolvedPath} → ${migratedPath}`);
  } catch (err) {
    logger.warn(
      `[JsonMigrator] Failed to rename ${resolvedPath}: ${err instanceof Error ? err.message : err}`
    );
  }
}
