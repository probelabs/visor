import ignore from 'ignore';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Shared utility for filtering files based on .gitignore patterns and common build directories
 */
export class FileExclusionHelper {
  private gitignore: ReturnType<typeof ignore> | null = null;
  private gitignoreLoaded = false;
  private workingDirectory: string;

  constructor(workingDirectory: string = process.cwd()) {
    this.workingDirectory = path.resolve(workingDirectory);
  }

  /**
   * Load .gitignore patterns from the working directory
   */
  private loadGitignore(): void {
    if (this.gitignoreLoaded) {
      return;
    }

    this.gitignoreLoaded = true;
    const gitignorePath = path.join(this.workingDirectory, '.gitignore');

    try {
      if (fs.existsSync(gitignorePath)) {
        const rawContent = fs.readFileSync(gitignorePath, 'utf8');
        // Sanitize content to prevent injection attacks
        const gitignoreContent = rawContent.replace(/[\r\n]+/g, '\n').trim();
        this.gitignore = ignore().add(gitignoreContent);
        console.log('✅ Loaded .gitignore patterns for file filtering');
      }
    } catch (error) {
      console.warn('⚠️ Failed to load .gitignore:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Check if a file should be excluded based on .gitignore patterns and common build directories
   */
  shouldExcludeFile(filename: string): boolean {
    // Load gitignore on first check
    if (!this.gitignoreLoaded) {
      this.loadGitignore();
    }

    // Check common build directories that should be excluded even if tracked
    const excludePatterns = [
      /^dist\//,
      /^build\//,
      /^\.next\//,
      /^out\//,
      /^node_modules\//,
      /^coverage\//,
      /^\.turbo\//,
      /^bundled\//,
    ];

    for (const pattern of excludePatterns) {
      if (pattern.test(filename)) {
        return true;
      }
    }

    // Check against .gitignore patterns if loaded
    if (this.gitignore) {
      return this.gitignore.ignores(filename);
    }

    return false;
  }
}
