import ignore from 'ignore';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Default exclusion patterns for common build artifacts and dependencies.
 * These can be overridden by providing custom patterns to the constructor.
 */
const DEFAULT_EXCLUSION_PATTERNS = [
  'dist/',
  'build/',
  '.next/',
  'out/',
  'node_modules/',
  'coverage/',
  '.turbo/',
  'bundled/',
];

/**
 * Shared utility for filtering files based on .gitignore patterns
 *
 * Design Decision: Synchronous I/O in Constructor
 * ------------------------------------------------
 * This class intentionally uses synchronous file I/O in the constructor for the following reasons:
 *
 * 1. **Initialization Context**: The constructor is called once during application startup,
 *    not in request handling or performance-critical paths.
 *
 * 2. **Small File Sizes**: .gitignore files are typically <10KB. Even in large monorepos,
 *    they rarely exceed 100KB. Reading such small files synchronously has negligible impact.
 *
 * 3. **Immediate Availability**: The exclusion patterns must be ready immediately for use.
 *    Asynchronous initialization would require either:
 *    - Async factory method (adds API complexity)
 *    - Lazy loading (race conditions, repeated checks)
 *    - Promise-based initialization (complicates usage across codebase)
 *
 * 4. **Simplicity**: Synchronous loading keeps the API simple and prevents async contagion
 *    throughout the codebase. Methods like shouldExcludeFile() remain synchronous.
 *
 * 5. **No DoS Risk**: The file reading happens exactly once per instance during construction.
 *    Attackers cannot trigger repeated synchronous reads.
 *
 * 6. **Consistency**: This follows the same pattern as other configuration loaders in Node.js
 *    ecosystem (e.g., require(), cosmiconfig's sync mode).
 *
 * Alternative Considered: Async factory pattern would add complexity without meaningful benefit
 * given the usage patterns and file sizes involved.
 */
export class FileExclusionHelper {
  private gitignore: ReturnType<typeof ignore> | null = null;
  private workingDirectory: string;

  /**
   * @param workingDirectory - Directory to search for .gitignore
   * @param additionalPatterns - Additional patterns to include (optional, defaults to common build artifacts)
   */
  constructor(
    workingDirectory: string = process.cwd(),
    additionalPatterns: string[] | null = DEFAULT_EXCLUSION_PATTERNS
  ) {
    // Validate and normalize workingDirectory to prevent path traversal
    const normalizedPath = path.resolve(workingDirectory);

    // Ensure path doesn't contain suspicious patterns after normalization
    // Check for null bytes which could be used for injection
    if (normalizedPath.includes('\0')) {
      throw new Error('Invalid workingDirectory: contains null bytes');
    }

    this.workingDirectory = normalizedPath;

    // Load gitignore synchronously during construction
    // This is acceptable because:
    // 1. Constructor is called once during initialization
    // 2. .gitignore files are typically small (<10KB)
    // 3. Synchronous loading ensures patterns are ready immediately
    // 4. Avoids async constructor complexity
    this.loadGitignore(additionalPatterns);
  }

  /**
   * Load .gitignore patterns from the working directory (called once in constructor)
   * @param additionalPatterns - Additional patterns to add to gitignore rules
   */
  private loadGitignore(additionalPatterns: string[] | null): void {
    // Resolve both paths to absolute, normalized forms
    const gitignorePath = path.resolve(this.workingDirectory, '.gitignore');
    const resolvedWorkingDir = path.resolve(this.workingDirectory);

    try {
      // Robust path validation using path.relative()
      // This handles symlinks and edge cases better than string comparison
      const relativePath = path.relative(resolvedWorkingDir, gitignorePath);

      // Security check: ensure .gitignore is within working directory
      // Reject if:
      // - Starts with '..' (parent directory)
      // - Is an absolute path (should be relative after path.relative())
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error('Invalid gitignore path: path traversal detected');
      }

      // Additionally verify it's exactly '.gitignore' (no subdirectories)
      if (relativePath !== '.gitignore') {
        throw new Error('Invalid gitignore path: must be .gitignore in working directory');
      }

      this.gitignore = ignore();

      // Add additional patterns first (lower priority)
      if (additionalPatterns && additionalPatterns.length > 0) {
        this.gitignore.add(additionalPatterns);
      }

      // Load and add .gitignore patterns (higher priority)
      if (fs.existsSync(gitignorePath)) {
        const rawContent = fs.readFileSync(gitignorePath, 'utf8');

        // Comprehensive sanitization to prevent injection attacks
        const gitignoreContent = rawContent
          .replace(/[\r\n]+/g, '\n') // Normalize line endings first
          .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '') // Remove control chars except \n (0x0A)
          .split('\n')
          .filter(line => line.length < 1000) // Reject extremely long lines that could cause DoS
          .join('\n')
          .trim();

        this.gitignore.add(gitignoreContent);
        console.error('✅ Loaded .gitignore patterns for file filtering');
      } else if (additionalPatterns && additionalPatterns.length > 0) {
        console.error('⚠️  No .gitignore found, using default exclusion patterns');
      }
    } catch (error) {
      console.warn('⚠️ Failed to load .gitignore:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Check if a file should be excluded based on .gitignore patterns
   */
  shouldExcludeFile(filename: string): boolean {
    // Check against .gitignore patterns if loaded
    if (this.gitignore) {
      return this.gitignore.ignores(filename);
    }

    return false;
  }
}
