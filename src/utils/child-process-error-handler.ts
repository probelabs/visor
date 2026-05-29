/**
 * Global handler for transient child-process I/O errors.
 *
 * When a child process (MCP server, probe agent, sandbox command, etc.) dies
 * unexpectedly, its stdio streams may emit `read EIO`, `write EPIPE`, or
 * similar errors.  If no listener is attached to the stream's `error` event
 * the error bubbles up as an uncaught exception and crashes the entire visor
 * process.
 *
 * Importing this module installs a single, idempotent `uncaughtException`
 * handler that recognises these transient I/O errors, logs a warning, and
 * swallows them so the rest of the process can continue.
 *
 * Usage: import once, as early as possible in every entry point.
 *
 *   import './utils/child-process-error-handler';
 */

import { logger } from '../logger';

const TRANSIENT_IO_CODES = new Set(['EIO', 'EPIPE', 'ECONNRESET']);

export function isChildProcessIOError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errno = (error as NodeJS.ErrnoException).code;
  if (errno && TRANSIENT_IO_CODES.has(errno)) return true;
  const msg = error.message;
  if (msg.includes('read EIO') || msg.includes('write EPIPE')) return true;
  if (msg.includes('ERR_STREAM_DESTROYED')) return true;
  return false;
}

// Guard: register at most once per process, even if the module is loaded
// multiple times (ESM + CJS dual-instance, or re-imported).
const GUARD = Symbol.for('visor.childProcessErrorHandler');
if (!(globalThis as any)[GUARD]) {
  (globalThis as any)[GUARD] = true;

  process.on('uncaughtException', (error: Error, origin: string) => {
    if (isChildProcessIOError(error)) {
      // Log but do NOT crash.  The broken pipe is from a child process that
      // already exited; crashing here would be collateral damage.
      logger.warn(
        `[child-process-error-handler] Suppressed transient I/O error (${origin}): ${error.message}`
      );
      return;
    }
    // Not our error — let other handlers (or the default behaviour) deal with it.
    // Note: Node.js invokes all registered handlers; if none of them call
    // process.exit() the process will continue.  The worktree-manager handler
    // already calls process.exit(1) for non-IO errors.
  });
}
