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
    this.workingDirectory = path.resolve(workingDirectory);
    // Load gitignore synchronously during construction
    this.loadGitignore(additionalPatterns);
  }

  /**
   * Load .gitignore patterns from the working directory (called once in constructor)
   * @param additionalPatterns - Additional patterns to add to gitignore rules
   */
  private loadGitignore(additionalPatterns: string[] | null): void {
    // Use path.resolve to prevent path traversal
    const gitignorePath = path.resolve(this.workingDirectory, '.gitignore');
    const resolvedWorkingDir = path.resolve(this.workingDirectory);

    try {
      // Validate that gitignore path is within working directory
      // path.sep ensures correct separator on Windows/Unix
      const normalizedGitignorePath = gitignorePath + path.sep;
      const normalizedWorkingDir = resolvedWorkingDir + path.sep;
      if (!normalizedGitignorePath.startsWith(normalizedWorkingDir)) {
        throw new Error('Invalid gitignore path: path traversal detected');
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
