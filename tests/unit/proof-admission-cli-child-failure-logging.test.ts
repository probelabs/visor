import { describe, expect, it, jest } from '@jest/globals';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const binding = {
  managedRunId: 'm'.repeat(64),
  sessionId: 'session-secret',
  checkId: 'native-check',
  scope: [{kind: 'keyed', expansionOwnerCheck: 'discover', key: 'component', subgraphInstanceId: 's'.repeat(64)}],
  nodeInstanceId: 'n'.repeat(64),
  nodeGenerationId: 'g'.repeat(64),
  attemptId: 'a'.repeat(64),
  fence: 1,
} as any;

type FakeChild = EventEmitter & {
  pid: number;
  stdin: EventEmitter & {end: jest.Mock};
  stdout: EventEmitter;
  stderr: EventEmitter;
};

function fakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdin = Object.assign(new EventEmitter(), {end: jest.fn()});
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function completeFakeChild(child: FakeChild, code: number | null, signal: NodeJS.Signals | null = null): void {
  child.stdout.emit('end');
  child.stderr.emit('end');
  child.emit('exit', code, signal);
  child.emit('close');
}

function mockProcessGroup(child: FakeChild) {
  let alive = true;
  const nativeKill = process.kill.bind(process);
  const kill = jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid !== -child.pid) return nativeKill(pid, signal);
    if (signal === 0) {
      if (alive) return true;
      throw Object.assign(new Error('group absent'), {code: 'ESRCH'});
    }
    return true;
  }) as typeof process.kill);
  return {kill, setAlive: (value: boolean) => { alive = value; }};
}

