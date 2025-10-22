/**
 * Utilities for reading from stdin
 */
/**
 * Check if stdin has data available (is being piped)
 */
export declare function isStdinAvailable(): boolean;
/**
 * Read all data from stdin
 * @param timeout Optional timeout in milliseconds
 * @param maxSize Maximum size in bytes (default: 1MB)
 * @returns Promise that resolves with the stdin content
 */
export declare function readStdin(timeout?: number, maxSize?: number): Promise<string>;
/**
 * Try to read from stdin if available, otherwise return null
 * @param timeout Optional timeout in milliseconds
 * @param maxSize Maximum size in bytes (default: 1MB)
 * @returns Promise that resolves with stdin content or null if not available
 */
export declare function tryReadStdin(timeout?: number, maxSize?: number): Promise<string | null>;
//# sourceMappingURL=stdin-reader.d.ts.map