import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, jest } from '@jest/globals';
import { canonicalJson } from '../../src/state-machine/graph/claim-kernel';
import { finalizeGovernedGraphTerminalReceipt, publishGovernedGraphTerminalReceipt, serializeGovernedGraphTerminalReceipt, validateGovernedGraphTerminalReceipt } from '../../src/governed-graph-terminal-receipt';

const digest = 'a'.repeat(64);
function receipt(status: 'passed' | 'failed' = 'passed'): any {
  const failed = status === 'failed';
  return { version: 'visor.governed-graph-terminal-receipt/v1', status, sourceConfigSha256: digest, sessionId: 'session-1', graphSemanticDigest: digest, componentCount: 1, nodes: { inspect: { terminalCount: 1, status: 'completed' }, proof_admit: { terminalCount: 1, status: failed ? 'failed' : 'completed' }, verify: { terminalCount: failed ? 0 : 1, status: failed ? 'absent' : 'completed' } }, attestation: { version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', dispatch: { source: 'probe-host-tools-call', tool: 'codex' }, eventCount: 1, usage: { status: 'unavailable' } }, candidateClaimId: digest, admittedReceiptClaimId: failed ? null : digest, verifyInputClaimIds: failed ? [] : [digest, digest], providerCleanupStatus: 'clean', managedUncleanTerminalCount: 0, activeChildren: 0, activeResources: 0, memoryStatus: 'clean', projectionReplayEqual: true, failureCode: failed ? 'MANAGED_OUTCOME_FAILED' : null, exitStatus: failed ? 1 : 0 };
}

describe('governed terminal receipt', () => {
  it('accepts the closed passed schema and emits canonical LF JSON without payloads', () => {
    const value = receipt(); validateGovernedGraphTerminalReceipt(value);
    const bytes = serializeGovernedGraphTerminalReceipt(value);
    expect(bytes.toString('utf8')).toBe(canonicalJson(value) + '\n');
    expect(bytes.toString('utf8')).not.toContain('decision');
  });

  it('fails closed for unknown, symbol, accessor, malformed unicode, noncanonical, and failed variants', () => {
    expect(() => validateGovernedGraphTerminalReceipt({ ...receipt(), payload: 'secret' })).toThrow();
    expect(() => validateGovernedGraphTerminalReceipt(Object.assign(receipt(), { [Symbol('x')]: 1 }))).toThrow();
    const accessor: any = receipt(); Object.defineProperty(accessor, 'sessionId', { get: () => 'x', enumerable: true }); expect(() => validateGovernedGraphTerminalReceipt(accessor)).toThrow();
    expect(() => validateGovernedGraphTerminalReceipt({ ...receipt(), sessionId: '\ud800' })).toThrow();
    const usageLeak: any = receipt(); usageLeak.attestation = { ...usageLeak.attestation, usage: { status: 'unavailable', value: 'sensitive-proof-output' } }; expect(() => validateGovernedGraphTerminalReceipt(usageLeak)).toThrow();
    const duplicateTerminal: any = receipt(); duplicateTerminal.nodes.inspect.terminalCount = 2; expect(() => validateGovernedGraphTerminalReceipt(duplicateTerminal)).toThrow();
    const failed = receipt('failed'); expect(() => validateGovernedGraphTerminalReceipt(failed)).not.toThrow(); expect(() => finalizeGovernedGraphTerminalReceipt({ ...failed, failureCode: null }, 'failed', 'clean', 1)).toThrow(); expect(() => finalizeGovernedGraphTerminalReceipt(failed, 'failed', 'failed', 1)).toThrow();
  });

  it('publishes atomically with 0600 mode, refuses overwrite and symlink targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-receipt-')); chmodSync(root, 0o700); const target = join(root, 'receipt.json');
    try {
      publishGovernedGraphTerminalReceipt(receipt(), target);
      expect(statSync(target).mode & 0o777).toBe(0o600); expect(readFileSync(target, 'utf8')).toBe(canonicalJson(receipt()) + '\n');
      expect(() => publishGovernedGraphTerminalReceipt(receipt(), target)).toThrow();
      const symlink = join(root, 'link.json'); const outside = join(root, 'outside.json'); symlinkSync(outside, symlink); expect(() => publishGovernedGraphTerminalReceipt(receipt(), symlink)).toThrow(); expect(!existsSync(outside)).toBe(true);
      const parentLink = join(root, 'parent-link'); const parent = join(root, 'parent'); require('fs').mkdirSync(parent); symlinkSync(parent, parentLink); expect(() => publishGovernedGraphTerminalReceipt(receipt(), join(parentLink, 'receipt.json'))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('finalizes a failed clean graph only with exit 1 and clean memory', () => {
    const { status: _status, memoryStatus: _memoryStatus, exitStatus: _exitStatus, ...draft } = receipt('failed');
    const finalized = finalizeGovernedGraphTerminalReceipt(draft, 'failed', 'clean', 1);
    expect(finalized.status).toBe('failed'); expect(finalized.failureCode).toBe('MANAGED_OUTCOME_FAILED');
    expect(() => finalizeGovernedGraphTerminalReceipt({ ...draft, failureCode: null }, 'failed', 'clean', 1)).toThrow();
    expect(() => finalizeGovernedGraphTerminalReceipt(draft, 'failed', 'failed', 1)).toThrow();
  });

  it('rolls back an owned target after parent fsync failure and leaves no temp survivor', () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-receipt-')); chmodSync(root, 0o700); const target = join(root, 'receipt.json');
    jest.isolateModules(() => {
      const actualFs = jest.requireActual<typeof import('fs')>('fs'); let calls = 0;
      jest.doMock('fs', () => ({ ...actualFs, fsyncSync: (fd: number) => { if (++calls === 2) throw new Error('parent fsync'); return actualFs.fsyncSync(fd); } }));
      try { const isolated = require('../../src/governed-graph-terminal-receipt') as typeof import('../../src/governed-graph-terminal-receipt'); expect(() => isolated.publishGovernedGraphTerminalReceipt(receipt(), target)).toThrow('parent fsync'); } finally { jest.dontMock('fs'); }
    });
    expect(existsSync(target)).toBe(false); expect(readdirSync(root)).toEqual([]); rmSync(root, { recursive: true, force: true });
  });

  it('removes the owned temporary file after file fsync failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-receipt-')); chmodSync(root, 0o700); const target = join(root, 'receipt.json');
    jest.isolateModules(() => {
      const actualFs = jest.requireActual<typeof import('fs')>('fs');
      jest.doMock('fs', () => ({ ...actualFs, fsyncSync: () => { throw new Error('file fsync'); } }));
      try { const isolated = require('../../src/governed-graph-terminal-receipt') as typeof import('../../src/governed-graph-terminal-receipt'); expect(() => isolated.publishGovernedGraphTerminalReceipt(receipt(), target)).toThrow('file fsync'); } finally { jest.dontMock('fs'); }
    });
    expect(existsSync(target)).toBe(false); expect(readdirSync(root)).toEqual([]); rmSync(root, { recursive: true, force: true });
  });
});
