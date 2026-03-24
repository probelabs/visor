import { logger } from '../logger';
import { ConfigManager } from '../config';
import type { VisorConfig } from '../types/config';
import { ConfigSnapshotStore } from '../config/config-snapshot-store';
import { ConfigReloader } from '../config/config-reloader';
import { ConfigWatcher } from '../config/config-watcher';

export interface RunnerConfigReloadRuntimeOptions {
  configPath?: string;
  watch: boolean;
  configManager: ConfigManager;
  onSwap: (newConfig: VisorConfig) => void;
}

export interface RunnerConfigReloadRuntime {
  cleanup(): Promise<void>;
}

export async function setupRunnerConfigReloadRuntime(
  options: RunnerConfigReloadRuntimeOptions
): Promise<RunnerConfigReloadRuntime> {
  let snapshotStore: ConfigSnapshotStore | undefined;
  let watcher: ConfigWatcher | undefined;
  let signalHandler: (() => void) | undefined;

  if (process.platform !== 'win32') {
    if (options.configPath) {
      try {
        snapshotStore = new ConfigSnapshotStore();
        await snapshotStore.initialize();

        const reloader = new ConfigReloader({
          configPath: options.configPath,
          configManager: options.configManager,
          snapshotStore,
          onSwap: options.onSwap,
        });

        signalHandler = () => {
          logger.info('[ConfigReload] Received SIGUSR2, triggering config reload');
          void reloader.reload();
        };
        process.on('SIGUSR2', signalHandler);
        logger.info('[ConfigReload] Send SIGUSR2 to hot-reload configuration');

        if (options.watch) {
          watcher = new ConfigWatcher(options.configPath, reloader);
          watcher.start({ listenForSignals: false });
          logger.info('Config watching enabled');
        }
      } catch (err: unknown) {
        logger.warn(`Config reload setup failed (runners continue without it): ${err}`);
      }
    } else {
      signalHandler = () => {
        logger.warn('[ConfigReload] Ignoring SIGUSR2: no --config path configured');
      };
      process.on('SIGUSR2', signalHandler);
      logger.info(
        '[ConfigReload] Send SIGUSR2 to hot-reload configuration (will be ignored without --config)'
      );
    }
  }

  return {
    async cleanup(): Promise<void> {
      if (watcher) watcher.stop();
      if (signalHandler && process.platform !== 'win32') {
        process.removeListener('SIGUSR2', signalHandler);
      }
      if (snapshotStore) {
        await snapshotStore.shutdown().catch(() => {});
      }
    },
  };
}
