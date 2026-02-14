/**
 * Config reloader — orchestrates load → validate → snapshot → swap.
 *
 * On reload:
 * 1. Load and validate config via ConfigManager.loadConfig()
 * 2. Save a snapshot to the store
 * 3. Call onSwap so the caller can update its config reference
 *
 * On error: logs, calls onError, returns false. Old config stays active.
 */
import { logger } from '../logger';
import { ConfigManager } from '../config';
import type { VisorConfig } from '../types/config';
import { ConfigSnapshotStore, createSnapshotFromConfig } from './config-snapshot-store';

export interface ConfigReloaderOptions {
  configPath: string;
  configManager: ConfigManager;
  snapshotStore: ConfigSnapshotStore;
  onSwap: (newConfig: VisorConfig) => void;
  onError?: (err: Error) => void;
}

export class ConfigReloader {
  private configPath: string;
  private configManager: ConfigManager;
  private snapshotStore: ConfigSnapshotStore;
  private onSwap: (newConfig: VisorConfig) => void;
  private onError?: (err: Error) => void;

  constructor(options: ConfigReloaderOptions) {
    this.configPath = options.configPath;
    this.configManager = options.configManager;
    this.snapshotStore = options.snapshotStore;
    this.onSwap = options.onSwap;
    this.onError = options.onError;
  }

  /**
   * Attempt to reload the config file.
   * Returns true if the config was successfully reloaded and swapped.
   */
  async reload(): Promise<boolean> {
    try {
      logger.info(`[ConfigReloader] Reloading config from ${this.configPath}`);
      const newConfig = await this.configManager.loadConfig(this.configPath);

      await this.snapshotStore.save(createSnapshotFromConfig(newConfig, 'reload', this.configPath));

      this.onSwap(newConfig);
      logger.info('[ConfigReloader] Config reloaded successfully');
      return true;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`[ConfigReloader] Reload failed: ${error.message}`);
      if (this.onError) {
        this.onError(error);
      }
      return false;
    }
  }
}
