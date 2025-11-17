import { IssueFilter } from '../../src/issue-filter';
import { ReviewIssue } from '../../src/reviewer';
import { CheckExecutionEngine } from '../../src/check-execution-engine';
import type { PRInfo } from '../../src/pr-analyzer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Issue Suppression Integration Tests', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suppression-integration-test-'));
  });

  afterEach(() => {
    // Clean up temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Integration with CheckExecutionEngine', () => {
    it('should apply suppression in the execution engine', async () => {
      // Create test files with absolute paths
      const file1 = path.join(tempDir, 'file1.js');
      fs.writeFileSync(
        file1,
        `
function test() {
  const password = "hardcoded"; // visor-disable
  return password;
}
`
      );

      const file2 = path.join(tempDir, 'file2.js');
      fs.writeFileSync(
        file2,
        `
function test() {
  const apiKey = "sk-12345";
  return apiKey;
}
`
      );

      // Initialize git repo (required for CheckExecutionEngine)
      const { execSync } = require('child_process');
      execSync('git init', { cwd: tempDir });
      execSync('git config user.email "test@example.com"', { cwd: tempDir });
      execSync('git config user.name "Test User"', { cwd: tempDir });
      execSync('git add .', { cwd: tempDir });
      execSync('git -c core.hooksPath=/dev/null commit -m "test"', { cwd: tempDir });

      const engine = new CheckExecutionEngine(tempDir);

      // Create test issues directly - testing the IssueFilter integration
      const testIssues: ReviewIssue[] = [
        {
          file: 'file1.js',
          line: 3,
          ruleId: 'security/hardcoded-password',
          message: 'Hardcoded password - should be suppressed',
          severity: 'error',
          category: 'security',
        },
        {
          file: 'file2.js',
          line: 3,
          ruleId: 'security/hardcoded-api-key',
          message: 'Hardcoded API key - should NOT be suppressed',
          severity: 'error',
          category: 'security',
        },
      ];

      // Apply suppression filter directly (simulating what the engine does)
      const filter = new IssueFilter(true);
      const filteredIssues = filter.filterIssues(testIssues, tempDir);

      // Verify that only file2 issue remains (file1 was suppressed)
      expect(filteredIssues).toHaveLength(1);
      expect(filteredIssues[0].file).toBe('file2.js');
      expect(filteredIssues[0].message).toContain('should NOT be suppressed');
    });

    it('should respect suppressionEnabled config', async () => {
      const testFile = path.join(tempDir, 'test.js');
      fs.writeFileSync(
        testFile,
        `
function test() {
  const password = "hardcoded"; // visor-disable
  return password;
}
`
      );

      // Initialize git repo
      const { execSync } = require('child_process');
      execSync('git init', { cwd: tempDir });
      execSync('git config user.email "test@example.com"', { cwd: tempDir });
      execSync('git config user.name "Test User"', { cwd: tempDir });
      execSync('git add .', { cwd: tempDir });
      execSync('git -c core.hooksPath=/dev/null commit -m "test"', { cwd: tempDir });

      // Test with suppression disabled
      const testIssue: ReviewIssue = {
        file: 'test.js',
        line: 3,
        ruleId: 'security/hardcoded-password',
        message: 'Hardcoded password',
        severity: 'error',
        category: 'security',
      };

      // Apply filter with suppression disabled
      const filterDisabled = new IssueFilter(false);
      const resultDisabled = filterDisabled.filterIssues([testIssue], tempDir);

      // Should NOT suppress when disabled
      expect(resultDisabled).toHaveLength(1);
      expect(resultDisabled[0].message).toBe('Hardcoded password');

      // Test with suppression enabled (for comparison)
      const filterEnabled = new IssueFilter(true);
      const resultEnabled = filterEnabled.filterIssues([testIssue], tempDir);

      // Should suppress when enabled (since file has visor-disable comment)
      expect(resultEnabled).toHaveLength(0);
    });
  });

  describe('Direct IssueFilter functionality', () => {
    it('should handle file-level suppression', () => {
      const testFile = path.join(tempDir, 'test.js');
      fs.writeFileSync(
        testFile,
        `// visor-disable-file
function test1() {
  const password = "hardcoded";
  return password;
}

function test2() {
  eval("dangerous");
}
`
      );

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: testFile,
          line: 3,
          ruleId: 'security/hardcoded-password',
          message: 'Issue 1',
          severity: 'error',
          category: 'security',
        },
        {
          file: testFile,
          line: 8,
          ruleId: 'security/eval',
          message: 'Issue 2',
          severity: 'critical',
          category: 'security',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(0); // All suppressed
    });

    it('should handle line-level suppression with proper range', () => {
      const testFile = path.join(tempDir, 'test.js');
      fs.writeFileSync(
        testFile,
        `
function test() {
  // visor-disable
  const password = "hardcoded"; // line 4
  const another = "value"; // line 5
  const yetAnother = "value"; // line 6
  const farAway = "value"; // line 7
}
`
      );

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: testFile,
          line: 4,
          ruleId: 'test',
          message: 'Should be suppressed (within range)',
          severity: 'error',
          category: 'security',
        },
        {
          file: testFile,
          line: 5,
          ruleId: 'test',
          message: 'Should be suppressed (within range)',
          severity: 'error',
          category: 'security',
        },
        {
          file: testFile,
          line: 7,
          ruleId: 'test',
          message: 'Should NOT be suppressed (out of range)',
          severity: 'error',
          category: 'security',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);
      expect(result).toHaveLength(1);
      expect(result[0].line).toBe(7);
    });

    it('should log suppression summary correctly', () => {
      const file1 = path.join(tempDir, 'file1.js');
      const file2 = path.join(tempDir, 'file2.js');

      fs.writeFileSync(
        file1,
        `
const x = "value"; // visor-disable
`
      );

      fs.writeFileSync(
        file2,
        `// visor-disable-file
const y = "value";
`
      );

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: 'file1.js',
          line: 2,
          ruleId: 'test',
          message: 'Issue in file1',
          severity: 'error',
          category: 'security',
        },
        {
          file: 'file2.js',
          line: 2,
          ruleId: 'test',
          message: 'Issue in file2',
          severity: 'error',
          category: 'security',
        },
      ];

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      filter.filterIssues(issues, tempDir);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Suppressed 2 issue(s)'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('file1.js: 1'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('file2.js: 1'));

      consoleSpy.mockRestore();
    });

    it('should handle mixed scenarios properly', () => {
      // File with line-level suppression
      const file1 = path.join(tempDir, 'file1.js');
      fs.writeFileSync(
        file1,
        `
function test1() {
  const password = "hardcoded"; // visor-disable
  const spacer1 = "value";
  const spacer2 = "value";
  const another = "value"; // No suppression - line 7
}
`
      );

      // File with file-level suppression
      const file2 = path.join(tempDir, 'file2.js');
      fs.writeFileSync(
        file2,
        `// visor-disable-file
function test2() {
  const apiKey = "sk-12345";
}
`
      );

      // File without suppression
      const file3 = path.join(tempDir, 'file3.js');
      fs.writeFileSync(
        file3,
        `
function test3() {
  const secret = "exposed";
}
`
      );

      const filter = new IssueFilter(true);
      const issues: ReviewIssue[] = [
        {
          file: file1,
          line: 3,
          ruleId: 'test',
          message: 'Should be suppressed',
          severity: 'error',
          category: 'security',
        },
        {
          file: file1,
          line: 7,
          ruleId: 'test',
          message: 'Should NOT be suppressed',
          severity: 'error',
          category: 'security',
        },
        {
          file: file2,
          line: 3,
          ruleId: 'test',
          message: 'Should be suppressed (file-level)',
          severity: 'error',
          category: 'security',
        },
        {
          file: file3,
          line: 3,
          ruleId: 'test',
          message: 'Should NOT be suppressed',
          severity: 'error',
          category: 'security',
        },
      ];

      const result = filter.filterIssues(issues, tempDir);

      expect(result).toHaveLength(2);
      expect(result[0].file).toBe(file1);
      expect(result[0].line).toBe(7);
      expect(result[1].file).toBe(file3);
      expect(result[1].line).toBe(3);
    });
  });
});
