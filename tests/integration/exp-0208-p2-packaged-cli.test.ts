import { describe, expect, it, jest } from '@jest/globals';
jest.unmock('child_process');
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { readFileSync, realpathSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { canonicalJson } from '../../src/state-machine/graph/claim-kernel';
import { createGovernedProofInspectProviderForFocusedTest, governedResultDigest } from '../../src/providers/governed-proof-inspect-check-provider';
import type { GovernedProbeRunnerRequest } from '../../src/providers/governed-proof-inspect-check-provider';
import type { CheckProvider } from '../../src/providers/check-provider.interface';
import type { CheckProviderRegistry } from '../../src/providers/check-provider-registry';

const NODE = '/usr/local/bin/node';
const DIST = process.env.VISOR_EXP0208_PACKAGED_DIST || resolve(process.cwd(), 'dist/index.js');
const PROJECT = resolve(__dirname, '../../examples/agent-governance/one-component');
const CONFIG = resolve(PROJECT, 'visor.yaml');
const REQUIREMENT = resolve(PROJECT, 'specs/system/requirements/SYS-REQ-001.req.yaml');
const REAL_PROOF_SHA = '43a0cbc36b0bdf640bc4c712fa00b180208b395bac34a6ee2957528cd43f8272';
const fixtureConfig = (root: string) => { const config = join(root, 'visor.yaml'); writeFileSync(config, 'version: "1.0"\nchecks:\n  discover:\n    type: memory\n    operation: set\n    key: x\n    value: x\n', 'utf8'); return config; };
const run = (cwd: string, args: string[]) => { const cp = jest.requireActual('child_process') as typeof import('child_process'); const childEnv = { ...process.env, VISOR_NO_REMOTE_EXTENDS: 'true', NO_COLOR: '1' }; delete childEnv.NODE_ENV; delete childEnv.JEST_WORKER_ID; try { const stdout = cp.execFileSync(NODE, [DIST, ...args], { cwd, encoding: 'utf8', env: childEnv, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }); return { status: 0, stdout, stderr: '' }; } catch (error: any) { return { status: typeof error.status === 'number' ? error.status : 1, stdout: error.stdout?.toString() || '', stderr: error.stderr?.toString() || '' }; } };
const proofSha = (value: string) => createHash('sha256').update(readFileSync(realpathSync(value))).digest('hex');
const fileSha = (value: string) => createHash('sha256').update(readFileSync(value)).digest('hex');
const providerMap = (registry: CheckProviderRegistry): Map<string, CheckProvider> => Object.getOwnPropertyDescriptor(registry as any, 'providers')!.value as Map<string, CheckProvider>;
type InProcessMode = { label: string; close: () => void; memoryFailure: boolean };
function fakeAnswer(request: GovernedProbeRunnerRequest): any {
  const data = { decision: 'accept' }; const digest = governedResultDigest(data); const d = 'c'.repeat(64);
  return { data, runtimeAttestation: { version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' }, observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' }, executionContext: { source: 'caller', invocationDigest: request.invocationDigest }, dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: digest, promptBytes: 0 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' } }, resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: digest, canonicalBytes: Buffer.byteLength(canonicalJson(data)) } };
}
async function runInProcess(proof: string, target: string, answer: (request: GovernedProbeRunnerRequest) => unknown, close: () => void = () => {}, failMemoryCleanup = false): Promise<any> {
  const { CheckProviderRegistry } = await import('../../src/providers/check-provider-registry'); const registry = CheckProviderRegistry.getInstance(); const map = providerMap(registry); const original = [...map.entries()]; let answers = 0; let clearSpy: { mockRestore: () => void } | undefined;
  if (failMemoryCleanup) { const { MemoryStore } = await import('../../src/memory-store'); const memory = MemoryStore.getInstance(); const realClear = memory.clear.bind(memory); let calls = 0; clearSpy = jest.spyOn(memory, 'clear').mockImplementation(async namespace => { if (++calls === 1) throw new Error('cleanup sentinel'); return realClear(namespace); }); }
  map.set('governed-proof-inspect', createGovernedProofInspectProviderForFocusedTest(() => ({ answer: request => { answers++; return answer(request); }, cancel: () => {}, close }))); const oldArgv = process.argv; const oldExit = process.exit; const oldCwd = process.cwd(); const exit = jest.fn(); process.exit = exit as any;
  try { process.chdir(PROJECT); process.argv = ['node', 'visor', '--config', CONFIG, '--check', 'discover', '--event', 'manual', '--disable-code-context', '--output', 'json', '--proof-bin', resolve(proof), '--governed-receipt', target]; const { main } = await import('../../src/cli-main'); await main(); return { exit, answers }; } finally { clearSpy?.mockRestore(); process.argv = oldArgv; process.exit = oldExit; process.chdir(oldCwd); map.clear(); for (const entry of original) map.set(entry[0], entry[1]); CheckProviderRegistry.clearInstance(); }
}

describe('EXP-0208 packaged CLI receipt surface', () => {
  it('exposes the receipt flag from packaged dist without running a check', () => {
    const result = run(process.cwd(), ['--help']); expect(result.status).toBe(0); expect(`${result.stdout}\n${result.stderr}`).toContain('--governed-receipt');
  });

  it('rejects missing configuration/proof before provider work and emits no receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-p2-packaged-')); chmodSync(root, 0o700); const target = join(root, 'receipt.json');
    try { const result = run(root, ['--output', 'json', '--check', 'discover', '--governed-receipt', target]); expect(result.status).not.toBe(0); expect(existsSync(target)).toBe(false); } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects existing and symlink targets before C0 with no overwrite', () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-p2-packaged-')); chmodSync(root, 0o700); const config = fixtureConfig(root); const target = join(root, 'receipt.json');
    try {
      writeFileSync(target, 'sentinel\n', 'utf8'); const existing = run(root, ['--output', 'json', '--check', 'discover', '--config', config, '--proof-bin', '/bin/false', '--governed-receipt', target]); expect(existing.status).not.toBe(0); expect(require('fs').readFileSync(target, 'utf8')).toBe('sentinel\n');
      rmSync(target); const outside = join(root, 'outside.json'); symlinkSync(outside, target); const linked = run(root, ['--output', 'json', '--check', 'discover', '--config', config, '--proof-bin', '/bin/false', '--governed-receipt', target]); expect(linked.status).not.toBe(0); expect(existsSync(outside)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('bounds a C0/pre-provider failure without packaged success or receipt claims', () => {
    const root = mkdtempSync(join(tmpdir(), 'visor-p2-packaged-')); chmodSync(root, 0o700); const config = fixtureConfig(root); const target = join(root, 'receipt.json');
    try { const result = run(root, ['--output', 'json', '--check', 'discover', '--config', config, '--proof-bin', '/bin/false', '--governed-receipt', target]); expect(result.status).not.toBe(0); expect(existsSync(target)).toBe(false); expect(`${result.stdout}\n${result.stderr}`).not.toContain('proof.candidate@1'); } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('emits the exact passed receipt after real Proof and cleanup', async () => {
    const proof = process.env.VISOR_EXP0208_REAL_PROOF_BIN; if (!proof) return; expect(proofSha(proof)).toBe(REAL_PROOF_SHA);
    const root = mkdtempSync(join(tmpdir(), 'visor-p2-in-process-')); chmodSync(root, 0o700); const target = join(root, 'receipt.json');
    try { const result = await runInProcess(proof, target, fakeAnswer); expect(result.exit).toHaveBeenCalledWith(0); expect(result.answers).toBe(1); const value: any = JSON.parse(readFileSync(target, 'utf8')); expect(Object.keys(value).sort()).toEqual(['activeChildren','activeResources','admittedReceiptClaimId','attestation','candidateClaimId','componentCount','exitStatus','failureCode','graphSemanticDigest','managedUncleanTerminalCount','memoryStatus','nodes','projectionReplayEqual','providerCleanupStatus','sessionId','sourceConfigSha256','status','verifyInputClaimIds','version'].sort()); expect(value.status).toBe('passed'); expect(value.exitStatus).toBe(0); expect(value.componentCount).toBe(1); expect(value.nodes).toEqual({ inspect: { terminalCount: 1, status: 'completed' }, proof_admit: { terminalCount: 1, status: 'completed' }, verify: { terminalCount: 1, status: 'completed' } }); expect(value.verifyInputClaimIds).toEqual([value.candidateClaimId, value.admittedReceiptClaimId]); expect(value.providerCleanupStatus).toBe('clean'); expect(value.memoryStatus).toBe('clean'); expect(value.managedUncleanTerminalCount).toBe(0); expect(value.activeChildren).toBe(0); expect(value.activeResources).toBe(0); expect(value.projectionReplayEqual).toBe(true); expect(value.attestation).toEqual({ version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', dispatch: { source: 'probe-host-tools-call', tool: 'codex' }, eventCount: 1, usage: { status: 'unavailable' } }); } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it('emits an authoritative failed receipt when real Proof rejects a stale candidate', async () => {
    const proof = process.env.VISOR_EXP0208_REAL_PROOF_BIN; if (!proof) return; expect(proofSha(proof)).toBe(REAL_PROOF_SHA); const original = readFileSync(REQUIREMENT, 'utf8'); const requirementDigest = fileSha(REQUIREMENT); const requirementMode = statSync(REQUIREMENT).mode;
    const root = mkdtempSync(join(tmpdir(), 'visor-p2-in-process-')); chmodSync(root, 0o700); const target = join(root, 'receipt.json'); let changed = false;
    try { const result = await runInProcess(proof, target, request => { if (!changed) { changed = true; writeFileSync(REQUIREMENT, original.replace('component_ready', 'component_changed'), 'utf8'); } return fakeAnswer(request); }); expect(result.exit).toHaveBeenCalledWith(1); expect(result.answers).toBe(1); const value: any = JSON.parse(readFileSync(target, 'utf8')); expect(value.status).toBe('failed'); expect(value.exitStatus).toBe(1); expect(value.failureCode).toBe('MANAGED_OUTCOME_FAILED'); expect(value.nodes).toEqual({ inspect: { terminalCount: 1, status: 'completed' }, proof_admit: { terminalCount: 1, status: 'failed' }, verify: { terminalCount: 0, status: 'absent' } }); expect(value.candidateClaimId).toMatch(/^[0-9a-f]{64}$/); expect(value.admittedReceiptClaimId).toBeNull(); expect(value.verifyInputClaimIds).toEqual([]); expect(value.providerCleanupStatus).toBe('clean'); expect(value.memoryStatus).toBe('clean'); expect(value.activeChildren).toBe(0); expect(value.activeResources).toBe(0); } finally { writeFileSync(REQUIREMENT, original, 'utf8'); expect(fileSha(REQUIREMENT)).toBe(requirementDigest); expect(statSync(REQUIREMENT).mode).toBe(requirementMode); rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it('emits no receipt when provider or owned-memory cleanup fails', async () => {
    const proof = process.env.VISOR_EXP0208_REAL_PROOF_BIN; if (!proof) return; expect(proofSha(proof)).toBe(REAL_PROOF_SHA);
    const modes: readonly InProcessMode[] = [{ label: 'provider', close: () => { throw new Error('provider cleanup sentinel'); }, memoryFailure: false }, { label: 'memory', close: () => {}, memoryFailure: true }];
    for (const { label, close, memoryFailure } of modes) {
      const root = mkdtempSync(join(tmpdir(), `visor-p2-${label}-`)); chmodSync(root, 0o700); const target = join(root, 'receipt.json');
      try { const result = await runInProcess(proof, target, fakeAnswer, close, memoryFailure); expect(result.exit).toHaveBeenCalledWith(1); expect(existsSync(target)).toBe(false); } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 30000);
});