async function withIsolatedChild<T>(fn: (module: typeof import('../../src/providers/proof-admission-cli-child'), spawn: jest.Mock, logger: {error: jest.Mock}) => Promise<T>): Promise<T> {
  let result: Promise<T> | undefined;
  try {
    jest.resetModules();
    jest.isolateModules(() => {
      const spawn = jest.fn();
      jest.doMock('child_process', () => ({
        ...jest.requireActual<typeof import('child_process')>('child_process'),
        spawn,
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const module = require('../../src/providers/proof-admission-cli-child') as typeof import('../../src/providers/proof-admission-cli-child');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const logger = require('../../src/logger').logger as {error: jest.Mock};
      result = fn(module, spawn, logger);
    });
    return await result!;
  } finally {
    jest.dontMock('child_process');
    jest.resetModules();
  }
}

async function withExecutable<T>(script: string, fn: (path: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'visor-proof-failure-log-'));
  const path = join(root, 'proof');
  try {
    writeFileSync(path, script, 'utf8');
    chmodSync(path, 0o755);
    return await fn(path);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

function request() {
  return {
    binding,
    workingDirectory: '/tmp',
    command: ['admit-candidate'] as const,
    input: 'sensitive request input must not enter diagnostics',
    inputLimit: 4096,
    outputLimit: 10000,
    outputCanonical: true,
    projectOutput: () => ({}),
  } as Parameters<typeof import('../../src/providers/proof-admission-cli-child').startProofManagedCliChild>[0];
}

describe('managed Proof child failure logging', () => {
  it('emits one correlated bounded failure log and preserves the exact failed outcome', async () => {
    await withExecutable('#!/bin/sh\nexit 7\n', async path => withIsolatedChild(async (module, spawn, logger) => {
      const child = fakeChild(49101);
      const group = mockProcessGroup(child);
      spawn.mockReturnValue(child);
      const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      try {
        const run = module.startProofManagedCliChild(request(), module.createProofAdmissionCliChildForFocusedTest(path));
        (child.stdin.end as jest.Mock).mockImplementation((_input: string, _encoding: string, callback: () => void) => {
          child.stdout.emit('data', Buffer.from('short stdout\n'));
          child.stderr.emit('data', Buffer.from('short stderr\n'));
          callback();
          group.setAlive(false);
          completeFakeChild(child, 7);
        });
        child.emit('spawn');
        await expect(run.started).resolves.toMatchObject({version: 1, kind: 'started', binding});
        await expect(run.outcome).resolves.toEqual({version: 1, kind: 'failed', binding});
        await expect(run.close()).resolves.toMatchObject({version: 1, kind: 'cleanup', status: 'clean', activeChildren: 0, activeResources: 0});

        expect(errorLog).toHaveBeenCalledTimes(1);
        const record = JSON.parse(errorLog.mock.calls[0][0]);
        expect(record).toMatchObject({
          event: 'proof_managed_cli_failed',
          command: ['admit-candidate'],
          binding: {managedRunId: binding.managedRunId, checkId: binding.checkId, attemptId: binding.attemptId},
          failure_stage: expect.any(String),
          reason: expect.any(String),
          exit_code: 7,
          signal: null,
          stdout: 'short stdout\n',
          stderr: 'short stderr\n',
          stdout_original_bytes: Buffer.byteLength('short stdout\n'),
          stderr_original_bytes: Buffer.byteLength('short stderr\n'),
          stdout_truncated: false,
          stderr_truncated: false,
        });
        expect(Object.keys(record.binding).sort()).toEqual(['attemptId', 'checkId', 'managedRunId'].sort());
        expect(JSON.stringify(record)).not.toContain('sensitive request input');
        expect(JSON.stringify(record)).not.toMatch(/session-secret|cwd|executable|stdin|env|auth/i);
      } finally {
        errorLog.mockRestore();
        group.kill.mockRestore();
      }
    }));
  });

  it('records original byte counts and truncation without expanding the diagnostic boundary', async () => {
    await withExecutable('#!/bin/sh\nexit 9\n', async path => withIsolatedChild(async (module, spawn, logger) => {
      const child = fakeChild(49102);
      const group = mockProcessGroup(child);
      spawn.mockReturnValue(child);
      const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      try {
        const run = module.startProofManagedCliChild(request(), module.createProofAdmissionCliChildForFocusedTest(path));
        (child.stdin.end as jest.Mock).mockImplementation((_input: string, _encoding: string, callback: () => void) => {
          child.stdout.emit('data', Buffer.alloc(5001, 'x'));
          child.stderr.emit('data', Buffer.alloc(5001, 'y'));
          callback();
          group.setAlive(false);
          completeFakeChild(child, 9);
        });
        child.emit('spawn');
        await expect(run.outcome).resolves.toEqual({version: 1, kind: 'failed', binding});
        const record = JSON.parse(errorLog.mock.calls[0][0]);
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(record.exit_code).toBe(9);
        expect(record.stdout_original_bytes).toBe(5001);
        expect(record.stderr_original_bytes).toBe(5001);
        expect(record.stdout).toHaveLength(4096);
        expect(record.stderr).toHaveLength(4096);
        expect(record.stdout_truncated).toBe(true);
        expect(record.stderr_truncated).toBe(true);
        await run.close();
      } finally {
        errorLog.mockRestore();
        group.kill.mockRestore();
      }
    }));
  });

  it('logs early spawn errors once with the same failed outcome shape', async () => {
    await withExecutable('#!/visor/nonexistent-interpreter\n', async path => withIsolatedChild(async (module, spawn, logger) => {
      const child = fakeChild(49103);
      spawn.mockReturnValue(child);
      const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      try {
        const run = module.startProofManagedCliChild(request(), module.createProofAdmissionCliChildForFocusedTest(path));
        child.emit('error', new Error('spawn failed: sensitive request input'));
        await expect(run.started).rejects.toThrow(module.PROOF_ADMISSION_UNAVAILABLE);
        await expect(run.outcome).resolves.toEqual({version: 1, kind: 'failed', binding});
        await expect(run.close()).resolves.toMatchObject({version: 1, kind: 'cleanup', status: 'clean'});
        expect(errorLog).toHaveBeenCalledTimes(1);
        const record = JSON.parse(errorLog.mock.calls[0][0]);
        expect(record).toMatchObject({event: 'proof_managed_cli_failed', exit_code: null, signal: null, stdout: '', stderr: ''});
        expect(JSON.stringify(record)).not.toContain('sensitive request input');
      } finally {
        errorLog.mockRestore();
      }
    }));
  });
});
