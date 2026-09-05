import { describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProofAdmissionCliChildForFocusedTest } from '../../../src/providers/proof-admission-cli-child';
import { CheckProviderRegistry } from '../../../src/providers/check-provider-registry';
import type { ManagedRunStartRequest } from '../../../src/providers/check-provider.interface';

const PROOF_PROJECT_RECONCILE_PROVIDER_TYPE = 'proof-project-reconcile';
const PROOF_PROJECT_RECONCILIATION_REQUEST_VERSION = 'proof.project-reconciliation-request/v1';
const PROOF_PROJECT_RECONCILIATION_RECEIPT_VERSION = 'proof.project-reconciliation-receipt/v1';
const PROOF_PROJECT_RECONCILIATION_INPUT_MAX_BYTES = 32 * 1024 * 1024;
const PROOF_PROJECT_RECONCILIATION_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

type ProjectProviderModule = typeof import('../../../src/providers/proof-project-reconcile-check-provider');
type ChildModule = typeof import('../../../src/providers/proof-admission-cli-child');
type FakeChild = EventEmitter & {
  pid: number;
  stdin: EventEmitter & { end: jest.Mock };
  stdout: EventEmitter;
  stderr: EventEmitter;
};

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

function mockProcessGroup(child: FakeChild) {
  let alive = true;
  const nativeKill = process.kill.bind(process);
  const kill = jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid !== -child.pid) return nativeKill(pid, signal);
    if (signal === 0) {
      if (alive) return true;
      throw Object.assign(new Error('group absent'), { code: 'ESRCH' });
    }
    return true;
  }) as typeof process.kill);
  return { kill, setAlive: (value: boolean) => { alive = value; } };
}

async function withIsolatedProjectProvider<T>(
  fn: (module: ProjectProviderModule, childModule: ChildModule, spawn: jest.Mock) => Promise<T>,
): Promise<T> {
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
      const module = require('../../../src/providers/proof-project-reconcile-check-provider') as ProjectProviderModule;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const childModule = require('../../../src/providers/proof-admission-cli-child') as ChildModule;
      result = fn(module, childModule, spawn);
    });
    return await result!;
  } finally {
    jest.dontMock('child_process');
    jest.resetModules();
  }
}

const binding = {
  managedRunId: '1'.repeat(64),
  sessionId: 'reconcile-test',
  checkId: 'project_reconcile',
  scope: [],
  nodeInstanceId: '2'.repeat(64),
  nodeGenerationId: '3'.repeat(64),
  attemptId: '4'.repeat(64),
  fence: 1,
} as any;

function reconciliationRequest(): string {
  return JSON.stringify({
    version: PROOF_PROJECT_RECONCILIATION_REQUEST_VERSION,
    discovery_candidate: { candidate: 'wire' },
    discovery_admission: { admission: 'wire' },
    catalog_revalidation: { revalidation: 'wire' },
    outcomes: [{ component_id: 'component-a', result: 'wire' }],
  });
}

function reconciliationReceipt(): string {
  return JSON.stringify({
    version: PROOF_PROJECT_RECONCILIATION_RECEIPT_VERSION,
    project_authority: { project_id: 'fixture-project' },
    catalog_revalidation_receipt: { receipt_id: 'sha256:' + 'b'.repeat(64) },
    component_admissions: [],
    covered_work_item_digests: [],
    receipt_id: 'sha256:' + 'c'.repeat(64),
  });
}

function managedRequest(input: string): ManagedRunStartRequest {
  return {
    prInfo: {} as any,
    checkConfig: { type: PROOF_PROJECT_RECONCILE_PROVIDER_TYPE },
    dependencyResults: new Map(),
    executionContext: {},
    binding,
    executionConfigDigest: 'sha256:' + 'a'.repeat(64),
    workingDirectory: process.cwd(),
    proofProjectReconciliationRequest: input,
  };
}

type FixtureMode = 'success' | 'malformed' | 'oversize';

