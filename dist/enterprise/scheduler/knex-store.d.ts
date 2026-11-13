/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */
import type { Schedule, ScheduleLimits } from '../../scheduler/schedule-store';
import type { ScheduleStoreBackend, ScheduleStoreStats, StorageConfig, HAConfig, MessageTrigger } from '../../scheduler/store/types';
/**
 * Enterprise Knex-backed store for PostgreSQL, MySQL, and MSSQL
 */
export declare class KnexStoreBackend implements ScheduleStoreBackend {
    private knex;
    private driver;
    private connection;
    constructor(driver: 'postgresql' | 'mysql' | 'mssql', storageConfig: StorageConfig, _haConfig?: HAConfig);
    initialize(): Promise<void>;
    private buildStandardConnection;
    private buildMssqlConnection;
    private resolveSslConfig;
    private validateSslPath;
    shutdown(): Promise<void>;
    private migrateSchema;
    private getKnex;
    create(schedule: Omit<Schedule, 'id' | 'createdAt' | 'runCount' | 'failureCount' | 'status'>): Promise<Schedule>;
    importSchedule(schedule: Schedule): Promise<void>;
    get(id: string): Promise<Schedule | undefined>;
    update(id: string, patch: Partial<Schedule>): Promise<Schedule | undefined>;
    delete(id: string): Promise<boolean>;
    getByCreator(creatorId: string): Promise<Schedule[]>;
    getActiveSchedules(): Promise<Schedule[]>;
    getDueSchedules(now?: number): Promise<Schedule[]>;
    findByWorkflow(creatorId: string, workflowName: string): Promise<Schedule[]>;
    getAll(): Promise<Schedule[]>;
    getStats(): Promise<ScheduleStoreStats>;
    validateLimits(creatorId: string, isRecurring: boolean, limits: ScheduleLimits): Promise<void>;
    tryAcquireLock(lockId: string, nodeId: string, ttlSeconds: number): Promise<string | null>;
    releaseLock(lockId: string, lockToken: string): Promise<void>;
    renewLock(lockId: string, lockToken: string, ttlSeconds: number): Promise<boolean>;
    flush(): Promise<void>;
    createTrigger(trigger: Omit<MessageTrigger, 'id' | 'createdAt'>): Promise<MessageTrigger>;
    getTrigger(id: string): Promise<MessageTrigger | undefined>;
    updateTrigger(id: string, patch: Partial<MessageTrigger>): Promise<MessageTrigger | undefined>;
    deleteTrigger(id: string): Promise<boolean>;
    getTriggersByCreator(creatorId: string): Promise<MessageTrigger[]>;
    getActiveTriggers(): Promise<MessageTrigger[]>;
}
//# sourceMappingURL=knex-store.d.ts.map