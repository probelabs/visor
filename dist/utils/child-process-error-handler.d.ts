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
export declare function isChildProcessIOError(error: unknown): boolean;
//# sourceMappingURL=child-process-error-handler.d.ts.map