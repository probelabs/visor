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
  private lastConfigHash: string | null = null;

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
      const snapshot = createSnapshotFromConfig(newConfig, 'reload', this.configPath);

      // Avoid duplicate swaps when multiple filesystem events fire for one edit.
      if (snapshot.config_hash === this.lastConfigHash) {
        logger.debug('[ConfigReloader] No config changes detected; skipping swap');
        return true;
      }

      // Snapshot is best-effort — a save failure must not block the config swap
      try {
        await this.snapshotStore.save(snapshot);
      } catch (snapErr: unknown) {
        logger.warn(
          `[ConfigReloader] Snapshot save failed (config will still be applied): ${snapErr}`
        );
      }

      this.onSwap(newConfig);
      this.lastConfigHash = snapshot.config_hash;
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
