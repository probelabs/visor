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
export declare class FileExclusionHelper {
    private gitignore;
    private workingDirectory;
    /**
     * @param workingDirectory - Directory to search for .gitignore
     * @param additionalPatterns - Additional patterns to include (optional, defaults to common build artifacts)
     */
    constructor(workingDirectory?: string, additionalPatterns?: string[] | null);
    /**
     * Load .gitignore patterns from the working directory (called once in constructor)
     * @param additionalPatterns - Additional patterns to add to gitignore rules
     */
    private loadGitignore;
    /**
     * Check if a file should be excluded based on .gitignore patterns
     */
    shouldExcludeFile(filename: string): boolean;
}
//# sourceMappingURL=file-exclusion.d.ts.map