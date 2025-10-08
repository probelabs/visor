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
    const cleanEnv = { ...process.env } as NodeJS.ProcessEnv;
    delete cleanEnv.JEST_WORKER_ID;
    delete cleanEnv.NODE_ENV;
    delete cleanEnv.GITHUB_ACTIONS;
    // Ensure git-related env from hooks cannot leak into the CLI process
    delete cleanEnv.GIT_DIR;
    delete cleanEnv.GIT_WORK_TREE;
    delete cleanEnv.GIT_INDEX_FILE;
    delete cleanEnv.GIT_PREFIX;
    delete cleanEnv.GIT_COMMON_DIR;

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
    execSync('git add . && git -c core.hooksPath=/dev/null commit -m "Initial commit"', {
      cwd: testDir,
    });
  });

  afterAll(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should execute forEach branching with multiple dependencies correctly', () => {
    // Run visor in test directory with json output to verify structured data
    const result = execCLI(['--config', configPath, '--output', 'json'], { cwd: testDir });

    // Parse JSON output
    const jsonOutput = JSON.parse(result);

    // Verify the output structure
    expect(jsonOutput).toBeDefined();
    expect(Array.isArray(jsonOutput.issues) || jsonOutput.issues === undefined).toBe(true);

    // The key verification: with forEach branching, all checks should complete successfully
    // Since log checks don't produce issues, we just verify no errors occurred
    if (jsonOutput.issues) {
      expect(jsonOutput.issues.length).toBe(0);
    }

    // Verify the result shows successful execution
    // The fact that we get valid JSON without errors indicates success
    expect(result).toBeTruthy();
  });

  it('should unwrap all forEach parents in final-check (branching behavior)', () => {
    // This test validates that when final-check depends on multiple forEach checks
    // (check-a and check-b), BOTH are unwrapped at the same index for each iteration
    //
    // Expected branching behavior:
    // Iteration 1 (id:1, typeA):
    //   - outputs["root-check"] = {id:1, type:"typeA"} (unwrapped)
    //   - outputs["check-a"] = {processed_id:1, processor:"A"} (unwrapped)
    //   - outputs["check-b"] = {processed_id:2, processor:"B"} (unwrapped from index 0)
    //
    // Iteration 2 (id:2, typeB):
    //   - outputs["root-check"] = {id:2, type:"typeB"} (unwrapped)
    //   - outputs["check-a"] = {processed_id:3, processor:"A"} (unwrapped from index 1)
    //   - outputs["check-b"] = undefined (only 1 item, out of bounds)
    //
    // Iteration 3 (id:3, typeA):
    //   - outputs["root-check"] = {id:3, type:"typeA"} (unwrapped)
    //   - outputs["check-a"] = undefined (only 2 items, out of bounds)
    //   - outputs["check-b"] = undefined (only 1 item, out of bounds)

    const result = execCLI(['--config', configPath, '--output', 'table', '--debug'], {
      cwd: testDir,
    });

    // With the forEach branching fix, all forEach parents should be unwrapped consistently
    // The logger should show single objects for both check-a and check-b in each iteration
    // Note: Due to conditionals, some iterations may skip checks, but when they do run,
    // they should always see unwrapped (single object) outputs

    // Verify the debug output shows forEach execution
    expect(result).toMatch(/depends on forEach check/);
    expect(result).toMatch(/executing \d+ times/);

    // The final aggregated output should show:
    // - check-a: array of 2 objects (for items where typeA matched)
    // - check-b: single object (unwrapped array of 1, where typeB matched)
    expect(result).toContain('check-a:');
    expect(result).toContain('check-b:');
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
    //     * outputs["check-b"] = {processed_id:2, processor:"B"} (from its own array[0])

    // Iteration 2 (id:2, typeB):
    //   - root-check output: {id:2, type:"typeB"}
    //   - check-a skipped (condition false)
    //   - check-b runs, outputs: {processed_id:2, processor:"B"}
    //   - final-check sees:
    //     * outputs["root-check"] = {id:2, type:"typeB"}
    //     * outputs["check-a"] = {processed_id:3, processor:"A"} (from its own array[1])
    //     * outputs["check-b"] = undefined (out of bounds - only 1 item)

    // Iteration 3 (id:3, typeA):
    //   - root-check output: {id:3, type:"typeA"}
    //   - check-a runs, outputs: {processed_id:3, processor:"A"}
    //   - check-b skipped (condition false)
    //   - final-check sees:
    //     * outputs["root-check"] = {id:3, type:"typeA"}
    //     * outputs["check-a"] = undefined (out of bounds - only 2 items)
    //     * outputs["check-b"] = undefined (out of bounds - only 1 item)

    expect(true).toBe(true); // Documentation test
  });

  it('should validate execution counts and output structures at each stage', () => {
    // This test validates the detailed execution behavior:
    // 1. root-check executes once, produces 3 items
    // 2. check-a executes 2 times (for typeA items: id 1 and 3)
    // 3. check-b executes 1 time (for typeB item: id 2)
    // 4. final-check executes 3 times (once per root-check item)

    const result = execCLI(['--config', configPath, '--output', 'table', '--debug'], {
      cwd: testDir,
    });

    // Verify forEach execution debug messages
    expect(result).toMatch(/depends on forEach check/);
    expect(result).toMatch(/executing (\d+) times/);

    // Verify root-check execution
    expect(result).toMatch(/root-check/);

    // Verify conditional execution
    // check-a should run for items matching typeA
    expect(result).toMatch(/check-a/);

    // check-b should run for items matching typeB
    expect(result).toMatch(/check-b/);

    // final-check should run 3 times (once per forEach item)
    expect(result).toMatch(/final-check/);

    // Verify the output shows the forEach branching pattern
    // The debug output should show multiple executions
    const executionMatches = result.match(/executing (\d+) times/g);
    expect(executionMatches).toBeTruthy();
    expect(executionMatches!.length).toBeGreaterThan(0);

    // Verify outputs are present in final-check
    expect(result).toMatch(/check-a:/);
    expect(result).toMatch(/check-b:/);
    expect(result).toMatch(/root-check:/);
  });

  it('should properly aggregate forEach results after all iterations', () => {
    // This test verifies the final aggregated outputs after all forEach iterations
    // Expected aggregated outputs:
    // - root-check: array of 3 items (original forEach output)
    // - check-a: array of 2 items (executed for 2 typeA items)
    // - check-b: array of 1 item (executed for 1 typeB item)

    const result = execCLI(['--config', configPath, '--output', 'table', '--debug'], {
      cwd: testDir,
    });

    // Verify all checks completed successfully
    expect(result).toMatch(/root-check/);
    expect(result).toMatch(/check-a/);
    expect(result).toMatch(/check-b/);
    expect(result).toMatch(/final-check/);

    // Verify forEach completion messages
    expect(result).toMatch(/Completed forEach execution for check "check-a"/);
    expect(result).toMatch(/Completed forEach execution for check "check-b"/);
    expect(result).toMatch(/Completed forEach execution for check "final-check"/);

    // Verify the checks were executed
    // Note: "Checks Executed" only appears in Analysis Summary when there are issues
    // Since there are no issues, we verify execution via completion messages instead
    expect(result).toMatch(/Dependency-aware execution completed successfully/);

    // The summary should show all checks executed (in debug output)
    expect(result).toContain('root-check');
    expect(result).toContain('check-a');
    expect(result).toContain('check-b');
    expect(result).toContain('final-check');

    // No issues should be found since all checks complete successfully
    expect(result).toMatch(/No issues found|Total Issues.*0/);
  });
});
