import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

// Minimal CLI executor mirroring other e2e tests
const execCLI = (args: string[], options: any = {}): string => {
  const cleanEnv = { ...process.env } as NodeJS.ProcessEnv;
  delete cleanEnv.JEST_WORKER_ID;
  delete cleanEnv.NODE_ENV;
  delete cleanEnv.GITHUB_ACTIONS;
  delete cleanEnv.GIT_DIR;
  delete cleanEnv.GIT_WORK_TREE;
  delete cleanEnv.GIT_INDEX_FILE;
  delete cleanEnv.GIT_PREFIX;
  delete cleanEnv.GIT_COMMON_DIR;

  // Prefer bundled dist if present
  const distCli = path.join(__dirname, '../../dist/index.js');
  const cliCommand = 'node';
  const cliArgsPrefix = [distCli];
  const shellCmd = `${cliCommand} ${[...cliArgsPrefix, '--cli', ...args].join(' ')} 2>&1`;
  const finalOptions = {
    ...options,
    env: { ...cleanEnv, VISOR_DEBUG: 'true' },
    encoding: 'utf-8',
    shell: true,
  };
  try {
    const out = execSync(shellCmd, finalOptions) as unknown as string | Buffer;
    return typeof out === 'string' ? out : (out as Buffer).toString('utf-8');
  } catch (error: any) {
    const output = error?.stdout || error?.output;
    if (output) return Buffer.isBuffer(output) ? output.toString('utf-8') : String(output);
    throw error;
  }
};

describe('Routed if-gating (runNamedCheck + shouldRunCheck)', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-e2e-routed-if-'));
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' })
    );
    // Initialize git repo so PRInfo generation is stable
    execSync('git init && git config user.email "test@test.com" && git config user.name "Test"', {
      cwd: testDir,
    });
    fs.writeFileSync(path.join(testDir, 'a.txt'), 'x');
    execSync('git add . && git -c core.hooksPath=/dev/null commit -m "init"', { cwd: testDir });
  });

  afterAll(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('runs routed check when if condition is true', () => {
    const cfg = `
version: "1.0"
checks:
  parent:
    type: log
    tags: [parent]
    message: 'parent ran'
    on_success:
      run: [target]
  target:
    type: log
    tags: [routed]
    if: "always()"
    message: 'target executed'
output:
  pr_comment:
    format: table
`;
    const p = path.join(testDir, '.visor.yaml');
    fs.writeFileSync(p, cfg);
    const out = execCLI(['--config', p, '--event', 'manual', '--tags', 'parent'], { cwd: testDir });
    expect(out).toMatch(/parent ran/i);
    expect(out).toMatch(/target executed/i);
  });

  it('skips routed check when if condition is false (fail-secure)', () => {
    const cfg = `
version: "1.0"
checks:
  parent:
    type: log
    tags: [parent]
    message: 'parent ran'
    on_success:
      run: [target]
  target:
    type: log
    tags: [routed]
    if: "false"
    message: 'should not print'
output:
  pr_comment:
    format: table
`;
    const p = path.join(testDir, '.visor-false.yaml');
    fs.writeFileSync(p, cfg);
    const out = execCLI(['--config', p, '--event', 'manual', '--tags', 'parent'], { cwd: testDir });
    expect(out).toMatch(/parent ran/i);
    expect(out).not.toMatch(/should not print/i);
    expect(out).toMatch(/⏭\s+Skipped \(if:/i);
  });

  it('fail-secure: invalid condition expression skips routed check and logs error', () => {
    const cfg = `
version: "1.0"
checks:
  parent:
    type: log
    tags: [parent]
    message: 'parent ran'
    on_success:
      run: [target]
  target:
    type: log
    tags: [routed]
    if: "this is not valid ++"
    message: 'should not print'
output:
  pr_comment:
    format: table
`;
    const p = path.join(testDir, '.visor-invalid.yaml');
    fs.writeFileSync(p, cfg);
    const out = execCLI(['--config', p, '--event', 'manual', '--tags', 'parent'], { cwd: testDir });
    expect(out).toMatch(/parent ran/i);
    expect(out).not.toMatch(/should not print/i);
    // Accept either helper or evaluator message formats
    expect(out).toMatch(
      /Failed to evaluate if (condition|expression) for (check 'target'|target):/i
    );
    expect(out).toMatch(/⏭\s+Skipped \(if:/i);
  });

  it('on_finish routing honors fail-secure gating and records skip', () => {
    const cfg = `
version: "1.0"
checks:
  items:
    type: command
    exec: echo '[1,2,3]'
    output_format: json
    forEach: true
    on_finish:
      run: [target]
  target:
    type: log
    if: "false"
    message: 'post-finish should not run'
output:
  pr_comment:
    format: table
`;
    const p = path.join(testDir, '.visor-onfinish.yaml');
    fs.writeFileSync(p, cfg);
    const out = execCLI(['--config', p, '--event', 'manual'], { cwd: testDir });
    // Verify on_finish executed and target was skipped
    expect(out).toMatch(/on_finish: processing|Processing on_finish/i);
    expect(out).not.toMatch(/post-finish should not run/i);
    expect(out).toMatch(/⏭\s+Skipped \(if:/i);
  });
});
