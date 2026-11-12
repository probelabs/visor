import { ConfigManager } from '../config';
import type { VisorConfig } from '../types/config';
export interface RunnerConfigReloadRuntimeOptions {
    configPath?: string;
    watch: boolean;
    configManager: ConfigManager;
    onSwap: (newConfig: VisorConfig) => void;
}
export interface RunnerConfigReloadRuntime {
    cleanup(): Promise<void>;
}
export declare function setupRunnerConfigReloadRuntime(options: RunnerConfigReloadRuntimeOptions): Promise<RunnerConfigReloadRuntime>;
//# sourceMappingURL=config-reload-runtime.d.ts.map