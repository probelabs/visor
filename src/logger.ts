/*
 * Centralized logger for Visor CLI and Action modes.
 * - Respects output format (suppresses info in JSON/SARIF unless debug)
 * - Supports levels: silent < error < warn < info < verbose < debug
 * - Routes logs to stderr to keep stdout clean for machine-readable output
 */

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

  private write(msg: string): void {
    // Always route to stderr to keep stdout clean for results
    try {
      process.stderr.write(msg + '\n');
    } catch {
      // Ignore write errors
    }
  }

  info(msg: string): void {
    if (this.shouldLog('info')) this.write(msg);
  }

  warn(msg: string): void {
    if (this.shouldLog('warn')) this.write(msg);
  }

  error(msg: string): void {
    if (this.shouldLog('error')) this.write(msg);
  }

  verbose(msg: string): void {
    if (this.shouldLog('verbose')) this.write(msg);
  }

  debug(msg: string): void {
    if (this.shouldLog('debug')) this.write(msg);
  }

  step(msg: string): void {
    // High-level phase indicator
    if (this.shouldLog('info')) this.write(`▶ ${msg}`);
  }

  success(msg: string): void {
    if (this.shouldLog('info')) this.write(`✔ ${msg}`);
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
