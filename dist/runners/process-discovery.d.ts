/**
 * Cross-platform (Linux + macOS) discovery of running Visor processes.
 *
 * Zero dependencies — uses `ps` for process listing and OS-specific
 * methods for reading each process's working directory:
 *   - Linux:  readlink /proc/<pid>/cwd
 *   - macOS:  lsof -d cwd -a -p <pid>
 */
export interface VisorProcess {
    pid: number;
    cwd: string;
    cmd: string;
    /** Seconds since process started */
    uptimeSecs?: number;
}
/**
 * Find all running Visor processes whose cwd matches `targetDir`.
 * Excludes the current process.
 */
export declare function findVisorProcesses(targetDir?: string): VisorProcess[];
/**
 * Send a signal to a Visor process.
 */
export declare function signalProcess(pid: number, signal: 'SIGUSR1' | 'SIGUSR2' | 'SIGTERM'): boolean;
/**
 * Check if a process is alive.
 */
export declare function isProcessAlive(pid: number): boolean;
//# sourceMappingURL=process-discovery.d.ts.map