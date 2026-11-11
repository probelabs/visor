import { ConfigReloader } from './config-reloader';
/**
 * Collect all local file paths that a config depends on by parsing YAML
 * and following extends/include/imports chains recursively.
 * Remote URLs and the special "default" source are skipped.
 */
export declare function collectLocalConfigDeps(configPath: string, visited?: Set<string>): string[];
export declare class ConfigWatcher {
    private configPath;
    private reloader;
    private debounceMs;
    private watchers;
    private debounceTimer;
    private signalHandler;
    private lastProcessedMtimes;
    constructor(configPath: string, reloader: ConfigReloader, debounceMs?: number);
    start(options?: {
        listenForSignals?: boolean;
    }): void;
    stop(): void;
    /**
     * Refresh the set of watched files after a successful reload.
     * New dependencies are watched; removed ones are unwatched.
     */
    private refreshWatches;
    private collectWatchTargets;
    private watchFile;
    private debouncedReload;
    /**
     * Fire-and-forget reload with full error handling.
     * On success, refreshes the watch list to pick up new/removed dependencies.
     * Ensures unhandled promise rejections never escape.
     */
    private safeReload;
}
//# sourceMappingURL=config-watcher.d.ts.map