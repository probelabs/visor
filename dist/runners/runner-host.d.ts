import type { Runner } from './runner';
import type { VisorConfig } from '../types/config';
import type { TaskStore } from '../agent-protocol/task-store';
/**
 * Orchestrates the lifecycle of multiple Runner instances running in parallel.
 *
 * Handles start/stop ordering, config broadcast, and shared task-store propagation.
 */
export declare class RunnerHost {
    private runners;
    /** Register a runner to be managed by this host. */
    addRunner(runner: Runner): void;
    /** Return the list of registered runners. */
    getRunners(): readonly Runner[];
    /**
     * Start all registered runners concurrently.
     * If any runner fails to start, previously-started runners are stopped.
     */
    startAll(): Promise<void>;
    /**
     * Stop all registered runners concurrently.
     * Tolerates individual stop failures (logs warnings).
     */
    stopAll(): Promise<void>;
    /** Broadcast a config update to all runners. */
    broadcastConfigUpdate(cfg: VisorConfig): void;
    /** Propagate a shared task store to all runners that support it. */
    setTaskStore(store: TaskStore, configPath?: string): void;
    /**
     * Phase 1 of graceful restart: stop listening for new connections/messages.
     * Frees ports so a new process can bind immediately.
     * Does NOT wait for in-flight work — call drainAll() after for that.
     */
    stopListeningAll(): Promise<void>;
    /**
     * Drain all runners: stop accepting new work, wait for in-flight work to complete.
     * Runners without drain() fall back to stop().
     * @param timeoutMs - Max wait time in ms. 0 means wait indefinitely (default).
     */
    drainAll(timeoutMs?: number): Promise<void>;
}
//# sourceMappingURL=runner-host.d.ts.map