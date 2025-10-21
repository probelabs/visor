/**
 * Utilities for reading from stdin
 */

/**
 * Check if stdin has data available (is being piped)
 */
export function isStdinAvailable(): boolean {
  // Check if stdin is a TTY (interactive terminal)
  // If it's not a TTY, it means data is being piped
  return !process.stdin.isTTY;
}

/**
 * Read all data from stdin
 * @param timeout Optional timeout in milliseconds
 * @param maxSize Maximum size in bytes (default: 1MB)
 * @returns Promise that resolves with the stdin content
 */
export async function readStdin(timeout?: number, maxSize: number = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let timeoutId: NodeJS.Timeout | undefined;

    if (timeout) {
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Stdin read timeout after ${timeout}ms`));
      }, timeout);
    }

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      // Pause stdin to prevent resource leaks
      process.stdin.pause();
    };

    const onData = (chunk: Buffer) => {
      data += chunk.toString();
      // Security: Prevent DoS through large input
      if (data.length > maxSize) {
        cleanup();
        reject(new Error(`Input exceeds maximum size of ${maxSize} bytes`));
      }
    };

    const onEnd = () => {
      cleanup();
      resolve(data.trim());
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);

    // Resume stdin in case it's paused
    process.stdin.resume();
  });
}

/**
 * Try to read from stdin if available, otherwise return null
 * @param timeout Optional timeout in milliseconds
 * @param maxSize Maximum size in bytes (default: 1MB)
 * @returns Promise that resolves with stdin content or null if not available
 */
export async function tryReadStdin(
  timeout?: number,
  maxSize: number = 1024 * 1024
): Promise<string | null> {
  if (!isStdinAvailable()) {
    return null;
  }

  try {
    return await readStdin(timeout, maxSize);
  } catch {
    // If reading fails, return null
    return null;
  }
}
