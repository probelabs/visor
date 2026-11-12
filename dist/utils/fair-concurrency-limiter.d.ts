/**
 * Fair round-robin concurrency limiter.
 *
 * Single global limiter for all AI/delegation calls in the process.
 * Instead of FIFO (which lets one session hog all slots), this grants
 * slots in round-robin order across sessions so every user gets fair access.
 *
 * Usage:
 *   const limiter = FairConcurrencyLimiter.getInstance(maxConcurrent);
 *   await limiter.acquire(sessionId);  // blocks until slot available
 *   try { ... } finally { limiter.release(sessionId); }
 */
export declare class FairConcurrencyLimiter {
    private maxConcurrent;
    private globalActive;
    private sessionQueues;
    private roundRobinSessions;
    private roundRobinIndex;
    private sessionActive;
    constructor(maxConcurrent: number);
    static getInstance(maxConcurrent: number): FairConcurrencyLimiter;
    /**
     * Try to acquire a slot immediately (non-blocking).
     */
    tryAcquire(sessionId?: string | null): boolean;
    /**
     * Acquire a slot, waiting in a fair queue if necessary.
     * Sessions are served round-robin so no single session can starve others.
     */
    acquire(sessionId?: string | null, _debug?: boolean, queueTimeout?: number | null): Promise<boolean>;
    /**
     * Release a slot and grant the next one fairly (round-robin across sessions).
     */
    release(sessionId?: string | null, _debug?: boolean): void;
    /**
     * Round-robin queue processing: cycle through sessions and grant one slot per session per round.
     */
    private _processQueue;
    getStats(): {
        globalActive: number;
        maxConcurrent: number;
        queueSize: number;
        waitingSessions: number;
        perSession: Record<string, {
            active: number;
            queued: number;
        }>;
    };
    cleanup(): void;
    shutdown(): void;
    private _totalQueued;
    private _waitingSessions;
    private _removeFromRoundRobin;
    private _clearReminder;
}
//# sourceMappingURL=fair-concurrency-limiter.d.ts.map