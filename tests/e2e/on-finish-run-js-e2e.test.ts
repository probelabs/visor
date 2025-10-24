import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

/**
 * E2E Test: on_finish.run_js executes and runs dynamic checks
 */
describe('E2E: on_finish.run_js executes dynamic checks', () => {
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
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-e2e-onfinish-runjs-'));
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
checks:
  make-items:
    type: command
    exec: echo '[1,2,3]'
    output_format: json
    forEach: true
    on_finish:
      run_js: |
        // produce a dynamic run list
        return ['log-from-run-js'];
      goto_js: 'return null;'

  do-per-item:
    type: command
    depends_on: [make-items]
    exec: echo '{"ok":true}'
    output_format: json

  log-from-run-js:
    type: log
    message: |
      RUN_JS_EXECUTED
`;
    fs.writeFileSync(path.join(testDir, '.visor.yaml'), config);
    // Minimal package.json
    fs.writeFileSync(
      path.join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' })
    );
    // Initialize git repository with one commit
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

  it('runs dynamic check from run_js', () => {
    const out = execCLI(['--event', 'manual']);
    expect(out).toContain('RUN_JS_EXECUTED');
  });
});
