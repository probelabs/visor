/*
 * Centralized logger for Visor CLI and Action modes.
 * - Respects output format (suppresses info in JSON/SARIF unless debug)
 * - Supports levels: silent < error < warn < info < verbose < debug
 * - Routes logs to stderr to keep stdout clean for machine-readable output
 */
import { context as otContext, trace } from './telemetry/lazy-otel';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'verbose' | 'debug';

function levelToNumber(level: LogLevel): number {
  switch (level) {
    case 'silent':
      return 0;
    case 'error':
      return 10;
    case 'warn':
      return 20;
    case 'info':
      return 30;
    case 'verbose':
      return 40;
    case 'debug':
      return 50;
  }
}

class Logger {
  private level: LogLevel = 'info';
  private isJsonLike: boolean = false;
  private isTTY: boolean = typeof process !== 'undefined' ? !!process.stderr.isTTY : false;
  private showTimestamps: boolean = true; // default: always show timestamps
  private sink?: (msg: string, level: LogLevel) => void;
  private sinkPassthrough: boolean = true;
  private sinkErrorMode: 'throw' | 'warn' | 'silent' = 'throw';
  private sinkErrorHandler?: (error: unknown) => void;

  configure(
    opts: {
      outputFormat?: string;
      level?: LogLevel;
      debug?: boolean;
      verbose?: boolean;
      quiet?: boolean;
    } = {}
  ): void {
    // Determine base level
    let lvl: LogLevel = 'info';

    if (opts.debug || process.env.VISOR_DEBUG === 'true') {
      lvl = 'debug';
    } else if (opts.verbose || process.env.VISOR_LOG_LEVEL === 'verbose') {
      lvl = 'verbose';
    } else if (opts.quiet || process.env.VISOR_LOG_LEVEL === 'quiet') {
      lvl = 'warn';
    } else if (opts.level) {
      lvl = opts.level;
    } else if (process.env.VISOR_LOG_LEVEL) {
      const envLvl = process.env.VISOR_LOG_LEVEL as LogLevel;
      if (['silent', 'error', 'warn', 'info', 'verbose', 'debug'].includes(envLvl)) {
        lvl = envLvl as LogLevel;
      }
    }

    this.level = lvl;
    const output = opts.outputFormat || process.env.VISOR_OUTPUT_FORMAT || 'table';
    // In JSON/SARIF we suppress non-error logs unless explicitly verbose/debug
    this.isJsonLike = output === 'json' || output === 'sarif';
  }

  setSink(
    sink?: (msg: string, level: LogLevel) => void,
    opts: {
      passthrough?: boolean;
      errorMode?: 'throw' | 'warn' | 'silent';
      onError?: (error: unknown) => void;
    } = {}
  ): void {
    this.sink = sink;
    this.sinkPassthrough = opts.passthrough !== undefined ? opts.passthrough : true;
    this.sinkErrorMode = opts.errorMode || 'throw';
    this.sinkErrorHandler = opts.onError;
  }

  private shouldLog(level: LogLevel): boolean {
    const desired = levelToNumber(level);
    const current = levelToNumber(this.level);
    if (desired > current) return false;
    if (
      this.isJsonLike &&
      desired < levelToNumber('error') &&
      this.level !== 'debug' &&
      this.level !== 'verbose'
    ) {
      // In JSON/SARIF, hide info/warn unless explicitly verbose/debug
      return false;
    }
    return true;
  }

  private getTraceSuffix(msg: string): string {
    if (!msg) return '';
    if (msg.includes('trace_id=') || msg.includes('trace_id:')) return '';
    try {
      const span = trace.getSpan(otContext.active()) || trace.getActiveSpan();
      const ctx = span?.spanContext?.();
      if (!ctx?.traceId) return '';
      return ` [trace_id=${ctx.traceId} span_id=${ctx.spanId}]`;
    } catch {
      return '';
    }
  }

  private write(msg: string, level?: LogLevel): void {
    // Always route to stderr to keep stdout clean for results
    const suffix = this.getTraceSuffix(msg);
    const decoratedMsg = suffix ? `${msg}${suffix}` : msg;
    const lvl = level || 'info';

    if (this.sink) {
      try {
        this.sink(decoratedMsg, lvl);
      } catch (error) {
        if (this.sinkErrorMode === 'warn') {
          try {
            if (this.sinkErrorHandler) {
              this.sinkErrorHandler(error);
            } else {
              const errMsg = error instanceof Error ? error.message : String(error);
              process.stderr.write(`[logger] sink failed: ${errMsg}\n`);
            }
          } catch {
            // ignore secondary failures
          }
        }
        if (this.sinkErrorMode === 'throw') {
          throw error;
        }
        return;
      }
      if (!this.sinkPassthrough) return;
    }

    try {
      if (this.showTimestamps) {
        const ts = new Date().toISOString();
        const lvl = level ? level : undefined;

        let tsToken = `[${ts}]`;
        let lvlToken = lvl ? `[${lvl}]` : '';

        // Add simple ANSI colour when running in a TTY and not emitting
        // JSON/SARIF. Colours are intentionally minimal and only applied
        // to the prefix markers, not the full line.
        if (this.isTTY && !this.isJsonLike) {
          const reset = '\x1b[0m';
          const dim = '\x1b[2m';
          const colours: Record<LogLevel, string> = {
            silent: '',
            error: '\x1b[31m', // red
            warn: '\x1b[33m', // yellow
            info: '\x1b[36m', // cyan
            verbose: '\x1b[35m', // magenta
            debug: '\x1b[90m', // bright black / gray
          };

          tsToken = `${dim}${tsToken}${reset}`;

          if (lvl) {
            const colour = colours[lvl] || '';
            if (colour) {
              lvlToken = `${colour}${lvlToken}${reset}`;
            }
          }
        }

        const prefix = lvl ? `${tsToken} ${lvlToken}` : tsToken;
        process.stderr.write(`${prefix} ${decoratedMsg}\n`);
      } else {
        process.stderr.write(decoratedMsg + '\n');
      }
    } catch {
      // Ignore write errors
    }
  }

  info(msg: string): void {
    if (this.shouldLog('info')) this.write(msg, 'info');
  }

  warn(msg: string): void {
    if (this.shouldLog('warn')) this.write(msg, 'warn');
  }

  error(msg: string): void {
    if (this.shouldLog('error')) this.write(msg, 'error');
  }

  verbose(msg: string): void {
    if (this.shouldLog('verbose')) this.write(msg, 'verbose');
  }

  debug(msg: string): void {
    if (this.shouldLog('debug')) this.write(msg, 'debug');
  }

  step(msg: string): void {
    // High-level phase indicator
    if (this.shouldLog('info')) this.write(`▶ ${msg}`, 'info');
  }

  success(msg: string): void {
    if (this.shouldLog('info')) this.write(`✔ ${msg}`, 'info');
  }
}

// Singleton instance
export const logger = new Logger();

// Helper to configure from CLI options in a single place
export function configureLoggerFromCli(options: {
  output?: string;
  debug?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}): void {
  logger.configure({
    outputFormat: options.output,
    debug: options.debug,
    verbose: options.verbose,
    quiet: options.quiet,
  });

  // Expose output format and debug to process env for modules that need to gate
  // stdout emissions without plumbing the value through every call site.
  try {
    if (options.output) process.env.VISOR_OUTPUT_FORMAT = String(options.output);
    if (typeof options.debug === 'boolean') {
      process.env.VISOR_DEBUG = options.debug ? 'true' : 'false';
    }
  } catch {
    // ignore
  }
}
