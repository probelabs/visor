import { ConfigManager } from '../config';
import type { VisorConfig } from '../types/config';
import { ConfigSnapshotStore } from './config-snapshot-store';
export interface ConfigReloaderOptions {
    configPath: string;
    configManager: ConfigManager;
    snapshotStore: ConfigSnapshotStore;
    onSwap: (newConfig: VisorConfig) => void;
    onError?: (err: Error) => void;
}
export declare class ConfigReloader {
    private configPath;
    private configManager;
    private snapshotStore;
    private onSwap;
    private onError?;
    private lastConfigHash;
    constructor(options: ConfigReloaderOptions);
    /**
     * Attempt to reload the config file.
     * Returns true if the config was successfully reloaded and swapped.
     */
    reload(): Promise<boolean>;
}
//# sourceMappingURL=config-reloader.d.ts.map