import * as fs from 'fs';
import * as path from 'path';
import { ReviewIssue } from './reviewer';

/**
 * Filter for suppressing Visor issues based on special comments in code
 */
export class IssueFilter {
  private fileCache: Map<string, string[]> = new Map();
  private suppressionEnabled: boolean;

  constructor(suppressionEnabled: boolean = true) {
    this.suppressionEnabled = suppressionEnabled;
  }

  /**
   * Filter out issues that have suppression comments
   * @param issues Array of issues to filter
   * @param workingDir Working directory for resolving file paths
   * @returns Filtered array of issues with suppressed ones removed
   */
  public filterIssues(issues: ReviewIssue[], workingDir: string = process.cwd()): ReviewIssue[] {
    if (!this.suppressionEnabled || !issues || issues.length === 0) {
      return issues;
    }

    const filteredIssues: ReviewIssue[] = [];
    const suppressedCount: { [file: string]: number } = {};

    for (const issue of issues) {
      if (this.shouldSuppressIssue(issue, workingDir)) {
        // Track suppressed issues for logging
        suppressedCount[issue.file] = (suppressedCount[issue.file] || 0) + 1;
      } else {
        filteredIssues.push(issue);
      }
    }

    // Log suppression summary if any issues were suppressed
    const totalSuppressed = Object.values(suppressedCount).reduce((sum, count) => sum + count, 0);
    if (totalSuppressed > 0) {
      console.log(`🔇 Suppressed ${totalSuppressed} issue(s) via visor-disable comments:`);
      for (const [file, count] of Object.entries(suppressedCount)) {
        console.log(`   - ${file}: ${count} issue(s)`);
      }
    }

    return filteredIssues;
  }

  /**
   * Check if an issue should be suppressed based on comments in the file
   */
  private shouldSuppressIssue(issue: ReviewIssue, workingDir: string): boolean {
    // Skip system-level issues or issues without file/line info
    if (!issue.file || issue.file === 'system' || issue.file === 'webhook' || issue.line === 0) {
      return false;
    }

    const lines = this.getFileLines(issue.file, workingDir);
    if (!lines || lines.length === 0) {
      return false;
    }

    // Check for file-level suppression (visor-disable-file in first 5 lines)
    const firstFiveLines = lines.slice(0, 5).join('\n').toLowerCase();
    if (firstFiveLines.includes('visor-disable-file')) {
      return true;
    }

    // Check for line-level suppression (visor-disable within ±2 lines)
    const lineIndex = issue.line - 1; // Convert to 0-based index
    const startLine = Math.max(0, lineIndex - 2);
    const endLine = Math.min(lines.length - 1, lineIndex + 2);

    for (let i = startLine; i <= endLine; i++) {
      if (lines[i].toLowerCase().includes('visor-disable')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get file lines from cache or read from disk
   */
  private getFileLines(filePath: string, workingDir: string): string[] | null {
    // Check cache first
    if (this.fileCache.has(filePath)) {
      return this.fileCache.get(filePath)!;
    }

    try {
      // Resolve the file path
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workingDir, filePath);

      if (!fs.existsSync(resolvedPath)) {
        // Try without working directory if the file doesn't exist
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n');
          this.fileCache.set(filePath, lines);
          return lines;
        }
        return null;
      }

      const content = fs.readFileSync(resolvedPath, 'utf8');
      const lines = content.split('\n');
      this.fileCache.set(filePath, lines);
      return lines;
    } catch {
      // Silently skip files that can't be read
      return null;
    }
  }

  /**
   * Clear the file cache (useful for testing or long-running processes)
   */
  public clearCache(): void {
    this.fileCache.clear();
  }
}
