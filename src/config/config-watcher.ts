/**
 * Config file watcher — watches for file changes and SIGUSR2 signals.
 *
 * Uses fs.watch (no external deps) with debouncing to handle editor quirks
 * (multiple write events per save). SIGUSR2 is guarded for non-Windows only.
 * The watcher uses persistent: false so it doesn't keep the process alive.
 *
 * All reload calls are wrapped in error handling so that failures never
 * propagate as unhandled promise rejections or crash the process.
 */
import fs from 'fs';
import { logger } from '../logger';
import { ConfigReloader } from './config-reloader';

const DEFAULT_DEBOUNCE_MS = 500;

export class ConfigWatcher {
  private configPath: string;
  private reloader: ConfigReloader;
  private debounceMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private signalHandler: (() => void) | null = null;

  constructor(configPath: string, reloader: ConfigReloader, debounceMs?: number) {
    this.configPath = configPath;
    this.reloader = reloader;
    this.debounceMs = debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  start(): void {
    // Remove any previous listeners in case start() is called after stop()
    this.stop();

    // Watch the config file
    try {
      this.watcher = fs.watch(this.configPath, { persistent: false }, _eventType => {
        this.debouncedReload();
      });

      this.watcher.on('error', err => {
        logger.warn(`[ConfigWatcher] File watch error: ${err.message}`);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[ConfigWatcher] Could not watch file: ${msg}`);
    }

    // Listen for SIGUSR2 (non-Windows)
    if (process.platform !== 'win32') {
      this.signalHandler = () => {
        logger.info('[ConfigWatcher] Received SIGUSR2, triggering config reload');
        this.safeReload();
      };
      process.on('SIGUSR2', this.signalHandler);
    }

    logger.info(`[ConfigWatcher] Watching ${this.configPath} for changes`);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.signalHandler) {
      if (process.platform !== 'win32') {
        process.removeListener('SIGUSR2', this.signalHandler);
      }
      this.signalHandler = null;
    }

    logger.debug('[ConfigWatcher] Stopped');
  }

  private debouncedReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      logger.info('[ConfigWatcher] File change detected, reloading config');
      this.safeReload();
    }, this.debounceMs);
  }

  /**
   * Fire-and-forget reload with full error handling.
   * Ensures unhandled promise rejections never escape.
   */
  private safeReload(): void {
    this.reloader.reload().catch(err => {
      logger.error(`[ConfigWatcher] Unhandled reload error: ${err}`);
    });
  }
}
