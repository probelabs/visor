/* eslint-disable @typescript-eslint/no-explicit-any */
// Import real spawn, not the mocked version
const { spawn } = jest.requireActual('child_process');
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('CLI Workflow Integration Tests', () => {
  // Check if compiled version exists for faster test execution
  const COMPILED_CLI_PATH = path.join(__dirname, '../../dist/cli-main.js');
  const SOURCE_CLI_PATH = path.join(__dirname, '../../src/cli-main.ts');
  const useCompiledVersion = fs.existsSync(COMPILED_CLI_PATH);

  // Log which version we're using (helpful for debugging CI issues)
  if (useCompiledVersion) {
    console.log('Using compiled CLI for tests (faster)');
  } else {
    console.log(
      'Using TypeScript CLI with ts-node (slower, building dist/ first would speed up tests)'
    );
  }
  const timeout = 10000; // 10 seconds timeout for integration tests (reduced for CI)

  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Set mock API keys to prevent real API calls
    process.env.GOOGLE_API_KEY = 'mock-test-key';
    process.env.ANTHROPIC_API_KEY = 'mock-test-key';
    process.env.OPENAI_API_KEY = 'mock-test-key';

    // Create a temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-cli-test-'));
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;

    // Clean up temporary directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper function to run CLI commands
   */
  const runCLI = (
    args: string[],
    options: { cwd?: string; timeout?: number } = {}
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> => {
    return new Promise((resolve, reject) => {
      // Use node for compiled JS, or npx ts-node for TypeScript source
      let command: string;
      let commandArgs: string[];

      if (useCompiledVersion) {
        command = 'node';
        commandArgs = [COMPILED_CLI_PATH, ...args];
      } else {
        command = 'npx';
        commandArgs = ['ts-node', SOURCE_CLI_PATH, ...args];
      }

      const child = spawn(command, commandArgs, {
        cwd: options.cwd || tempDir,
        stdio: 'pipe',
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: any) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: any) => {
        stderr += data.toString();
      });

      child.on('close', (code: any) => {
        resolve({
          stdout,
          stderr,
          exitCode: code || 0,
        });
      });

      child.on('error', (error: any) => {
        reject(error);
      });

      // Set timeout
      const timeoutMs = options.timeout || timeout;
      setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`CLI command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  };

  /**
   * Helper function to initialize a git repository in temp directory
   */
  const initGitRepo = async (dir: string) => {
    const { execSync } = require('child_process');

    try {
      // Initialize git repo
      execSync('git init', { cwd: dir });
      execSync('git config user.email "test@example.com"', { cwd: dir });
      execSync('git config user.name "Test User"', { cwd: dir });

      // Create initial commit
      fs.writeFileSync(path.join(dir, 'README.md'), '# Test Repository\n');
      execSync('git add .', { cwd: dir });
      execSync('git commit -m "Initial commit"', { cwd: dir });

      // Create some test files with changes
      fs.writeFileSync(
        path.join(dir, 'test.js'),
        `
function test() {
  // This is a test function
  var x = "test"; // Should use let/const
  return x;
}

module.exports = test;
`
      );

      fs.writeFileSync(
        path.join(dir, 'security-test.sql'),
        `
SELECT * FROM users WHERE id = '${process.argv[2]}';
-- This has SQL injection vulnerability
`
      );
    } catch (error) {
      console.warn('Failed to initialize git repo:', error);
    }
  };

  describe('Help and Version Commands', () => {
    it(
      'should display help when --help flag is used',
      async () => {
        const result = await runCLI(['--help']);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Usage: visor [options]');
        expect(result.stdout).toContain('Visor - AI-powered code review tool');
        expect(result.stdout).toContain('--check');
        expect(result.stdout).toContain('--output');
        expect(result.stdout).toContain('Examples:');
      },
      timeout
    );

    it(
      'should display help when -h flag is used',
      async () => {
        const result = await runCLI(['-h']);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Usage: visor [options]');
      },
      timeout
    );

    it(
      'should display version when --version flag is used',
      async () => {
        const result = await runCLI(['--version']);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
      },
      timeout
    );

    it(
      'should display version when -V flag is used',
      async () => {
        const result = await runCLI(['-V']);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
      },
      timeout
    );
  });

  describe('Argument Validation', () => {
    it(
      'should show error for invalid check type',
      async () => {
        await initGitRepo(tempDir);

        const result = await runCLI(['--check', 'invalid-check']);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('No configuration found for check: invalid-check');
      },
      timeout
    );

    it(
      'should show error for invalid output format',
      async () => {
        await initGitRepo(tempDir);

        const result = await runCLI(['--check', 'security', '--output', 'invalid-format']);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Invalid output format');
      },
      timeout
    );

    it(
      'should show error for unknown options',
      async () => {
        const result = await runCLI(['--unknown-option']);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('unknown option');
      },
      timeout
    );

    it(
      'should show error for missing required arguments',
      async () => {
        const result = await runCLI(['--check']);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('argument missing');
      },
      timeout
    );
  });

  describe('Non-Git Repository Handling', () => {
    it(
      'should show error when not in a git repository',
      async () => {
        // Don't initialize git in temp directory
        const result = await runCLI(['--check', 'security']);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Not a git repository');
      },
      timeout
    );

    it(
      'should handle empty directory gracefully',
      async () => {
        const result = await runCLI(['--check', 'performance']);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Not a git repository');
      },
      timeout
    );
  });

  describe.skip('Basic Check Execution', () => {
    beforeEach(async () => {
      await initGitRepo(tempDir);
    });

    // These tests are skipped because they would require actual AI service calls
    // which could cause timeouts in CI environment
    it('should execute security checks successfully', async () => {
      const result = await runCLI(['--check', 'security'], { timeout: 5000 });
      expect(result.exitCode).toBe(0);
    }, 5000);

    it('should execute performance checks successfully', async () => {
      const result = await runCLI(['--check', 'performance'], { timeout: 5000 });
      expect(result.exitCode).toBe(0);
    }, 5000);

    it('should execute style checks successfully', async () => {
      const result = await runCLI(['--check', 'style'], { timeout: 5000 });
      expect(result.exitCode).toBe(0);
    }, 5000);
  });

  describe.skip('Output Format Testing', () => {
    beforeEach(async () => {
      await initGitRepo(tempDir);
    });

    it('should output in table format (default)', async () => {
      const result = await runCLI(['--check', 'security'], { timeout: 45000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('📊 Analysis Summary');
      expect(result.stdout).toContain('Overall Score');
      expect(result.stdout).toContain('Total Issues');
      expect(result.stdout).toContain('Execution Time');
    }, 45000);

    it('should output in JSON format', async () => {
      const result = await runCLI(['--check', 'security', '--output', 'json'], { timeout: 45000 });

      expect(result.exitCode).toBe(0);

      // Should contain valid JSON
      const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
      expect(jsonMatch).toBeTruthy();

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        expect(parsed).toHaveProperty('summary');
        expect(parsed).toHaveProperty('repository');
        expect(parsed).toHaveProperty('issues');
        expect(parsed.summary).toHaveProperty('overallScore');
        expect(parsed.summary).toHaveProperty('executionTime');
      }
    }, 45000);

    it('should output in markdown format', async () => {
      const result = await runCLI(['--check', 'security', '--output', 'text'], {
        timeout: 45000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('# 🔍 Visor Analysis Results');
      expect(result.stdout).toContain('## 📊 Summary');
      expect(result.stdout).toContain('| Overall Score |');
      expect(result.stdout).toContain('## 📁 Repository Information');
    }, 45000);
  });

  describe.skip('Repository Analysis', () => {
    beforeEach(async () => {
      await initGitRepo(tempDir);
    });

    it('should show repository status information', async () => {
      const result = await runCLI(['--check', 'security'], { timeout: 45000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Configuration version: 1.0');
      expect(result.stdout).toContain('📂 Repository:');
      expect(result.stdout).toContain('branch');
      expect(result.stdout).toContain('📁 Files changed:');
    }, 45000);

    it('should handle repositories with no changes', async () => {
      // Commit all changes to have a clean working directory
      const { execSync } = require('child_process');
      try {
        execSync('git add .', { cwd: tempDir });
        execSync('git commit -m "Add test files"', { cwd: tempDir });
      } catch {
        // Ignore if no changes to commit
      }

      const result = await runCLI(['--check', 'security'], { timeout: 45000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No uncommitted changes found');
    }, 45000);
  });

  describe('Error Scenarios', () => {
    it('should handle configuration file not found gracefully', async () => {
      await initGitRepo(tempDir);

      const result = await runCLI(['--config', 'non-existent-config.yaml', '--check', 'security'], {
        timeout: 45000,
      });

      // Config file not found will fall back to default config, but will still fail
      // due to authentication issues with mock API keys or timeouts
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Warning:');
    }, 45000);

    it(
      'should use bundled default checks when no checks specified',
      async () => {
        await initGitRepo(tempDir);

        const result = await runCLI([]);

        // Should not fail due to "no checks specified" since bundled config provides default checks
        expect(result.stderr).not.toContain('No checks specified');

        // The CLI may fail due to git issues or AI service calls, but it shouldn't
        // fail specifically due to lack of checks configuration
        // Check that it got past the "no checks specified" validation
        if (result.stderr.includes('Not a git repository')) {
          // If it failed on git check, that means it passed the checks configuration step
          // This confirms bundled config provided checks successfully
          expect(result.stderr).not.toContain('No checks specified');
        } else {
          // If it succeeded or failed for other reasons, check for expected output
          // For non-JSON output, status messages go to stdout, not stderr
          const output = result.stdout + result.stderr;
          expect(output).toContain('🔍 Visor - AI-powered code review tool');

          // Should show debug info about extracted checks from bundled config
          expect(output).toMatch(
            /Debug.*Extracted checks from config.*\[.*security.*performance.*quality.*overview.*\]/
          );
        }
      },
      timeout
    );

    it(
      'should handle CLI parsing errors gracefully',
      async () => {
        const result = await runCLI(['--check', 'security', 'extra-argument']);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('too many arguments');
      },
      timeout
    );
  });

  describe.skip('Performance and Reliability', () => {
    beforeEach(async () => {
      await initGitRepo(tempDir);
    });

    it('should complete analysis within reasonable time', async () => {
      const startTime = Date.now();
      const result = await runCLI(['--check', 'security'], { timeout: 45000 });
      const executionTime = Date.now() - startTime;

      expect(result.exitCode).toBe(0);
      expect(executionTime).toBeLessThan(30000); // Should complete within 30 seconds
    }, 45000);

    it('should handle concurrent executions', async () => {
      const promises = [
        runCLI(['--check', 'security'], { timeout: 45000 }),
        runCLI(['--check', 'performance'], { timeout: 45000 }),
        runCLI(['--check', 'style'], { timeout: 45000 }),
      ];

      const results = await Promise.allSettled(promises);

      // At least some should succeed (depending on system resources)
      const successCount = results.filter(
        r => r.status === 'fulfilled' && r.value.exitCode === 0
      ).length;

      expect(successCount).toBeGreaterThan(0);
    }, 60000);
  });

  describe.skip('Configuration Integration', () => {
    beforeEach(async () => {
      await initGitRepo(tempDir);
    });

    it('should work with default configuration', async () => {
      const result = await runCLI(['--check', 'security'], { timeout: 45000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Configuration version: 1.0');
    }, 45000);

    it('should handle custom configuration path', async () => {
      // Create a custom config file
      const configContent = `
version: "1.0"
checks: {}
output:
  pr_comment:
    format: summary
    group_by: check
    collapse: true
`;

      const configPath = path.join(tempDir, 'custom-visor.yaml');
      fs.writeFileSync(configPath, configContent);

      const result = await runCLI(['--config', configPath, '--check', 'security'], {
        timeout: 45000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('🔍 Visor - AI-powered code review tool');
    }, 45000);
  });

  describe.skip('Edge Cases', () => {
    it('should handle very large repository gracefully', async () => {
      await initGitRepo(tempDir);

      // Create many files to simulate large repo
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);

      for (let i = 0; i < 50; i++) {
        fs.writeFileSync(
          path.join(srcDir, `file${i}.js`),
          `
console.log("File ${i}");
var x = "test";
function test${i}() {
  return x;
}
`
        );
      }

      const result = await runCLI(['--check', 'style'], { timeout: 60000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ANALYSIS RESULTS');
    }, 60000);

    it('should handle special characters in file names', async () => {
      await initGitRepo(tempDir);

      // Create files with special characters
      fs.writeFileSync(path.join(tempDir, 'file with spaces.js'), 'console.log("test");');
      fs.writeFileSync(path.join(tempDir, 'file-with-dashes.js'), 'console.log("test");');
      fs.writeFileSync(path.join(tempDir, 'file.with.dots.js'), 'console.log("test");');

      const result = await runCLI(['--check', 'style'], { timeout: 45000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ANALYSIS RESULTS');
    }, 45000);
  });
});
