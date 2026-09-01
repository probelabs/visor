import { describe, expect, it, jest } from '@jest/globals';
jest.unmock('child_process');
import { createHash } from 'crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { canonicalJson } from '../../src/state-machine/graph/claim-kernel';
import { createGovernedProofInspectProviderForFocusedTest, governedResultDigest, GOVERNED_PROOF_INSPECT_MESSAGE } from '../../src/providers/governed-proof-inspect-check-provider';
import type { GovernedProbeRunnerRequest } from '../../src/providers/governed-proof-inspect-check-provider';
import type { CheckProvider } from '../../src/providers/check-provider.interface';
import type { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import type { PRInfo } from '../../src/pr-analyzer';

const PROJECT = resolve(__dirname, '../../examples/agent-governance/one-component');
const CONFIG = resolve(PROJECT, 'visor.yaml');
const FINGERPRINT = 'sha256:2d734abe14567b9dc1ebc65b47ccb01493c31f14bdf97ca1a336d66cda0f1170';
const SCHEMA = 'eyJ0eXBlIjoib2JqZWN0IiwiYWRkaXRpb25hbFByb3BlcnRpZXMiOmZhbHNlLCJyZXF1aXJlZCI6WyJkZWNpc2lvbiJdLCJwcm9wZXJ0aWVzIjp7ImRlY2lzaW9uIjp7InR5cGUiOiJzdHJpbmciLCJlbnVtIjpbImFjY2VwdCJdfX19';
const REAL_PROOF_SHA = '43a0cbc36b0bdf640bc4c712fa00b180208b395bac34a6ee2957528cd43f8272';
const prInfo = { number: 1, title: 'EXP-0208', author: 'test', base: 'main', head: 'demo', files: [], totalAdditions: 0, totalDeletions: 0, eventType: 'manual' } as PRInfo;
const oldC0Timeout = process.env.VISOR_PROOF_C0_TIMEOUT_MS;
beforeAll(() => { process.env.VISOR_PROOF_C0_TIMEOUT_MS = '3000'; });
afterAll(() => { if (oldC0Timeout === undefined) delete process.env.VISOR_PROOF_C0_TIMEOUT_MS; else process.env.VISOR_PROOF_C0_TIMEOUT_MS = oldC0Timeout; });

function invocation() { return { role_id: 'spec-review', stance: 'owner', subject: { kind: 'requirement', id: 'SYS-REQ-001', fingerprint: FINGERPRINT }, output_schema_id: 'proof.findings/v1', output_schema: SCHEMA }; }
function fakeAnswer(request: GovernedProbeRunnerRequest) {
  const data = { decision: 'accept' }; const digest = governedResultDigest(data); const d = 'c'.repeat(64);
  return { data, runtimeAttestation: { version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' }, observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' }, executionContext: { source: 'caller', invocationDigest: request.invocationDigest }, dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: digest, promptBytes: 0 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' } }, resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: digest, canonicalBytes: Buffer.byteLength(canonicalJson(data)) } };
}

function proofIdentity(proof: string) {
  const realpath = realpathSync(proof); const stat = statSync(realpath);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error('real Proof is not executable');
  return { realpath, sha256: createHash('sha256').update(readFileSync(realpath)).digest('hex'), dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function fixtureInventory(root: string): string {
  const entries: unknown[] = [];
  const visit = (relative: string) => {
    if (relative === '.visor' || relative.startsWith('.visor/') || relative === 'output' || relative.startsWith('output/')) return;
    const full = join(root, relative); const stat = lstatSync(full);
    if (relative) {
      const entry: Record<string, unknown> = { path: relative, mode: stat.mode, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other' };
      if (stat.isFile()) entry.bytes = readFileSync(full).toString('base64');
      if (stat.isSymbolicLink()) entry.target = readlinkSync(full);
      entries.push(entry);
    }
    if (stat.isDirectory()) for (const child of readdirSync(full)) visit(relative ? join(relative, child) : child);
  };
  visit('');
  return JSON.stringify(entries.sort((left, right) => String((left as any).path).localeCompare(String((right as any).path))));
}

function waitForMarker(marker: string, timeout = 3000): Promise<number> {
  const started = Date.now();
  return new Promise((resolveMarker, rejectMarker) => {
    const poll = () => {
      if (existsSync(marker)) {
        const value = Number(readFileSync(marker, 'utf8'));
        if (Number.isFinite(value)) { resolveMarker(value); return; }
        rejectMarker(new Error(`invalid marker: ${marker}`)); return;
      }
      if (Date.now() - started >= timeout) { rejectMarker(new Error(`marker timeout: ${marker}`)); return; }
      setTimeout(poll, 5);
    };
    poll();
  });
}

async function waitForNoExtraHandles(handles: Set<unknown>, timeout = 250): Promise<void> {
  const started = Date.now();
  while ([...(process as any)._getActiveHandles?.() || []].some(handle => !handles.has(handle))) {
    if (Date.now() - started >= timeout) return;
    await new Promise(resolveHandle => setTimeout(resolveHandle, 5));
  }
}

function recordSignals() {
  const original = process.kill; const signals: Array<{ signal: string; at: number; pid: number }> = [];
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => { if (signal === 'SIGTERM' || signal === 'SIGKILL') signals.push({ signal, at: Date.now(), pid }); return (original as any)(pid, signal); }) as typeof process.kill;
  return { signals, restore: () => { process.kill = original; } };
}

/** A hermetic protocol fixture: it speaks the Proof wire contract, not real Proof. */
function withProtocolFixture<T>(fn: (path: string, pidFile?: string, markers?: { ready: string; term: string }) => Promise<T>, mode = 'success'): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'visor-exp-0208-proof-')); const proof = join(directory, 'proof'); const pidFile = join(directory, 'group.pid'); const readyFile = join(directory, 'descendant.ready'); const termFile = join(directory, 'descendant.term');
  const script = `#!${process.execPath}
const crypto = require('crypto');
function canon(v) { if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'; if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'; return JSON.stringify(v); }
function digest(domain, bytes) { const n = Buffer.alloc(8); n.writeBigUInt64BE(BigInt(bytes.length)); return 'sha256:' + crypto.createHash('sha256').update(domain).update(Buffer.from([0])).update(n).update(bytes).digest('hex'); }
const mode = ${JSON.stringify(mode)}; const pidFile = ${JSON.stringify(pidFile)}; const readyFile = ${JSON.stringify(readyFile)}; const termFile = ${JSON.stringify(termFile)}; let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { try {
  const request = JSON.parse(input); let output;
  if (mode === 'hung') { require('fs').writeFileSync(pidFile, String(process.pid)); require('child_process').spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], {stdio:'ignore'}); process.on('SIGTERM',()=>{}); setInterval(() => {}, 1000); return; }
  if (mode === 'parent-exits-c0' || (mode === 'parent-exits-descendant' && process.argv[2] === 'admit-candidate')) { const descendant = \"const fs=require('fs'); const ready=\" + JSON.stringify(readyFile) + \", term=\" + JSON.stringify(termFile) + \"; process.on('SIGTERM',()=>fs.writeFileSync(term,String(Date.now()))); fs.writeFileSync(ready,String(Date.now())); setInterval(()=>{},1000);\"; require('child_process').spawn(process.execPath, ['-e', descendant], {stdio:'ignore'}); const wait = setInterval(() => { if (require('fs').existsSync(readyFile)) { clearInterval(wait); require('fs').writeFileSync(pidFile, String(process.pid)); process.exit(0); } }, 1); }
  if (process.argv[2] === 'resolve-role-invocation') { if (mode === 'malformed') { process.stdout.write('not-json\\n'); return; } if (mode === 'nonzero') { process.exitCode = 7; return; } if (mode === 'cap') { process.stdout.write('x'.repeat(2097154)); return; } const schema = Buffer.from(request.output_schema, 'base64'); output = { version: 'proof.role-invocation/v1', role_id: request.role_id, role_source: 'proof-fixture', stance: request.stance, subject: mode === 'changed-subject' ? { ...request.subject, id: 'other' } : request.subject, authority: { source: 'proof-fixture' }, output_schema_id: request.output_schema_id, output_schema: request.output_schema, output_schema_digest: digest('proof.role-output-schema/id/v1', schema), instructions: 'Review the bound subject and return the schema-shaped result.', role_text_digest: digest('proof.role-text/id/v1', Buffer.from(request.role_id)), invocation_digest: digest('proof.role-invocation/id/v1', Buffer.from(canon(request))) }; }
  else if (process.argv[2] === 'admit-candidate') { const c = request.candidate; if (mode === 'reject') { output = { version: 'proof.role-result-candidate-cli-decision/v1', status: 'REJECTED', receipt: null, reject_code: 'CANDIDATE_INVALID' }; } else { const p = c.Publication; const unsigned = { Version: 'proof.role-result-candidate-admission/v1', Status: 'ADMITTED', CandidateID: digest('proof.role-result-candidate-envelope/id/v1', Buffer.from(JSON.stringify(c))), ProbeResultDigest: c.ResultDigest, ProbeCanonicalBytes: c.CanonicalBytes, ClaimID: p.ClaimID, Claim: p.Claim, PayloadFingerprint: p.PayloadFingerprint, InvocationDigest: c.InvocationDigest, RoleID: c.RoleID, Stance: c.Stance, Subject: c.Subject, ProducerCheckID: p.ProducerCheckID, ParentClaimIDs: p.ParentClaimIDs, Binding: c.Binding, Termination: c.Termination }; const receipt = { ...unsigned, receipt_id: digest('proof.role-result-candidate-receipt/id/v1', Buffer.from(JSON.stringify(unsigned))) }; output = { version: 'proof.role-result-candidate-cli-decision/v1', status: 'ADMITTED', receipt, reject_code: null }; } }
  else throw new Error('unsupported command'); process.stdout.write(JSON.stringify(output) + '\\n');
} catch (error) { process.stderr.write(String(error)); process.exitCode = 1; } });
`;
  writeFileSync(proof, script, 'utf8'); chmodSync(proof, 0o755);
  return Promise.resolve().then(() => fn(proof, pidFile, { ready: readyFile, term: termFile })).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function providerMap(registry: CheckProviderRegistry): Map<string, CheckProvider> { return Object.getOwnPropertyDescriptor(registry as any, 'providers')!.value as Map<string, CheckProvider>; }

describe('EXP-0208 product-native demo pack', () => {
  it('uses normal cli-main argv and reaches a successful governed run', async () => {
    await withProtocolFixture(async proof => {
      const { CheckProviderRegistry } = await import('../../src/providers/check-provider-registry'); const registry = CheckProviderRegistry.getInstance(); const map = providerMap(registry); const original = [...map.entries()]; let runnerCalls = 0;
      const { MemoryStore } = await import('../../src/memory-store'); const memory = MemoryStore.getInstance(); await memory.set('sentinel', { stable: true }, 'unrelated');
      map.set('governed-proof-inspect', createGovernedProofInspectProviderForFocusedTest(() => ({ answer: (request: GovernedProbeRunnerRequest) => { runnerCalls++; return fakeAnswer(request); }, cancel: () => {}, close: () => {} })));
      const oldArgv = process.argv; const oldExit = process.exit; const oldCwd = process.cwd(); const oldLog = console.log; const oldError = console.error; const exit = jest.fn();
      process.exit = exit as any; console.log = jest.fn(); console.error = jest.fn();
      try {
        process.chdir(PROJECT); process.argv = ['node', 'visor', '--config', CONFIG, '--check', 'discover', '--event', 'manual', '--disable-code-context', '--proof-bin', proof];
        const { main } = await import('../../src/cli-main'); await main(); expect(exit).toHaveBeenCalledWith(0); expect(runnerCalls).toBe(1); expect(memory.get('sentinel', 'unrelated')).toEqual({ stable: true }); expect([...((memory as any).data as Map<string, unknown>).keys()].filter(key => key.startsWith('visor-cli-'))).toEqual([]);
      } finally {
        process.argv = oldArgv; process.exit = oldExit; process.chdir(oldCwd); console.log = oldLog; console.error = oldError; map.clear(); for (const entry of original) map.set(entry[0], entry[1]); CheckProviderRegistry.clearInstance();
      }
    });
  });

  it('uses the frozen real Proof for C0 and admission through normal cli-main with a focused fake governed answer', async () => {
    const proof = process.env.VISOR_EXP0208_REAL_PROOF_BIN;
    if (!proof) { if (process.env.VISOR_EXP0208_EVIDENCE === 'required') throw new Error('VISOR_EXP0208_REAL_PROOF_BIN is required for evidence'); return; }
    const baseline = proofIdentity(proof); expect(baseline.sha256).toBe(REAL_PROOF_SHA); const fixtureBefore = fixtureInventory(PROJECT); const assertProofStable = () => expect(proofIdentity(proof)).toEqual(baseline);
    const [{ CheckProviderRegistry }, { StateMachineExecutionEngine }] = await Promise.all([import('../../src/providers/check-provider-registry'), import('../../src/state-machine-execution-engine')]);
    const registry = CheckProviderRegistry.getInstance(); const map = providerMap(registry); const original = [...map.entries()]; let runnerCalls = 0; let engine: any; let executeSpy: any;
    map.set('governed-proof-inspect', createGovernedProofInspectProviderForFocusedTest(() => ({ answer: (request: GovernedProbeRunnerRequest) => { runnerCalls++; assertProofStable(); return fakeAnswer(request); }, cancel: () => {}, close: () => {} })));
    const oldArgv = process.argv; const oldExit = process.exit; const oldCwd = process.cwd(); const oldLog = console.log; const oldError = console.error; const exit = jest.fn();
    process.exit = exit as any; console.log = jest.fn(); console.error = jest.fn();
    try {
      assertProofStable(); const realExecute = StateMachineExecutionEngine.prototype.executeGroupedChecks; executeSpy = jest.spyOn(StateMachineExecutionEngine.prototype, 'executeGroupedChecks').mockImplementation(async function(this: any, ...args: any[]) { engine = this; return (await realExecute.apply(this, args as any)); } as any);
      process.chdir(PROJECT); process.argv = ['node', 'visor', '--config', CONFIG, '--check', 'discover', '--event', 'manual', '--disable-code-context', '--proof-bin', resolve(proof)]; const { main } = await import('../../src/cli-main'); await main();
      assertProofStable(); expect(fixtureInventory(PROJECT)).toBe(fixtureBefore); expect(exit).toHaveBeenCalledWith(0); expect(runnerCalls).toBe(1);
      const journal = engine?._lastContext?.journal; expect(journal).toBeDefined(); const events = (journal.readRuntimeEvents() as any[]).filter(event => event.scope?.[0]?.key === 'A'); const candidate = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1'); const receipt = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1'); const verify = events.find(event => event.type === 'NodeGenerationActivated' && event.checkId === 'verify');
      expect(candidate).toHaveLength(1); expect(receipt).toHaveLength(1); expect([...verify.activeInputClaimIds].sort()).toEqual([candidate[0].claimId, receipt[0].claimId].sort()); expect(journal.getInstanceProjection()).toEqual(journal.replayInstanceProjection()); expect([...((await import('../../src/memory-store')).MemoryStore.getInstance() as any).data.keys()].filter((key: string) => key.startsWith('visor-cli-'))).toEqual([]);
    } finally { executeSpy?.mockRestore(); process.argv = oldArgv; process.exit = oldExit; process.chdir(oldCwd); console.log = oldLog; console.error = oldError; map.clear(); for (const entry of original) map.set(entry[0], entry[1]); CheckProviderRegistry.clearInstance(); }
  });

  it('proves candidate admission, exact verify inputs, replay, and C0 canonical projection', async () => {
    await withProtocolFixture(async proof => {
      const [{ ConfigManager }, child, { StateMachineExecutionEngine }] = await Promise.all([import('../../src/config'), import('../../src/providers/proof-admission-cli-child'), import('../../src/state-machine-execution-engine')]);
      const manager = new ConfigManager(); const config: any = await manager.loadConfig(CONFIG, { validate: false, mergeDefaults: true }); const c0 = await child.resolveProofRoleInvocation(child.createProofAdmissionCapability(proof), invocation(), PROJECT) as any;
      const inspect = config.subgraphs['one-component'].checks.inspect; inspect.message = GOVERNED_PROOF_INSPECT_MESSAGE; inspect.instructions = c0.instructions; inspect.invocation_digest = c0.invocation_digest; inspect.result_schema = Buffer.from(c0.output_schema, 'base64').toString(); manager.validateConfig(config);
      expect(Object.keys(c0)).toEqual(['version', 'role_id', 'role_source', 'stance', 'subject', 'authority', 'output_schema_id', 'output_schema', 'output_schema_digest', 'instructions', 'role_text_digest', 'invocation_digest']); expect(child.goCompatibleProofJson(c0)).toBe(child.goCompatibleProofJson(JSON.parse(child.goCompatibleProofJson(c0))));
      const { CheckProviderRegistry } = await import('../../src/providers/check-provider-registry'); const registry = CheckProviderRegistry.getInstance(); const map = providerMap(registry); const original = [...map.entries()]; map.set('governed-proof-inspect', createGovernedProofInspectProviderForFocusedTest(() => ({ answer: fakeAnswer, cancel: () => {}, close: () => {} }))); registry.bootstrapProofAdmission(child.createProofAdmissionCapability(proof));
      try {
        const engine = new StateMachineExecutionEngine(PROJECT); const result = await engine.executeGroupedChecks(prInfo, ['discover'], undefined, config, 'json', false, 1); const journal = (engine as any)._lastContext.journal; const events = (journal.readRuntimeEvents() as any[]).filter(event => event.scope?.[0]?.key === 'A'); const candidate = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1'); const receipt = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1'); const verify = events.find(event => event.type === 'NodeGenerationActivated' && event.checkId === 'verify');
        expect(result.statistics.failedExecutions).toBe(0); expect(candidate).toHaveLength(1); expect(receipt).toHaveLength(1); expect(events.filter(event => event.type === 'NodeGenerationActivated').map(event => event.checkId)).toEqual(['inspect', 'proof_admit', 'verify']); expect([...verify.activeInputClaimIds].sort()).toEqual([candidate[0].claimId, receipt[0].claimId].sort()); expect(journal.getInstanceProjection()).toEqual(journal.replayInstanceProjection());
      } finally { map.clear(); for (const entry of original) map.set(entry[0], entry[1]); CheckProviderRegistry.clearInstance(); }
    });
  });

  it('bounds C0 malformed, stale, nonzero, hung, and oversized responses', async () => {
    const child = await import('../../src/providers/proof-admission-cli-child');
    for (const mode of ['malformed', 'changed-subject', 'nonzero', 'cap']) await withProtocolFixture(async proof => {
      await expect(child.resolveProofRoleInvocation(child.createProofAdmissionCapability(proof), invocation(), PROJECT)).rejects.toThrow(child.PROOF_ADMISSION_UNAVAILABLE);
    }, mode);
    await withProtocolFixture(async (proof, pidFile) => {
      await expect(child.resolveProofRoleInvocation(child.createProofAdmissionCapability(proof), invocation(), PROJECT)).rejects.toThrow(child.PROOF_ADMISSION_UNAVAILABLE);
      const pid = Number(readFileSync(pidFile!, 'utf8')); try { process.kill(-pid, 0); throw new Error('surviving Proof process group'); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); }
    }, 'hung');
    await withProtocolFixture(async (proof, pidFile, markers) => {
      const observed = recordSignals();
      try {
        const pending = child.resolveProofRoleInvocation(child.createProofAdmissionCapability(proof), invocation(), PROJECT);
        await expect(waitForMarker(markers!.ready)).resolves.toBeDefined();
        await expect(pending).rejects.toThrow(child.PROOF_ADMISSION_UNAVAILABLE);
        await expect(waitForMarker(markers!.term)).resolves.toBeDefined();
      } finally { observed.restore(); }
      const pid = Number(readFileSync(pidFile!, 'utf8')); expect(observed.signals.map(signal => signal.signal)).toEqual(['SIGTERM', 'SIGKILL']); expect(observed.signals[1].at - observed.signals[0].at).toBeGreaterThanOrEqual(250);
      try { process.kill(-pid, 0); throw new Error('surviving parent-exit Proof group'); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); }
    }, 'parent-exits-c0');
    await withProtocolFixture(async proof => {
      const missing = { ...invocation() } as any; delete missing.output_schema;
      await expect(child.resolveProofRoleInvocation(child.createProofAdmissionCapability(proof), missing, PROJECT)).rejects.toThrow(child.PROOF_ADMISSION_UNAVAILABLE);
    }, 'success');
    await withProtocolFixture(async proof => {
      const capability = child.createProofAdmissionCapability(proof); writeFileSync(proof, '#!/bin/sh\nexit 0\n', 'utf8'); chmodSync(proof, 0o755);
      await expect(child.resolveProofRoleInvocation(capability, invocation(), PROJECT)).rejects.toThrow(child.PROOF_ADMISSION_UNAVAILABLE);
    }, 'success');
    await withProtocolFixture(async (proof, pidFile) => {
      writeFileSync(proof, '#!/visor-exp-0208-missing-interpreter\n', 'utf8'); chmodSync(proof, 0o755);
      const capability = child.createProofAdmissionCapability(proof); const handles = new Set((process as any)._getActiveHandles?.() || []); const timers = new Set<any>(); const nativeSetTimeout = global.setTimeout; const nativeClearTimeout = global.clearTimeout;
      global.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => { const handle: any = nativeSetTimeout(() => { timers.delete(handle); callback(...args); }, delay); timers.add(handle); return handle; }) as any;
      global.clearTimeout = ((handle: any) => { timers.delete(handle); return nativeClearTimeout(handle); }) as any;
      const started = Date.now();
      try { await expect(child.resolveProofRoleInvocation(capability, invocation(), PROJECT)).rejects.toThrow(child.PROOF_ADMISSION_UNAVAILABLE); } finally { global.setTimeout = nativeSetTimeout; global.clearTimeout = nativeClearTimeout; }
      await waitForNoExtraHandles(handles); const after = new Set((process as any)._getActiveHandles?.() || []); expect(Date.now() - started).toBeLessThan(250); expect(existsSync(pidFile!)).toBe(false); expect(timers.size).toBe(0); expect([...after].filter(handle => !handles.has(handle))).toHaveLength(0);
    }, 'success');
  });

  it('does not activate verify when Proof rejects the candidate', async () => {
    await withProtocolFixture(async proof => {
      const [{ ConfigManager }, child, { StateMachineExecutionEngine }, { CheckProviderRegistry }] = await Promise.all([import('../../src/config'), import('../../src/providers/proof-admission-cli-child'), import('../../src/state-machine-execution-engine'), import('../../src/providers/check-provider-registry')]);
      const manager = new ConfigManager(); const config: any = await manager.loadConfig(CONFIG, { validate: false, mergeDefaults: true }); const c0 = await child.resolveProofRoleInvocation(child.createProofAdmissionCapability(proof), invocation(), PROJECT) as any; const inspect = config.subgraphs['one-component'].checks.inspect;
      inspect.message = GOVERNED_PROOF_INSPECT_MESSAGE; inspect.instructions = c0.instructions; inspect.invocation_digest = c0.invocation_digest; inspect.result_schema = Buffer.from(c0.output_schema, 'base64').toString(); manager.validateConfig(config);
      const registry = CheckProviderRegistry.getInstance(); const map = providerMap(registry); const original = [...map.entries()]; map.set('governed-proof-inspect', createGovernedProofInspectProviderForFocusedTest(() => ({ answer: fakeAnswer, cancel: () => {}, close: () => {} }))); registry.bootstrapProofAdmission(child.createProofAdmissionCapability(proof));
      try { const engine = new StateMachineExecutionEngine(PROJECT); const result = await engine.executeGroupedChecks(prInfo, ['discover'], undefined, config, 'json', false, 1); const events = ((engine as any)._lastContext.journal.readRuntimeEvents() as any[]).filter(event => event.scope?.[0]?.key === 'A'); expect(result.statistics.failedExecutions).toBeGreaterThan(0); expect(events.some(event => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1')).toBe(false); expect(events.some(event => event.type === 'NodeGenerationActivated' && event.checkId === 'verify')).toBe(false); } finally { map.clear(); for (const entry of original) map.set(entry[0], entry[1]); CheckProviderRegistry.clearInstance(); }
    }, 'reject');
  });

  it('fails closed when owned namespace cleanup fails', async () => {
    await withProtocolFixture(async proof => {
      const [{ MemoryStore }, { CheckProviderRegistry }] = await Promise.all([import('../../src/memory-store'), import('../../src/providers/check-provider-registry')]); const registry = CheckProviderRegistry.getInstance(); const map = providerMap(registry); const original = [...map.entries()];
      map.set('governed-proof-inspect', createGovernedProofInspectProviderForFocusedTest(() => ({ answer: fakeAnswer, cancel: () => {}, close: () => {} })));
      const oldArgv = process.argv; const oldExit = process.exit; const oldCwd = process.cwd(); const oldLog = console.log; const oldError = console.error; const exit = jest.fn(); const memory = MemoryStore.getInstance(); await memory.set('sentinel', { stable: true }, 'cleanup-unrelated'); const dataSnapshot = (without?: string) => JSON.stringify([...((memory as any).data as Map<string, Map<string, unknown>>)].filter(([namespace]) => namespace !== without).map(([namespace, values]) => [namespace, [...values]])); const unrelatedBefore = dataSnapshot(); const clearCalls: Array<string | undefined> = []; let failedOwnedData: Record<string, unknown> | undefined; let failedUnrelated: string | undefined; const realClear = memory.clear.bind(memory); const clear = jest.spyOn(memory, 'clear').mockImplementation(async (namespace?: string) => { clearCalls.push(namespace); if (clearCalls.length === 1) { failedOwnedData = namespace ? memory.getAll(namespace) : undefined; failedUnrelated = dataSnapshot(namespace); throw new Error('cleanup sentinel'); } await realClear(namespace); });
      process.exit = exit as any; console.log = jest.fn(); console.error = jest.fn();
      try { process.chdir(PROJECT); process.argv = ['node', 'visor', '--config', CONFIG, '--check', 'discover', '--event', 'manual', '--disable-code-context', '--proof-bin', proof]; const { main } = await import('../../src/cli-main'); await main(); expect(exit).toHaveBeenCalledWith(1); expect(clearCalls).toHaveLength(2); expect(clearCalls[0]).toMatch(/^visor-cli-/); expect(clearCalls[1]).toBe(clearCalls[0]); expect(failedOwnedData).toBeDefined(); expect(Object.keys(failedOwnedData!)).not.toHaveLength(0); expect(failedUnrelated).toBe(unrelatedBefore); expect(memory.list(clearCalls[0])).toEqual([]); expect(dataSnapshot(clearCalls[0])).toBe(unrelatedBefore); } finally { clear.mockRestore(); process.argv = oldArgv; process.exit = oldExit; process.chdir(oldCwd); console.log = oldLog; console.error = oldError; map.clear(); for (const entry of original) map.set(entry[0], entry[1]); CheckProviderRegistry.clearInstance(); }
    });
  });

  it('rejects missing, relative, and duplicate Proof paths before execution', () => {
    const { CLI } = require('../../src/cli') as typeof import('../../src/cli'); const cli = new CLI(); expect(() => cli.parseArgs(['node', 'visor', '--proof-bin'])).toThrow(); expect(() => cli.parseArgs(['node', 'visor', '--proof-bin', 'proof'])).toThrow('absolute'); expect(() => cli.parseArgs(['node', 'visor', '--proof-bin', '/a', '--proof-bin=/b'])).toThrow('only once');
  });

  it('accepts one opaque capability without disturbing registry order, and rejects late/repeated bootstrap', async () => {
    const child = await import('../../src/providers/proof-admission-cli-child'); const { CheckProviderRegistry } = await import('../../src/providers/check-provider-registry');
    await withProtocolFixture(async proof => {
      const registry = CheckProviderRegistry.getInstance(); const map = providerMap(registry); const keys = [...map.keys()]; const unrelated = map.get('noop'); const capability = child.createProofAdmissionCapability(proof);
      expect(() => registry.bootstrapProofAdmission({})).toThrow('capability'); registry.bootstrapProofAdmission(capability); expect([...map.keys()]).toEqual(keys); expect(map.get('noop')).toBe(unrelated); expect(() => registry.bootstrapProofAdmission(capability)).toThrow('already');
      CheckProviderRegistry.clearInstance(); const late = CheckProviderRegistry.getInstance(); late.getProvider('proof-admit'); expect(() => late.bootstrapProofAdmission(capability)).toThrow('precede'); CheckProviderRegistry.clearInstance();
    });
  });

  it('rejects governed local inheritance after normalization and remote roots before fetch', async () => {
    const directory = mkdtempSync(join(PROJECT, '.exp-0208-no-proof-')); const parent = join(directory, 'parent.yaml'); const child = join(directory, 'child.yaml');
    writeFileSync(parent, 'version: "1.0"\nchecks:\n  inherited:\n    type: governed-proof-inspect\n', 'utf8'); writeFileSync(child, 'version: "1.0"\nextends: parent.yaml\n', 'utf8');
    const oldArgv = process.argv; const oldExit = process.exit; const oldCwd = process.cwd(); const oldLog = console.log; const oldError = console.error; const exit = jest.fn(); process.exit = exit as any; console.log = jest.fn(); console.error = jest.fn();
    try { process.chdir(PROJECT); process.argv = ['node', 'visor', '--config', child]; const { main } = await import('../../src/cli-main'); await main(); expect(exit).toHaveBeenCalledWith(1); } finally { process.argv = oldArgv; process.exit = oldExit; process.chdir(oldCwd); console.log = oldLog; console.error = oldError; rmSync(directory, { recursive: true, force: true }); }
    const remoteConfig = join(PROJECT, '.exp-0208-remote.yaml'); writeFileSync(remoteConfig, 'version: "1.0"\nextends: https://127.0.0.1:9/never-fetch.yaml\nchecks:\n  local:\n    type: governed-proof-inspect\n', 'utf8'); const oldFetch = global.fetch; const fetch = jest.fn(); global.fetch = fetch as any;
    try { process.exit = exit as any; console.log = jest.fn(); console.error = jest.fn(); process.argv = ['node', 'visor', '--config', remoteConfig]; const { main } = await import('../../src/cli-main'); await main(); expect(exit).toHaveBeenCalledWith(1); expect(fetch).not.toHaveBeenCalled(); } finally { global.fetch = oldFetch; rmSync(remoteConfig, { force: true }); process.argv = oldArgv; process.exit = oldExit; console.log = oldLog; console.error = oldError; }
  });

  it('marks provider enumeration as a Proof bootstrap access boundary', async () => {
    const child = await import('../../src/providers/proof-admission-cli-child'); const { CheckProviderRegistry } = await import('../../src/providers/check-provider-registry');
    await withProtocolFixture(async proof => { const registry = CheckProviderRegistry.getInstance(); registry.getAllProviders(); expect(() => registry.bootstrapProofAdmission(child.createProofAdmissionCapability(proof))).toThrow('precede'); CheckProviderRegistry.clearInstance(); });
  });

  it('cleans a parent-exit descendant with TERM, grace, KILL, and ESRCH', async () => {
    await withProtocolFixture(async (proof, pidFile, markers) => {
      const [{ ConfigManager }, child, { StateMachineExecutionEngine }, { CheckProviderRegistry }] = await Promise.all([import('../../src/config'), import('../../src/providers/proof-admission-cli-child'), import('../../src/state-machine-execution-engine'), import('../../src/providers/check-provider-registry')]);
      const manager = new ConfigManager(); const config: any = await manager.loadConfig(CONFIG, { validate: false, mergeDefaults: true }); const c0 = await child.resolveProofRoleInvocation(child.createProofAdmissionCapability(proof), invocation(), PROJECT) as any; const inspect = config.subgraphs['one-component'].checks.inspect;
      inspect.message = GOVERNED_PROOF_INSPECT_MESSAGE; inspect.instructions = c0.instructions; inspect.invocation_digest = c0.invocation_digest; inspect.result_schema = Buffer.from(c0.output_schema, 'base64').toString(); manager.validateConfig(config);
      const registry = CheckProviderRegistry.getInstance(); const map = providerMap(registry); const original = [...map.entries()]; map.set('governed-proof-inspect', createGovernedProofInspectProviderForFocusedTest(() => ({ answer: fakeAnswer, cancel: () => {}, close: () => {} }))); registry.bootstrapProofAdmission(child.createProofAdmissionCapability(proof));
      const observed = recordSignals();
      try { const engine = new StateMachineExecutionEngine(PROJECT); const running = engine.executeGroupedChecks(prInfo, ['discover'], undefined, config, 'json', false, 1); await expect(waitForMarker(markers!.ready)).resolves.toBeDefined(); const result = await running; await expect(waitForMarker(markers!.term)).resolves.toBeDefined(); expect(result.statistics.failedExecutions).toBeGreaterThan(0); const pid = Number(readFileSync(pidFile!, 'utf8')); expect(observed.signals.map(signal => signal.signal)).toEqual(['SIGTERM', 'SIGKILL']); expect(observed.signals[1].at - observed.signals[0].at).toBeGreaterThanOrEqual(250); try { process.kill(-pid, 0); throw new Error('surviving Proof process group'); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); } } finally { observed.restore(); map.clear(); for (const entry of original) map.set(entry[0], entry[1]); CheckProviderRegistry.clearInstance(); }
    }, 'parent-exits-descendant');
  });
});
