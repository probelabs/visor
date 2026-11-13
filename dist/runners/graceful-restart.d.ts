import type { RunnerHost } from './runner-host';
import type { GracefulRestartConfig } from '../types/config';
export interface GracefulRestartOptions {
    drainTimeoutMs: number;
    childReadyTimeoutMs: number;
    notifyUsers: boolean;
    restartCommand?: string;
}
/**
 * Manages graceful restart: drains the old process while spawning a new one.
 *
 * Trigger via SIGUSR1. The old process stops accepting new work, waits for
 * in-flight tasks to complete, then exits. The new process takes over.
 */
export declare class GracefulRestartManager {
    private restarting;
    private host;
    private options;
    private cleanupCallbacks;
    constructor(host: RunnerHost, config?: GracefulRestartConfig);
    /** Register a cleanup callback to run before old process exits. */
    onCleanup(cb: () => Promise<void>): void;
    /** Whether a restart is currently in progress. */
    get isRestarting(): boolean;
    /**
     * Initiate a graceful restart. Both processes run in parallel during the
     * transition: the new process accepts new work while the old one finishes
     * its in-flight tasks.
     *
     * 1. Stop listening (close servers/sockets, free ports)
     * 2. Spawn new process (binds to freed ports, starts accepting)
     * 3. Wait for new process to signal readiness
     * 4. Drain old process (wait for in-flight work to complete)
     * 5. Cleanup and exit old process
     */
    initiateRestart(): Promise<void>;
    private spawnNewProcess;
    private buildSpawnCommand;
    /**
     * Extract visor-specific args from process.argv, skipping the node binary
     * and the script path (which may be an npx-resolved path).
     */
    private extractVisorArgs;
    private waitForChildReady;
}
//# sourceMappingURL=graceful-restart.d.ts.map