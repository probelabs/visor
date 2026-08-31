import { describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { chmodSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
jest.unmock('child_process');
import {
  goCompatibleProofJson,
  PROOF_ADMISSION_UNAVAILABLE,
  createProofAdmissionCliChildForFocusedTest,
  proofExecutableAvailable,
  startProofAdmissionCliChild,
} from '../../../src/providers/proof-admission-cli-child';
import { createProofAdmitProviderForFocusedTest } from '../../../src/providers/proof-admit-check-provider';
import { snapshotManagedRunStartRequest } from '../../../src/state-machine/dispatch/managed-run';

type ChildModule = typeof import('../../../src/providers/proof-admission-cli-child');
type ProviderModule = typeof import('../../../src/providers/proof-admit-check-provider');
type FakeChild = EventEmitter & {
  pid: number;
  stdin: EventEmitter & { end: jest.Mock };
  stdout: EventEmitter;
  stderr: EventEmitter;
};

async function withExecutable<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'visor-proof-child-test-'));
  const path = join(directory, 'proof');
  try {
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
    return await fn(path);
  } finally {
    try { unlinkSync(path); } catch {}
    try { rmdirSync(directory); } catch {}
  }
}

async function withIsolatedChild<T>(
  fn: (module: ChildModule, spawn: jest.Mock) => Promise<T>
): Promise<T> {
  let result: Promise<T> | undefined;
  try {
    jest.isolateModules(() => {
      const spawn = jest.fn();
      jest.doMock('child_process', () => ({
        ...jest.requireActual<typeof import('child_process')>('child_process'),
        spawn,
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const module = require('../../../src/providers/proof-admission-cli-child') as ChildModule;
      result = fn(module, spawn);
    });
    return await result!;
  } finally {
    jest.dontMock('child_process');
    jest.resetModules();
  }
}

async function withIsolatedProvider<T>(
  fn: (module: ProviderModule, spawn: jest.Mock) => Promise<T>
): Promise<T> {
  let result: Promise<T> | undefined;
  try {
    jest.isolateModules(() => {
      const spawn = jest.fn();
      jest.doMock('child_process', () => ({
        ...jest.requireActual<typeof import('child_process')>('child_process'),
        spawn,
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const module = require('../../../src/providers/proof-admit-check-provider') as ProviderModule;
      result = fn(module, spawn);
    });
    return await result!;
  } finally {
    jest.dontMock('child_process');
    jest.resetModules();
  }
}

function fakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdin = Object.assign(new EventEmitter(), { end: jest.fn() });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function completeFakeChild(child: FakeChild, code: number | null = 0, signal: NodeJS.Signals | null = null): void {
  child.stdout.emit('end');
  child.stderr.emit('end');
  child.emit('exit', code, signal);
  child.emit('close');
}

function mockProcessGroup(child: FakeChild, onSignal?: (signal: NodeJS.Signals) => void) {
  let alive = true;
  const signals: NodeJS.Signals[] = [];
  const nativeKill = process.kill.bind(process);
  const kill = jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid !== -child.pid) return nativeKill(pid, signal);
    if (signal === 0) {
      if (alive) return true;
      const error = Object.assign(new Error('group absent'), { code: 'ESRCH' });
      throw error;
    }
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      signals.push(signal);
      if (signal === 'SIGKILL') alive = false;
      onSignal?.(signal);
      return true;
    }
    return true;
  }) as typeof process.kill);
  return { kill, signals, setAlive: (value: boolean) => { alive = value; } };
}

const binary = process.env.VISOR_PROOF_ADMISSION_BIN;
const capability = binary && proofExecutableAvailable(binary) ? createProofAdmissionCliChildForFocusedTest(binary) : undefined;
const binding: any = {
  managedRunId: '2'.repeat(64), sessionId: 'session', checkId: 'proof_admit',
  scope: [{ kind: 'keyed', expansionOwnerCheck: 'discover', key: 'A', subgraphInstanceId: '1'.repeat(64) }],
  nodeInstanceId: '3'.repeat(64), nodeGenerationId: '4'.repeat(64), attemptId: '5'.repeat(64), fence: 1,
};
function request(candidate: Record<string, unknown>) {
  return {
    binding, workingDirectory: '/tmp',
    proofAdmissionRequest: goCompatibleProofJson({ version: 'proof.role-result-candidate-cli-request/v1', candidate }),
  };
}

function managedRequest(candidateClaim: Record<string, unknown> = {
  claimId: '6'.repeat(64), claim: 'proof.candidate@1', payload: { a: 1 },
  payloadFingerprint: '7'.repeat(64), producerCheckId: 'inspect', scope: binding.scope,
  parentClaimIds: ['8'.repeat(64)], provenance: 'attempt', attemptId: binding.attemptId, fence: binding.fence,
}): any {
  return {
    prInfo: {}, checkConfig: { type: 'proof-admit' },
    dependencyResults: new Map([['inspect', { output: { a: 1 } }]]),
    executionContext: { claims: { candidate: candidateClaim } }, binding,
    executionConfigDigest: '6'.repeat(64), workingDirectory: '/tmp',
    proofAdmissionRequest: request(candidate()).proofAdmissionRequest,
  };
}
function candidate(): Record<string, unknown> {
  const payload = Buffer.from('{"a":1}', 'utf8').toString('base64');
  const scope = [{ Kind: 'keyed', ExpansionOwnerCheck: 'discover', Key: 'A', SubgraphInstanceID: '1'.repeat(64) }];
  const b = { ManagedRunID: binding.managedRunId, SessionID: 'session', CheckID: 'inspect', Scope: scope, NodeInstanceID: binding.nodeInstanceId, NodeGenerationID: binding.nodeGenerationId, AttemptID: binding.attemptId, Fence: 1 };
  return {
    Version: 'proof.role-result-candidate-envelope/v1',
    Invocation: { role_id: 'spec-review', stance: 'owner', subject: { kind: 'requirement', id: 'SYS-REQ-048', fingerprint: `sha256:${'a'.repeat(64)}` }, output_schema_id: 'result', output_schema: Buffer.from('{"type":"object"}').toString('base64') },
    InvocationDigest: `sha256:${'b'.repeat(64)}`, RoleID: 'spec-review', Stance: 'owner', Subject: { kind: 'requirement', id: 'SYS-REQ-048', fingerprint: `sha256:${'a'.repeat(64)}` },
    AttestationVersion: 'probe.governed-codex-attestation/v2', ExecutionSource: 'caller', ProbeInvocationDigest: `sha256:${'b'.repeat(64)}`, IdentityVersion: 'probe.governed-result-identity/v1', IdentitySource: 'probe-host-schema-valid-json', ResultDigest: `sha256:${'c'.repeat(64)}`, CanonicalBytes: 7, ProbeResultBytes: payload, VisorPayloadBytes: payload,
    Publication: { Version: 1, Type: 'ClaimPublished', SessionID: 'session', CheckID: 'inspect', Scope: scope, NodeInstanceID: binding.nodeInstanceId, NodeGenerationID: binding.nodeGenerationId, AttemptID: binding.attemptId, Fence: 1, ClaimID: '6'.repeat(64), Claim: 'proof.candidate@1', PayloadFingerprint: '7'.repeat(64), ProducerCheckID: 'inspect', Payload: payload, ParentClaimIDs: ['8'.repeat(64)] },
    Binding: b,
    Termination: { Version: 1, Type: 'ManagedRunTerminated', SessionID: 'session', Scope: scope, Binding: b, CleanupStatus: 'clean', ControllerDecision: 'completed', FailureCode: null },
  };
}

describe('Proof admission CLI child', () => {
  it('does not expose a product executable when bootstrap is absent', () => {
    expect(proofExecutableAvailable(undefined)).toBe(false);
  });

  it('rejects the real Proof decision without publishing a receipt', async () => {
    if (!binary || !proofExecutableAvailable(binary)) return;
    const run = startProofAdmissionCliChild(request(candidate()), capability);
    await expect(run.started).resolves.toMatchObject({ kind: 'started', binding });
    const outcome: any = await run.outcome;
    expect(outcome).toMatchObject({ version: 1, kind: 'failed', binding });
    await expect(run.close()).resolves.toMatchObject({ kind: 'cleanup', status: 'clean', activeChildren: 0, activeResources: 0 });
  });

  it('fails malformed wire before acquiring a child', () => {
    if (!binary || !proofExecutableAvailable(binary)) return;
    expect(() => startProofAdmissionCliChild({ ...request(candidate()), proofAdmissionRequest: '{"version":"proof.role-result-candidate-cli-request/v1","candidate":{}}' }, capability)).toThrow('PROOF_ADMISSION_INVALID');
  });

  it('reports unavailable on unsupported/invalid executable', () => {
    expect(() => startProofAdmissionCliChild(request(candidate()), undefined)).toThrow(PROOF_ADMISSION_UNAVAILABLE);
  });

  it('binds the executable at construction and rejects replacement before spawn', async () => {
    await withExecutable(async path => withIsolatedChild(async (module, spawn) => {
      const capability = module.createProofAdmissionCliChildForFocusedTest(path);
      writeFileSync(path, '#!/bin/sh\nchanged\n');
      chmodSync(path, 0o755);
      expect(() => module.startProofAdmissionCliChild(request(candidate()), capability)).toThrow(PROOF_ADMISSION_UNAVAILABLE);
      expect(spawn).not.toHaveBeenCalled();
    }));
  });

  async function streamBoundaryCase(channel: 'stdout' | 'stderr', chunks: Buffer[], expectedSignals: NodeJS.Signals[]): Promise<void> {
    await withExecutable(async path => withIsolatedChild(async (module, spawn) => {
      const child = fakeChild(42001);
      const group = mockProcessGroup(child);
      spawn.mockReturnValue(child);
      try {
        const capability = module.createProofAdmissionCliChildForFocusedTest(path);
        const run = module.startProofAdmissionCliChild(request(candidate()), capability);
        child.emit('spawn');
        await expect(run.started).resolves.toMatchObject({ kind: 'started', binding });
        for (const chunk of chunks) child[channel].emit('data', chunk);
        group.setAlive(false);
        completeFakeChild(child);
        await expect(run.outcome).resolves.toMatchObject({ kind: 'failed', binding });
        await expect(run.close()).resolves.toMatchObject({ kind: 'cleanup', status: 'clean', activeChildren: 0, activeResources: 0 });
        expect(group.signals).toEqual(expectedSignals);
      } finally {
        group.kill.mockRestore();
      }
    }));
  }

  it('accounts stdout exact, plus-one, and split-chunk boundaries before overflow', async () => {
    const limit = 2097153;
    await streamBoundaryCase('stdout', [Buffer.alloc(limit, 97)], []);
    await streamBoundaryCase('stdout', [Buffer.alloc(limit + 1, 97)], ['SIGTERM']);
    await streamBoundaryCase('stdout', [Buffer.alloc(limit - 1, 97), Buffer.from('ab')], ['SIGTERM']);
  });

  it('accounts stderr exact, plus-one, and split-chunk boundaries before overflow', async () => {
    const limit = 65536;
    await streamBoundaryCase('stderr', [Buffer.alloc(limit, 97)], []);
    await streamBoundaryCase('stderr', [Buffer.alloc(limit + 1, 97)], ['SIGTERM']);
    await streamBoundaryCase('stderr', [Buffer.alloc(limit - 1, 97), Buffer.from('ab')], ['SIGTERM']);
  });

  async function delayedTerminationCase(method: 'cancel' | 'close'): Promise<void> {
    await withExecutable(async path => withIsolatedChild(async (module, spawn) => {
      jest.useFakeTimers();
      const child = fakeChild(42002);
      const group = mockProcessGroup(child, signal => {
        if (signal === 'SIGKILL') completeFakeChild(child, null, 'SIGKILL');
      });
      spawn.mockReturnValue(child);
      try {
        const capability = module.createProofAdmissionCliChildForFocusedTest(path);
        const run = module.startProofAdmissionCliChild(request(candidate()), capability);
        const primary = method === 'cancel' ? run.cancel('deadline', binding.fence) : run.close();
        const secondary = method === 'cancel' ? run.close() : run.cancel('deadline', binding.fence);
        expect(child.stdin.end).not.toHaveBeenCalled();
        child.emit('spawn');
        await expect(run.started).resolves.toMatchObject({ kind: 'started', binding });
        jest.advanceTimersByTime(250);
        const receipts = await Promise.all([primary, secondary]);
        expect(receipts).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'cancelled', binding, reason: 'deadline' }),
          expect.objectContaining({ kind: 'cleanup', binding, status: 'clean', activeChildren: 0, activeResources: 0 }),
        ]));
        expect(child.stdin.end).not.toHaveBeenCalled();
        expect(group.signals).toEqual(['SIGTERM', 'SIGKILL']);
      } finally {
        group.kill.mockRestore();
        jest.useRealTimers();
      }
    }));
  }

  it('latches cancel before delayed spawn and awaits one clean process-group reap', async () => {
    await delayedTerminationCase('cancel');
  });

  it('latches close before delayed spawn and awaits one clean process-group reap', async () => {
    await delayedTerminationCase('close');
  });

  it('rejects non-exact proof-admit dependencies, aliases, and authority before spawn', async () => {
    await withExecutable(async path => {
      const cases: Array<[string, any]> = [
        ['missing dependency', { dependencyResults: new Map() }],
        ['extra dependency', { dependencyResults: new Map([['inspect', {}], ['other', {}]]) }],
        ['wrong dependency', { dependencyResults: new Map([['wrong', {}]]) }],
        ['missing alias', { executionContext: { claims: {} } }],
        ['extra alias', { executionContext: { claims: { candidate: managedRequest().executionContext.claims.candidate, other: {} } } }],
        ['wrong claim', { executionContext: { claims: { candidate: { ...managedRequest().executionContext.claims.candidate, claim: 'other' } } } }],
        ['wrong producer', { executionContext: { claims: { candidate: { ...managedRequest().executionContext.claims.candidate, producerCheckId: 'other' } } } }],
        ['wrong type', { checkConfig: { type: 'managed' } }],
      ];
      for (const [label, change] of cases) {
        const input = { ...managedRequest(), ...change };
        expect(() => createProofAdmitProviderForFocusedTest(path).startManaged(input)).toThrow('PROOF_ADMISSION_INVALID_CONFIG');
        expect(label).toBeTruthy();
      }
    });
  });

  it('accepts the controller map shell and reaches the child without serializing dependencies', async () => {
    await withExecutable(async path => withIsolatedProvider(async (module, spawn) => {
      const child = fakeChild(42003);
      const group = mockProcessGroup(child);
      spawn.mockReturnValue(child);
      const dependencies = new Map([['inspect', { output: { a: 1 } }]]);
      Object.defineProperty(dependencies, 'hostileEnumerableMethod', { enumerable: true, value: () => { throw new Error('dependency was serialized'); } });
      const snapshot = snapshotManagedRunStartRequest({ ...managedRequest(), dependencyResults: dependencies });
      try {
        const run = module.createProofAdmitProviderForFocusedTest(path).startManaged(snapshot);
        expect(spawn).toHaveBeenCalledTimes(1);
        child.emit('spawn');
        await expect(run.started).resolves.toMatchObject({ kind: 'started', binding });
        group.setAlive(false);
        completeFakeChild(child);
        await expect(run.outcome).resolves.toMatchObject({ kind: 'failed', binding });
        await expect(run.close()).resolves.toMatchObject({ kind: 'cleanup', status: 'clean', activeChildren: 0, activeResources: 0 });
      } finally {
        group.kill.mockRestore();
      }
    }));
  });
});
