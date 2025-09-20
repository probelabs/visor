import { IssueFilter } from '../../src/issue-filter';
import { ReviewIssue } from '../../src/reviewer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('IssueFilter', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-filter-test-'));
  });

  afterEach(() => {
    // Clean up temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('filterIssues', () => {
    it('should not filter issues when suppression is disabled', () => {
      const filter = new IssueFilter(false);
      const issues: ReviewIssue[] = [
        {
          file: 'test.js',
          line: 10,
          ruleId: 'test-rule',
          message: 'Test issue',
          severity: 'warning',
          category: 'logic',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(1);
      expect(result).toEqual(issues);
    });

    it('should return empty array for empty input', () => {
      const filter = new IssueFilter(true);
      const result = filter.filterIssues([], tempDir);
      expect(result).toHaveLength(0);
    });

    it('should not filter system-level issues', () => {
      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: 'system',
          line: 0,
          ruleId: 'system-error',
          message: 'System error',
          severity: 'error',
          category: 'logic',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(1);
      expect(result).toEqual(issues);
    });

    it('should suppress issue when visor-disable is on the same line', () => {
      const testFile = path.join(tempDir, 'test.js');
      const content = `
        function test() {
          console.log('line 3');
          const x = 10; // visor-disable
          return x;
        }
      `;
      fs.writeFileSync(testFile, content);

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: testFile,
          line: 4,
          ruleId: 'test-rule',
          message: 'Test issue',
          severity: 'warning',
          category: 'logic',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(0);
    });

    it('should suppress issue when visor-disable is within ±2 lines', () => {
      const testFile = path.join(tempDir, 'test.js');
      const content = `
        function test() {
          // visor-disable
          console.log('line 3');
          const x = 10;
          return x;
        }
      `;
      fs.writeFileSync(testFile, content);

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: testFile,
          line: 4,
          ruleId: 'test-rule',
          message: 'Test issue on line 4',
          severity: 'warning',
          category: 'logic',
        },
        {
          file: testFile,
          line: 5,
          ruleId: 'test-rule',
          message: 'Test issue on line 5',
          severity: 'warning',
          category: 'logic',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(0);
    });

    it('should suppress all issues in file when visor-disable-file is in first 5 lines', () => {
      const testFile = path.join(tempDir, 'test.js');
      const content = `// visor-disable-file
        function test() {
          console.log('line 3');
          const x = 10;
          return x;
        }

        function another() {
          const y = 20;
          return y;
        }
      `;
      fs.writeFileSync(testFile, content);

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: testFile,
          line: 4,
          ruleId: 'test-rule',
          message: 'Test issue on line 4',
          severity: 'warning',
          category: 'logic',
        },
        {
          file: testFile,
          line: 9,
          ruleId: 'test-rule',
          message: 'Test issue on line 9',
          severity: 'warning',
          category: 'logic',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(0);
    });

    it('should not suppress issues when visor-disable-file is after line 5', () => {
      const testFile = path.join(tempDir, 'test.js');
      const content = `
        function test() {
          console.log('line 3');
          const x = 10;
          return x;
        }
        // visor-disable-file (too late, after line 5)

        function another() {
          const y = 20;
          return y;
        }
      `;
      fs.writeFileSync(testFile, content);

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: testFile,
          line: 10,
          ruleId: 'test-rule',
          message: 'Test issue',
          severity: 'warning',
          category: 'logic',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(1);
    });

    it('should handle case-insensitive visor-disable comments', () => {
      const testFile = path.join(tempDir, 'test.js');
      const content = `
        function test() {
          // VISOR-DISABLE
          const x = 10;
          return x;
        }
      `;
      fs.writeFileSync(testFile, content);

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: testFile,
          line: 4,
          ruleId: 'test-rule',
          message: 'Test issue',
          severity: 'warning',
          category: 'logic',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(0);
    });

    it('should handle relative file paths', () => {
      const testFile = 'test.js';
      const fullPath = path.join(tempDir, testFile);
      const content = `
        function test() {
          const x = 10; // visor-disable
          return x;
        }
      `;
      fs.writeFileSync(fullPath, content);

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: testFile,
          line: 3,
          ruleId: 'test-rule',
          message: 'Test issue',
          severity: 'warning',
          category: 'logic',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(0);
    });

    it('should not suppress issues outside the ±2 line range', () => {
      const testFile = path.join(tempDir, 'test.js');
      const content = `
        function test() {
          // visor-disable
          console.log('line 3');
          console.log('line 4');
          console.log('line 5');
          console.log('line 6');
          const x = 10; // This is line 8
          return x;
        }
      `;
      fs.writeFileSync(testFile, content);

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: testFile,
          line: 8,
          ruleId: 'test-rule',
          message: 'Test issue',
          severity: 'warning',
          category: 'logic',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(1);
    });

    it('should handle non-existent files gracefully', () => {
      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: 'non-existent.js',
          line: 10,
          ruleId: 'test-rule',
          message: 'Test issue',
          severity: 'warning',
          category: 'logic',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(1);
      expect(result).toEqual(issues);
    });

    it('should cache file reads for performance', () => {
      const testFile = path.join(tempDir, 'test.js');
      const content = `
        function test() {
          const x = 10;
          const y = 20;
          return x + y;
        }
      `;
      fs.writeFileSync(testFile, content);

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: testFile,
          line: 3,
          ruleId: 'test-rule',
          message: 'Test issue 1',
          severity: 'warning',
          category: 'logic',
        },
        {
          file: testFile,
          line: 4,
          ruleId: 'test-rule',
          message: 'Test issue 2',
          severity: 'warning',
          category: 'logic',
        },
      ];

      // First call should read the file
      const result1 = filter.filterIssues([issues[0]], tempDir);
      expect(result1).toHaveLength(1);

      // Second call with the same file should use cache (not read again)
      // We can verify this by modifying the file and seeing it doesn't affect the result
      fs.writeFileSync(testFile, '// visor-disable-file\n' + content);

      const result2 = filter.filterIssues([issues[1]], tempDir);
      // Should still return 1 issue because it's using cached content (without visor-disable-file)
      expect(result2).toHaveLength(1);

      // After clearing cache, it should read the new content
      filter.clearCache();
      const result3 = filter.filterIssues([issues[1]], tempDir);
      // Now it should suppress due to visor-disable-file
      expect(result3).toHaveLength(0);
    });

    it('should log suppressed issues summary', () => {
      const testFile = path.join(tempDir, 'test.js');
      const content = `
        function test() {
          const x = 10; // visor-disable
          return x;
        }
      `;
      fs.writeFileSync(testFile, content);

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: testFile,
          line: 3,
          ruleId: 'test-rule',
          message: 'Test issue',
          severity: 'warning',
          category: 'logic',
        },
      ];

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const result = filter.filterIssues(issues, tempDir);

      expect(result).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Suppressed 1 issue(s)'));

      consoleSpy.mockRestore();
    });
  });

  describe('clearCache', () => {
    it('should clear the file cache', () => {
      const testFile = path.join(tempDir, 'test.js');
      const content1 = 'const x = 10;';
      const content2 = 'const x = 10; // visor-disable';

      fs.writeFileSync(testFile, content1);

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: testFile,
          line: 1,
          ruleId: 'test-rule',
          message: 'Test issue',
          severity: 'warning',
          category: 'logic',
        },
      ];

      // First call should not suppress
      let result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(1);

      // Update file content
      fs.writeFileSync(testFile, content2);

      // Without clearing cache, it would still use old content
      result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(1);

      // Clear cache and try again
      filter.clearCache();
      result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(0);
    });
  });
});
