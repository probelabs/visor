import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

/**
 * E2E Test: on_finish routing respects routing.max_loops
 */
describe('E2E: on_finish loop budget', () => {
  let originalCwd: string;
  let testDir: string;
  let cliCommand: string;
  let cliArgsPrefix: string[];

  const execCLI = (args: string[], options: any = {}): string => {
    const cleanEnv = { ...process.env } as NodeJS.ProcessEnv;
    delete cleanEnv.JEST_WORKER_ID;
    delete cleanEnv.NODE_ENV;
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
      if (output) {
        return Buffer.isBuffer(output) ? output.toString('utf-8') : String(output);
      }
      throw error;
    }
  };

  beforeAll(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-e2e-onfinish-loop-'));
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

    const config = `
version: "1.0"
routing:
  max_loops: 0
checks:
  parent:
    type: command
    exec: echo '[1]'
    output_format: json
    forEach: true
    on_finish:
      run: [child-log]
      goto: other-log

  child-log:
    type: log
    message: CHILD

  other-log:
    type: log
    message: OTHER
`;
    fs.writeFileSync(path.join(testDir, '.visor.yaml'), config);
    // Minimal package.json and git repo
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' })
    );
    execSync('git init && git config user.email "test@test.com" && git config user.name "Test"', {
      cwd: testDir,
    });
    fs.writeFileSync(path.join(testDir, 'file.txt'), 'content');
    execSync('git add . && git -c core.hooksPath=/dev/null commit -m "init"', { cwd: testDir });
    process.chdir(testDir);
  });

  afterAll(() => {
    try {
      process.chdir(originalCwd);
    } catch {}
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('fails when max_loops is exceeded for on_finish actions', () => {
    const out = execCLI(['--event', 'manual']);
    expect(out).toMatch(/Routing loop budget exceeded .* on_finish (run|goto)/);
  });
});
