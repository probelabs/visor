import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync, execFileSync } from 'child_process';

/**
 * E2E Test: forEach with Conditional Chain
 *
 * Structure:
 * 1. root-check (forEach: true) → returns JSON array with field for conditionals
 * 2. check-a (depends_on: [root-check], if: condition on field)
 * 3. check-b (depends_on: [root-check], if: different condition on field)
 * 4. final-check (depends_on: [check-a, check-b]) → accesses outputs from check-a and check-b
 *
 * This test verifies what outputs the final-check receives.
 */
describe('E2E: forEach with Conditional Chain', () => {
  let testDir: string;
  let configPath: string;
  let cliCommand: string;
  let cliArgsPrefix: string[];

  // Helper function to execute CLI with clean environment
  const execCLI = (args: string[], options: any = {}): string => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.JEST_WORKER_ID;
    delete cleanEnv.NODE_ENV;
    delete cleanEnv.GITHUB_ACTIONS;

    const finalOptions = {
      ...options,
      env: { ...cleanEnv, VISOR_DEBUG: 'true' },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    try {
      const out = execFileSync(
        cliCommand,
        [...cliArgsPrefix, '--cli', ...args],
        finalOptions
      ) as unknown as string | Buffer;
      return typeof out === 'string' ? out : (out as Buffer).toString('utf-8');
    } catch (error: any) {
      // Prefer stdout even on non-zero exit
      const stdout = error?.stdout;
      if (stdout) return Buffer.isBuffer(stdout) ? stdout.toString('utf-8') : String(stdout);
      // Fallback to combined output if available
      if (Array.isArray(error?.output)) {
        const combined = error.output
          .filter(Boolean)
          .map((b: any) => (Buffer.isBuffer(b) ? b.toString('utf-8') : String(b)))
          .join('');
        if (combined) return combined;
      }
      throw error;
    }
  };

  beforeAll(() => {
    // Create temp directory for test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-e2e-foreach-conditional-'));

    // Use dist/index.js (ncc bundled) if available, otherwise use ts-node with src/index.ts
    const distCli = path.join(__dirname, '../../dist/index.js');
    if (fs.existsSync(distCli)) {
      cliCommand = 'node';
      cliArgsPrefix = [distCli];
    } else {
      const tsNodeRegister = require.resolve('ts-node/register', {
        paths: [path.resolve(__dirname, '../../')],
      });
      cliCommand = 'node';
      cliArgsPrefix = ['-r', tsNodeRegister, path.join(__dirname, '../../src/index.ts')];
    }

    // Create test config
    const config = `
version: "1.0"
checks:
  root-check:
    type: command
    exec: echo '[{"id":1,"type":"typeA"},{"id":2,"type":"typeB"},{"id":3,"type":"typeA"}]'
    output_format: json
    forEach: true

  check-a:
    type: command
    depends_on: [root-check]
    if: 'outputs["root-check"].type === "typeA"'
    exec: >
      echo '{"processed_id": {{ outputs["root-check"].id }}, "processor": "A"}'
    output_format: json

  check-b:
    type: command
    depends_on: [root-check]
    if: 'outputs["root-check"].type === "typeB"'
    exec: >
      echo '{"processed_id": {{ outputs["root-check"].id }}, "processor": "B"}'
    output_format: json

  final-check:
    type: log
    depends_on: [check-a, check-b]
    message: |
      === Final Check Outputs ===
      All outputs keys: {{ outputs | keys | join: ", " }}
      check-a: {{ outputs["check-a"] | json }}
      check-b: {{ outputs["check-b"] | json }}
      root-check: {{ outputs["root-check"] | json }}
`;

    configPath = path.join(testDir, '.visor.yaml');
    fs.writeFileSync(configPath, config);

    // Create a minimal package.json
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' })
    );

    // Initialize git repo and create a commit
    execSync('git init && git config user.email "test@test.com" && git config user.name "Test"', {
      cwd: testDir,
    });
    fs.writeFileSync(path.join(testDir, 'test.txt'), 'test content');
    execSync('git add . && git commit -m "Initial commit"', {
      cwd: testDir,
    });
  });

  afterAll(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should show what outputs final-check receives from forEach conditional chain', () => {
    // Run visor in test directory
    const result = execCLI(['--config', configPath, '--output', 'table'], { cwd: testDir });

    // Verify the checks ran successfully
    expect(result).toContain('root-check');
    expect(result).toContain('check-a');
    expect(result).toContain('check-b');
    expect(result).toContain('final-check');
    expect(result).toContain('No issues found');

    // Current behavior (from console output):
    // - check-a: array with 2 items: [{"processed_id":1,"processor":"A"},{"processed_id":3,"processor":"A"}]
    // - check-b: single object: {"processed_id":2,"processor":"B"}
    // - final-check: runs ONCE, sees aggregated outputs

    // Expected behavior (if forEach should propagate):
    // - final-check should run 3 TIMES (once per root-check item)
    // - Each iteration should see the outputs for that specific item

    // Extract the logger output
    const loggerMatch = result.match(/check-a: (\[.*?\])/s);
    if (loggerMatch) {
      const checkAOutput = JSON.parse(loggerMatch[1]);
      console.log('\n=== check-a output ===');
      console.log(JSON.stringify(checkAOutput, null, 2));
      expect(checkAOutput).toHaveLength(2);
      expect(checkAOutput[0].processed_id).toBe(1);
      expect(checkAOutput[1].processed_id).toBe(3);
    }
  });

  it('should document the expected behavior', () => {
    // Expected behavior:
    // Iteration 1 (id:1, typeA):
    //   - root-check output: {id:1, type:"typeA"}
    //   - check-a runs, outputs: {processed_id:1, processor:"A"}
    //   - check-b skipped (condition false)
    //   - final-check sees:
    //     * outputs["root-check"] = {id:1, type:"typeA"}
    //     * outputs["check-a"] = {processed_id:1, processor:"A"}
    //     * outputs["check-b"] = ??? (undefined? empty?)

    // Iteration 2 (id:2, typeB):
    //   - root-check output: {id:2, type:"typeB"}
    //   - check-a skipped (condition false)
    //   - check-b runs, outputs: {processed_id:2, processor:"B"}
    //   - final-check sees:
    //     * outputs["root-check"] = {id:2, type:"typeB"}
    //     * outputs["check-a"] = ??? (undefined? empty?)
    //     * outputs["check-b"] = {processed_id:2, processor:"B"}

    // Iteration 3 (id:3, typeA):
    //   - root-check output: {id:3, type:"typeA"}
    //   - check-a runs, outputs: {processed_id:3, processor:"A"}
    //   - check-b skipped (condition false)
    //   - final-check sees:
    //     * outputs["root-check"] = {id:3, type:"typeA"}
    //     * outputs["check-a"] = {processed_id:3, processor:"A"}
    //     * outputs["check-b"] = ??? (undefined? empty?)

    expect(true).toBe(true); // Documentation test
  });
});
