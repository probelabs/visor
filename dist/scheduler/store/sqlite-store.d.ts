import type { Schedule, ScheduleLimits } from '../schedule-store';
import type { ScheduleStoreBackend, ScheduleStoreStats, MessageTrigger } from './types';
/**
 * SQLite implementation of ScheduleStoreBackend
 */
export declare class SqliteStoreBackend implements ScheduleStoreBackend {
    private db;
    private dbPath;
    private locks;
    constructor(filename?: string);
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    private migrateSchema;
    private getDb;
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
    tryAcquireLock(scheduleId: string, nodeId: string, ttlSeconds: number): Promise<string | null>;
    releaseLock(scheduleId: string, lockToken: string): Promise<void>;
    renewLock(scheduleId: string, lockToken: string, ttlSeconds: number): Promise<boolean>;
    flush(): Promise<void>;
    createTrigger(trigger: Omit<MessageTrigger, 'id' | 'createdAt'>): Promise<MessageTrigger>;
    getTrigger(id: string): Promise<MessageTrigger | undefined>;
    updateTrigger(id: string, patch: Partial<MessageTrigger>): Promise<MessageTrigger | undefined>;
    deleteTrigger(id: string): Promise<boolean>;
    getTriggersByCreator(creatorId: string): Promise<MessageTrigger[]>;
    getActiveTriggers(): Promise<MessageTrigger[]>;
}
//# sourceMappingURL=sqlite-store.d.ts.map