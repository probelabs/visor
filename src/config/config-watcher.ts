/**
 * Config file watcher — watches for file changes and SIGUSR2 signals.
 *
 * Watches the main config file AND all local dependencies (extends, include,
 * imports) so that changes to nested workflows, skills, or parent configs
 * trigger a reload.
 *
 * Uses fs.watch (no external deps) with debouncing to handle editor quirks
 * (multiple write events per save). SIGUSR2 is guarded for non-Windows only.
 * All watchers use persistent: false so they don't keep the process alive.
 *
 * After each successful reload the watch list is refreshed so newly added
 * or removed dependencies are tracked automatically.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';
import { ConfigReloader } from './config-reloader';

const DEFAULT_DEBOUNCE_MS = 500;

/**
 * Collect all local file paths that a config depends on by parsing YAML
 * and following extends/include/imports chains recursively.
 * Remote URLs and the special "default" source are skipped.
 */
export function collectLocalConfigDeps(configPath: string, visited?: Set<string>): string[] {
  visited = visited || new Set();
  const absPath = path.resolve(configPath);
  if (visited.has(absPath)) return [];
  visited.add(absPath);

  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }

  // Use a lightweight YAML parse — js-yaml is already a bundled dependency
  let parsed: any;
  try {
    const yaml = require('js-yaml') as typeof import('js-yaml');
    parsed = yaml.load(content);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') return [];

  const deps: string[] = [];
  const baseDir = path.dirname(absPath);

  const isLocal = (src: string): boolean =>
    typeof src === 'string' &&
    src !== 'default' &&
    !src.startsWith('http://') &&
    !src.startsWith('https://');

  // extends / include
  const extendsVal = parsed.extends || parsed.include;
  if (extendsVal) {
    const sources: string[] = Array.isArray(extendsVal) ? extendsVal : [extendsVal];
    for (const src of sources) {
      if (!isLocal(src)) continue;
      const resolved = path.resolve(baseDir, src);
      deps.push(resolved);
      deps.push(...collectLocalConfigDeps(resolved, visited));
    }
  }

  // imports (workflow / skill files)
  if (Array.isArray(parsed.imports)) {
    for (const src of parsed.imports) {
      if (!isLocal(src)) continue;
      const resolved = path.resolve(baseDir, src);
      deps.push(resolved);
      deps.push(...collectLocalConfigDeps(resolved, visited));
    }
  }

  // checks/steps that reference external workflow configs via `config:` field
  const checks = parsed.checks || parsed.steps;
  if (checks && typeof checks === 'object') {
    for (const check of Object.values(checks) as any[]) {
      if (
        check?.type === 'workflow' &&
        typeof check?.config === 'string' &&
        isLocal(check.config)
      ) {
        const resolved = path.resolve(baseDir, check.config);
        deps.push(resolved);
        deps.push(...collectLocalConfigDeps(resolved, visited));
      }
    }
  }

  return deps;
}

export class ConfigWatcher {
  private configPath: string;
  private reloader: ConfigReloader;
  private debounceMs: number;
  private watchers: Map<string, { close: () => void }> = new Map();
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

    // Collect all files to watch: main config + dependencies
    const filesToWatch = this.collectWatchTargets();

    for (const filePath of filesToWatch) {
      this.watchFile(filePath);
    }

    // Listen for SIGUSR2 (non-Windows)
    if (process.platform !== 'win32') {
      this.signalHandler = () => {
        logger.info('[ConfigWatcher] Received SIGUSR2, triggering config reload');
        this.safeReload();
      };
      process.on('SIGUSR2', this.signalHandler);
    }

    const depCount = filesToWatch.length - 1;
    const depMsg = depCount > 0 ? ` (+ ${depCount} dependencies)` : '';
    logger.info(`[ConfigWatcher] Watching ${this.configPath}${depMsg} for changes`);
  }

  stop(): void {
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();

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

  /**
   * Refresh the set of watched files after a successful reload.
   * New dependencies are watched; removed ones are unwatched.
   */
  private refreshWatches(): void {
    const newTargets = new Set(this.collectWatchTargets());
    const current = new Set(this.watchers.keys());

    // Stop watching removed files
    for (const filePath of current) {
      if (!newTargets.has(filePath)) {
        this.watchers.get(filePath)?.close();
        this.watchers.delete(filePath);
        logger.debug(`[ConfigWatcher] Unwatched removed dep: ${filePath}`);
      }
    }

    // Start watching new files
    for (const filePath of newTargets) {
      if (!current.has(filePath)) {
        this.watchFile(filePath);
        logger.debug(`[ConfigWatcher] Watching new dep: ${filePath}`);
      }
    }
  }

  private collectWatchTargets(): string[] {
    const mainPath = path.resolve(this.configPath);
    const deps = collectLocalConfigDeps(this.configPath);
    // Deduplicate
    return [...new Set([mainPath, ...deps])];
  }

  private watchFile(filePath: string): void {
    const closeFns: Array<() => void> = [];

    try {
      const watcher = fs.watch(filePath, { persistent: false }, _eventType => {
        this.debouncedReload();
      });

      watcher.on('error', err => {
        logger.warn(`[ConfigWatcher] Watch error on ${filePath}: ${err.message}`);
      });

      closeFns.push(() => watcher.close());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[ConfigWatcher] Could not watch ${filePath}: ${msg}`);
    }

    // Fallback polling watcher for environments where fs.watch can miss events.
    const pollIntervalMs = Math.max(100, Math.floor(this.debounceMs / 2));
    const pollListener = (curr: fs.Stats, prev: fs.Stats) => {
      if (
        curr.mtimeMs !== prev.mtimeMs ||
        curr.ctimeMs !== prev.ctimeMs ||
        curr.size !== prev.size
      ) {
        this.debouncedReload();
      }
    };
    fs.watchFile(filePath, { interval: pollIntervalMs, persistent: false }, pollListener);
    closeFns.push(() => fs.unwatchFile(filePath, pollListener));

    this.watchers.set(filePath, {
      close: () => {
        for (const close of closeFns) {
          close();
        }
      },
    });
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
   * On success, refreshes the watch list to pick up new/removed dependencies.
   * Ensures unhandled promise rejections never escape.
   */
  private safeReload(): void {
    this.reloader
      .reload()
      .then(success => {
        if (success) {
          this.refreshWatches();
        }
      })
      .catch(err => {
        logger.error(`[ConfigWatcher] Unhandled reload error: ${err}`);
      });
  }
}