async function withProofFixture<T>(mode: FixtureMode, fn: (fixture: { path: string; inputPath: string; argsPath: string }) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'visor-project-reconcile-test-'));
  const path = join(directory, 'proof');
  const inputPath = join(directory, 'input');
  const argsPath = join(directory, 'args');
  const script = `#!${process.execPath}
const fs = require('fs');
const inputPath = ${JSON.stringify(inputPath)};
const argsPath = ${JSON.stringify(argsPath)};
const mode = ${JSON.stringify(mode)};
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(inputPath, input, 'utf8');
  fs.writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)), 'utf8');
  if (mode === 'malformed') { process.stdout.write('not-json\\n'); return; }
  if (mode === 'oversize') { process.stdout.write('x'.repeat(${PROOF_PROJECT_RECONCILIATION_OUTPUT_MAX_BYTES + 1}) + '\\n'); return; }
  process.stdout.write(${JSON.stringify(reconciliationReceipt())} + '\\n');
});
`;
  writeFileSync(path, script, 'utf8');
  chmodSync(path, 0o755);
  try {
    return await fn({ path, inputPath, argsPath });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Proof project reconciliation provider', () => {
  afterEach(() => CheckProviderRegistry.clearInstance());

  it('is unavailable before Proof bootstrap, then seals the provider after bootstrap', async () => {
    await withProofFixture('success', async fixture => {
      const registry = CheckProviderRegistry.getInstance();
      const providers = (registry as any).providers as Map<string, { isAvailable(): Promise<boolean> }>;
      const before = providers.get(PROOF_PROJECT_RECONCILE_PROVIDER_TYPE);
      expect(before).toBeDefined();
      await expect(before!.isAvailable()).resolves.toBe(false);
      expect(() => registry.register({ getName: () => PROOF_PROJECT_RECONCILE_PROVIDER_TYPE } as any)).toThrow('reserved');
      expect(() => registry.unregister(PROOF_PROJECT_RECONCILE_PROVIDER_TYPE)).toThrow('reserved');

      registry.bootstrapProofAdmission(createProofAdmissionCliChildForFocusedTest(fixture.path));
      const after = providers.get(PROOF_PROJECT_RECONCILE_PROVIDER_TYPE);
      expect(after).toBeDefined();
      await expect(after!.isAvailable()).resolves.toBe(true);
      expect(after).not.toBe(before);
      expect(() => registry.register({ getName: () => PROOF_PROJECT_RECONCILE_PROVIDER_TYPE } as any)).toThrow('reserved');
      expect(() => registry.unregister(PROOF_PROJECT_RECONCILE_PROVIDER_TYPE)).toThrow('reserved');
    });
  });

  it('sends the exact reconciliation request with the exact Proof command', async () => {
    await withProofFixture('success', async fixture => withIsolatedProjectProvider(async (module, _childModule, spawn) => {
      const child = fakeChild(42101);
      const group = mockProcessGroup(child);
      spawn.mockReturnValue(child);
      try {
        const input = reconciliationRequest();
        const provider = module.createProofProjectReconcileProviderForFocusedTest(fixture.path);
        const run = provider.startManaged(managedRequest(input));

        expect(spawn).toHaveBeenCalledWith(realpathSync(fixture.path), ['onboarding', 'reconcile'], expect.objectContaining({
          cwd: process.cwd(),
          shell: false,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        }));
        child.emit('spawn');
        await expect(run.started).resolves.toMatchObject({ kind: 'started', binding });
        const [written, encoding, callback] = child.stdin.end.mock.calls[0];
        expect(written).toBe(input);
        expect(encoding).toBe('utf8');
        callback();
        child.stdout.emit('data', Buffer.from(reconciliationReceipt() + '\n', 'utf8'));
        group.setAlive(false);
        completeFakeChild(child);
        await expect(run.outcome).resolves.toMatchObject({
          kind: 'succeeded',
          binding,
          summary: { output: { version: PROOF_PROJECT_RECONCILIATION_RECEIPT_VERSION } },
        });
        await expect(run.close()).resolves.toMatchObject({ kind: 'cleanup', status: 'clean', activeChildren: 0, activeResources: 0 });
      } finally {
        group.kill.mockRestore();
      }
    }));
  });

  it('rejects malformed and oversize requests before acquiring Proof', async () => {
    await withProofFixture('success', async fixture => withIsolatedProjectProvider(async module => {
      const provider = module.createProofProjectReconcileProviderForFocusedTest(fixture.path);
      expect(() => provider.startManaged(managedRequest('{'))).toThrow('PROOF_RECONCILIATION_INVALID');
      expect(() => provider.startManaged(managedRequest('x'.repeat(PROOF_PROJECT_RECONCILIATION_INPUT_MAX_BYTES + 1)))).toThrow('PROOF_ADMISSION_UNAVAILABLE');
    }));
  });

  it.each(['malformed', 'oversize'] as const)('rejects %s Proof output and cleans up', async mode => {
    await withProofFixture(mode, async fixture => withIsolatedProjectProvider(async (module, _childModule, spawn) => {
      const child = fakeChild(mode === 'malformed' ? 42102 : 42103);
      const group = mockProcessGroup(child);
      spawn.mockReturnValue(child);
      try {
        const provider = module.createProofProjectReconcileProviderForFocusedTest(fixture.path);
        const run = provider.startManaged(managedRequest(reconciliationRequest()));
        child.emit('spawn');
        await expect(run.started).resolves.toMatchObject({ kind: 'started', binding });
        const callback = child.stdin.end.mock.calls[0][2] as () => void;
        callback();
        child.stdout.emit('data', mode === 'malformed'
          ? Buffer.from('not-json\n', 'utf8')
          : Buffer.alloc(PROOF_PROJECT_RECONCILIATION_OUTPUT_MAX_BYTES + 1, 120));
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
