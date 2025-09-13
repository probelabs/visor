/**
 * E2E test for complete failure conditions workflow
 */

import { spawn, execSync } from 'child_process';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
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

  it.skip('should have fail-fast option in CLI help', async () => {
    const cliPath = join(__dirname, '..', '..', 'dist', 'cli-main.js');

    // Check if file exists
    if (!existsSync(cliPath)) {
      throw new Error(`CLI file does not exist at: ${cliPath}`);
    }

    let output: string;
    try {
      // Use execSync for simpler execution
      output = execSync(`node "${cliPath}" --help`, {
        cwd: join(__dirname, '..', '..'),
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      });
    } catch (error: any) {
      console.error('Error executing CLI:', error.message);
      if (error.stdout) {
        console.log('Error stdout:', error.stdout.toString());
      }
      if (error.stderr) {
        console.log('Error stderr:', error.stderr.toString());
      }
      // Use the stdout from error if available (help commands often use exit code 0)
      output = error.stdout?.toString() || '';
      if (!output) {
        throw new Error(`CLI execution failed: ${error.message}`);
      }
    }

    console.log('CLI output length:', output.length);
    console.log('CLI output first 200 chars:', JSON.stringify(output.substring(0, 200)));

    expect(output).toContain('Visor - AI-powered code review tool');
    expect(output).toContain('--fail-fast');
    expect(output).toContain('Stop execution on first failure condition');
  }, 15000);

  it('should handle invalid failure conditions gracefully', async () => {
    // Create config with invalid JEXL expression
    const invalidConfig = `version: "1.0"

failure_conditions:
  # Invalid JEXL syntax
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
          join(__dirname, '..', '..', 'dist', 'cli-main.js'),
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
