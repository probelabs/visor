/**
 * Environment variable filtering for sandbox execution.
 * Filters host environment variables based on passthrough patterns
 * before forwarding them into sandbox containers.
 */

/** Default env vars always forwarded into sandboxes */
const DEFAULT_PASSTHROUGH = ['PATH', 'HOME', 'USER', 'CI', 'NODE_ENV', 'LANG'];

/**
 * Test if a string matches a glob-like pattern with * wildcards.
 * Only supports trailing wildcards (e.g., "GITHUB_*").
 */
function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return name.startsWith(prefix);
  }
  return false;
}

/**
 * Filter environment variables for sandbox forwarding.
 *
 * @param checkEnv - Check-level env overrides (always included)
 * @param hostEnv - Host process.env to filter
 * @param passthroughPatterns - Glob patterns from sandbox config env_passthrough
 * @returns Merged environment variables safe for the sandbox
 */
export function filterEnvForSandbox(
  checkEnv: Record<string, string | number | boolean> | undefined,
  hostEnv: Record<string, string | undefined>,
  passthroughPatterns?: string[]
): Record<string, string> {
  const result: Record<string, string> = {};

  // Combine default patterns with user-specified patterns
  const patterns = [...DEFAULT_PASSTHROUGH, ...(passthroughPatterns || [])];

  // Filter host env vars by patterns
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (patterns.some(pattern => matchesPattern(key, pattern))) {
      result[key] = value;
    }
  }

  // Check-level env always overrides (convert non-string values)
  if (checkEnv) {
    for (const [key, value] of Object.entries(checkEnv)) {
      result[key] = String(value);
    }
  }

  return result;
}
