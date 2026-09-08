import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CommandExecutor, type CommandExecutionResult } from '../../src/utils/command-executor';

type ErrorHandler = {
  handleExecutionError(error: unknown, timeout: number): CommandExecutionResult;
};

const handleExecutionError = (error: unknown): CommandExecutionResult =>
  (CommandExecutor.getInstance() as unknown as ErrorHandler).handleExecutionError(error, 30000);

describe('CommandExecutor spawn-error normalization', () => {
  it('maps E2BIG to a finite exit code and bounded public stderr', () => {
    const result = handleExecutionError({
      code: 'E2BIG',
      stdout: '',
      stderr: '',
      message: 'spawn E2BIG with secret /private/path',
    });

    expect(result.exitCode).toBe(1);
    expect(Number.isFinite(result.exitCode)).toBe(true);
    expect(result.stderr).toBe('Command process failed before exit: E2BIG');
    expect(result.stderr).not.toContain('/private/path');
    expect(result.stderr).not.toContain('secret');
  });

  it('collapses unknown string codes without exposing the error message or stdout', () => {
    const result = handleExecutionError({
      code: 'CUSTOM_SPAWN_FAILURE',
      stdout: 'stdout secret',
      stderr: '',
      message: 'sk-live-value /private/project command payload',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Command process failed before exit: SYSTEM_ERROR');
    expect(result.stderr).not.toContain('CUSTOM_SPAWN_FAILURE');
    expect(result.stderr).not.toContain('sk-live-value');
    expect(result.stderr).not.toContain('stdout secret');
  });

  it('keeps finite numeric and decimal-string exit codes numeric', () => {
    expect(handleExecutionError({ code: 7, stdout: '', stderr: '' }).exitCode).toBe(7);
    expect(handleExecutionError({ code: '7', stdout: '', stderr: '' }).exitCode).toBe(7);
    expect(Number.isFinite(handleExecutionError({ code: Number.NaN }).exitCode)).toBe(true);
  });

  it('preserves an existing nonempty stderr from the child process', () => {
    expect(handleExecutionError({ code: 'E2BIG', stderr: 'child diagnostic' }).stderr).toBe(
      'child diagnostic'
    );
  });

  it('replays an oversized heredoc command from a private script and cleans it up', async () => {
    const executor = CommandExecutor.getInstance();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-e2big-cwd-'));
    const tempPrefix = 'visor-command-e2big-';
    const before = fs
      .readdirSync(os.tmpdir())
      .filter(name => name.startsWith(tempPrefix))
      .sort();
    const marker = 'e2big-fallback-env';
    try {
      const argMax = Number(execFileSync('getconf', ['ARG_MAX'], { encoding: 'utf8' }).trim());
      const command = [
        `# ${'x'.repeat(argMax + 16384)}`,
        'node - "$ARG" <<\'NODE\'',
        'process.stdout.write(`${process.cwd()}|${process.env.ARG}`);',
        'NODE',
      ].join('\n');

      const result = await executor.execute(command, {
        cwd,
        env: { PATH: process.env.PATH || '/usr/bin:/bin', ARG: marker },
        timeout: 30000,
      });

      expect(result).toEqual({
        stdout: `${fs.realpathSync(cwd)}|${marker}`,
        stderr: '',
        exitCode: 0,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
    expect(
      fs
        .readdirSync(os.tmpdir())
        .filter(name => name.startsWith(tempPrefix))
        .sort()
    ).toEqual(before);
  });

  it('keeps ordinary nonzero exits and timeouts unchanged', async () => {
    const executor = CommandExecutor.getInstance();
    await expect(executor.execute('exit 7')).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 7,
    });
    await expect(executor.execute('exit 7', { stdin: 'input' })).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 7,
    });
    await expect(executor.execute('sleep 1', { timeout: 20 })).rejects.toThrow(
      'Command timed out after 20ms'
    );
  });
});
