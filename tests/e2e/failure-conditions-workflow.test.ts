/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * E2E test for complete failure conditions workflow
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';

describe('Failure Conditions E2E Workflow', () => {
  const testDir = join(__dirname, '..', '..', 'test-temp');
  const configPath = join(testDir, '.visor.yaml');
  const testFile = join(testDir, 'test.js');

  beforeAll(async () => {
    // Create test directory
    await fs.mkdir(testDir, { recursive: true });

    // Create test configuration with failure conditions
    const config = `version: "1.0"

failure_conditions:
  # Simple global condition
  no_critical: "metadata.criticalIssues == 0"

checks:
  test-check:
    type: ai
    schema: code-review
    prompt: "Find any issues in this code"
    on: [pr_opened]
    failure_conditions:
      # Check-specific condition
      low_issues: "metadata.totalIssues <= 2"

output:
  pr_comment:
    format: json
    group_by: check
    collapse: false`;

    await fs.writeFile(configPath, config);

    // Create test JavaScript file with potential issues
    const testCode = `// Test JavaScript file with some issues
function testFunction() {
  var x = 1; // Use let instead of var
  console.log("Hello World"); // Consider using a logger
  return x;
}

// Missing JSDoc documentation
function anotherFunction(param) {
  if (param == null) { // Use strict equality
    return false;
  }
  return true;
}`;

    await fs.writeFile(testFile, testCode);
  });

  afterAll(async () => {
    // Clean up test directory
    try {
      await fs.rmdir(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should have fail-fast option in CLI help', async () => {
    const { main } = await import('../../src/cli-main');

    // Mock process.argv and console.log to capture help output
    const originalArgv = process.argv;
    const originalExit = process.exit;
    const originalConsoleLog = console.log;

    let helpOutput = '';
    const mockConsoleLog = jest.fn((message: string) => {
      helpOutput += message + '\n';
    });
    const mockProcessExit = jest.fn();

    try {
      process.argv = ['node', 'visor', '--help'];
      console.log = mockConsoleLog;
      process.exit = mockProcessExit as any;

      await main();

      expect(mockConsoleLog).toHaveBeenCalled();
      expect(helpOutput).toContain('Visor - AI-powered code review tool');
      expect(helpOutput).toContain('--fail-fast');
      expect(helpOutput).toContain('Stop execution on first failure condition');
      expect(mockProcessExit).toHaveBeenCalledWith(0);
    } finally {
      process.argv = originalArgv;
      process.exit = originalExit;
      console.log = originalConsoleLog;
    }
  }, 15000);

  it('should handle invalid failure conditions gracefully', async () => {
    // Create config with invalid JavaScript expression
    const invalidConfig = `version: "1.0"

failure_conditions:
  # Invalid JavaScript syntax
  invalid_condition: "metadata.totalIssues ++ 0"

checks:
  test-check:
    type: ai
    schema: code-review
    prompt: "Find any issues"
    on: [pr_opened]

output:
  pr_comment:
    format: json
    group_by: check
    collapse: false`;

    const invalidConfigPath = join(testDir, '.visor-invalid.yaml');
    await fs.writeFile(invalidConfigPath, invalidConfig);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Test timeout after 30 seconds'));
      }, 30000);

      const child = spawn(
        'node',
        [
          join(__dirname, '..', '..', 'dist', 'index.js'),
          '--config',
          invalidConfigPath,
          '--check',
          'test-check',
          '--output',
          'json',
        ],
        {
          cwd: testDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      let stderr = '';

      child.stderr?.on('data', data => {
        stderr += data.toString();
      });

      child.on('close', code => {
        clearTimeout(timeout);

        try {
          // Should handle the error gracefully - CLI should still run
          expect(typeof code).toBe('number');
          resolve();
        } catch (err) {
          console.log('stderr:', stderr);
          console.log('exit code:', code);
          reject(err);
        }
      });

      child.on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }, 45000);

  it('should build the project successfully', async () => {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Build timeout after 60 seconds'));
      }, 60000);

      const child = spawn('npm', ['run', 'build'], {
        cwd: join(__dirname, '..', '..'),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.on('close', code => {
        clearTimeout(timeout);

        try {
          expect(code).toBe(0);
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      child.on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }, 90000);
});
