jest.unmock('child_process');
jest.mock('@probelabs/probe', () => jest.requireActual('/Users/buger/go/src/visor-exp-0207b0a-proof-evidence-substrate/node_modules/@probelabs/probe/cjs/index.cjs'));

import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { CheckProvider, type CheckProviderConfig, type ExecutionContext, type ManagedAgentRun, type ManagedRunStartRequest } from '../../src/providers/check-provider.interface';
import type { ManagedRunBindingV1 } from '../../src/state-machine/graph/instance-kernel';
import type { PRInfo } from '../../src/pr-analyzer';
import type { ReviewSummary } from '../../src/reviewer';
import type { VisorConfig } from '../../src/types/config';
import { createGovernedProofInspectProviderForFocusedTest, GOVERNED_PROOF_INSPECT_MESSAGE } from '../../src/providers/governed-proof-inspect-check-provider';
import { createProofAdmitProviderForFocusedTest } from '../../src/providers/proof-admit-check-provider';
import { goCompatibleProofJson } from '../../src/providers/proof-admission-cli-child';
import { sha256Canonical } from '../../src/state-machine/graph/claim-kernel';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import { ExecutionJournal } from '../../src/snapshot-store';

const PROOF = '/tmp/exp0207b-proof-plain-retry/proof-db183bff';
const PROOF_SHA = '43a0cbc36b0bdf640bc4c712fa00b180208b395bac34a6ee2957528cd43f8272';
const PROBE = '/Users/buger/.probe/bin/probe-binary';
const PROBE_SHA = 'cc787b88ea2a08806dafd14107e310c28d89efc419b1a75a19f982303d976b87';
const PROBE_NODE_MODULES = '/Users/buger/go/src/visor-exp-0207b0a-proof-evidence-substrate/node_modules';
const PROBE_CJS = `${PROBE_NODE_MODULES}/@probelabs/probe/cjs/index.cjs`;
const PROBE_PACKAGE = `${PROBE_NODE_MODULES}/@probelabs/probe/package.json`;
const PROBE_CJS_SHA = '918e666e6cf008abfcd43f78525c8109578230b2827f232f1baa62f1eb9a9f50';
const PROBE_CJS_SIZE = 7162542;
const CODEX = '/opt/homebrew/Caskroom/codex/0.150.1/bin/codex';
const CODEX_SHA = 'a14f9a907c12c8812878b70e6b7d65f81c39ed795513e46a55817d7428c0ca6b';
const CODEX_SIZE = 228986048;
const C0_KEYS = ['version', 'role_id', 'role_source', 'stance', 'subject', 'authority', 'output_schema_id', 'output_schema', 'output_schema_digest', 'instructions', 'role_text_digest', 'invocation_digest'];
const LIVE = process.env.VISOR_EXP_0207B0B_LIVE_A === '1';
const prInfo = { number: 1, title: 'one live A', author: 'test', base: 'main', head: 'candidate', files: [], totalAdditions: 0, totalDeletions: 0, eventType: 'manual' } as PRInfo;

function fixture(): { root: string; requirement: string; fingerprint: string; schema: string } {
  const root = mkdtempSync(join(tmpdir(), 'visor-exp-0207b0b-live-a-'));
  try {
    mkdirSync(join(root, 'specs/system/requirements'), { recursive: true }); mkdirSync(join(root, '.proof'), { recursive: true });
    writeFileSync(join(root, 'proof.yaml'), 'project:\n  name: visor-native-live-a\n  version: 1.0.0\n  specs:\n    - path: specs/system\n      prefix: SYS-REQ\n      type: system\n');
    const fretish = 'the component shall satisfy component_ready'; const requirement = join(root, 'specs/system/requirements/SYS-REQ-001.req.yaml');
    writeFileSync(requirement, `id: SYS-REQ-001\nversion: 1\nstatus: draft\npriority: shall\ncategory: functional\nreq_type: guarantee\nfretish: "${fretish}"\ndescription: ""\nformalization_strategy: fretish\ninformal_verification:\n  method: ""\n  evidence: ""\n  verified: false\ncomponent: component_a\nrationale: ""\ntags: []\nvariables: []\ntraces: {}\nverification:\n  assurance_level: E\n  formalization_status: none\n  realizability: unchecked\n  vacuity_status: unchecked\n  vacuity_checked: false\n  review:\n    status: pending\n    ai_generated: false\nhistory:\n  created_by: human:test\n  created_at: "2026-08-31T00:00:00Z"\n`);
    const semantic = { id: 'SYS-REQ-001', component: 'component_a', req_type: 'guarantee', formalization_strategy: 'fretish', fretish, interface: {}, assumption: {} }; const fingerprint = `sha256:${createHash('sha256').update(JSON.stringify(semantic)).digest('hex')}`;
    const schema = JSON.stringify({ type: 'object', additionalProperties: false, required: ['decision'], properties: { decision: { type: 'string', enum: ['accept'] } } }); return { root, requirement, fingerprint, schema };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

function fileIdentity(path: string, sha: string, size: number): string {
  const real = realpathSync(path); const st = statSync(real); if (!st.isFile() || st.size !== size || createHash('sha256').update(readFileSync(real)).digest('hex') !== sha) throw new Error(`identity mismatch: ${path}`); return real;
}
function identity(path: string, sha: string, size: number): string {
  const real = fileIdentity(path, sha, size); const st = statSync(real); if ((st.mode & 0o111) === 0) throw new Error(`identity not executable: ${path}`); return real;
}
function acceptedProof(): string { if (process.env.VISOR_PROOF_ADMISSION_BIN !== PROOF) throw new Error('exact Proof env required'); return identity(PROOF, PROOF_SHA, 86738098); }
function acceptedProbe(): string { if (process.env.PROBE_PATH !== PROBE) throw new Error('exact Probe env required'); return identity(PROBE, PROBE_SHA, 55524720); }
function acceptedCodex(): string {
  const real = identity(CODEX, CODEX_SHA, CODEX_SIZE); const version = spawnSync(real, ['--version'], { env: { PATH: '/usr/bin:/bin', HOME: '/tmp' }, encoding: 'utf8', timeout: 10000 });
  if (version.status !== 0 || !/0\.150\.1/.test(version.stdout)) throw new Error('Codex version mismatch'); return real;
}
function realProbeBinding(): { agent: { prototype: object }; restore: () => void } {
  if (process.env.NODE_PATH !== PROBE_NODE_MODULES) throw new Error('exact NODE_PATH is required'); const cjsPath = fileIdentity(PROBE_CJS, PROBE_CJS_SHA, PROBE_CJS_SIZE); if (cjsPath !== realpathSync(PROBE_CJS)) throw new Error('Probe CJS realpath drift'); const pkg = JSON.parse(readFileSync(PROBE_PACKAGE, 'utf8')); if (pkg.version !== '0.6.0-rc332') throw new Error('Probe package version mismatch'); const cjs = require(cjsPath) as { ProbeAgent: { prototype: object } }; const independent = jest.requireActual(cjsPath) as { ProbeAgent: { prototype: object } }; const bare = require('@probelabs/probe') as { ProbeAgent: { prototype: object } };
  if (independent !== cjs || independent.ProbeAgent !== cjs.ProbeAgent || bare.ProbeAgent !== cjs.ProbeAgent) throw new Error('Probe bare/CJS identity is not exact');
  return { agent: cjs.ProbeAgent, restore: () => {} };
}

type Patch = { target: object; key: string; descriptor: PropertyDescriptor };
function sentinels(agent: { prototype: object }, allowedSpawn = new Set<string>(), allowLoopback = false, guardProbeMethods = true): { counts: Record<string, number>; restore: () => void } {
  const counts: Record<string, number> = {}; const patches: Patch[] = []; let restored = false; const localOnly = (...args: unknown[]) => allowLoopback && /(?:localhost|127\.0\.0\.1|::1)/.test(args.map(String).join(' ')); const patch = (target: object, key: string, label: string, allow?: (...args: unknown[]) => boolean) => { const descriptor = Object.getOwnPropertyDescriptor(target, key); if (!descriptor || typeof descriptor.value !== 'function') throw new Error(`missing boundary ${label}`); counts[label] = 0; Object.defineProperty(target, key, { ...descriptor, value: function (...args: unknown[]) { if (allow?.(...args)) return Reflect.apply(descriptor.value as Function, this, args); counts[label]++; throw new Error('PHASE_I_FORBIDDEN_NATIVE_BOUNDARY'); } }); patches.push({ target, key, descriptor }); };
  const restore = () => { if (restored) return; restored = true; let first: unknown; for (const p of patches.reverse()) { try { Object.defineProperty(p.target, p.key, p.descriptor); } catch (error) { first ||= error; } } if (first) throw first; };
  try {
    if (guardProbeMethods) for (const key of ['initialize', 'answerGoverned', 'close']) patch(agent.prototype, key, `Probe.${key}`); patch(require('child_process'), 'spawn', 'child_process.spawn', command => allowedSpawn.has(String(command)) || allowedSpawn.has('codex') && String(command) === 'codex'); patch(globalThis as any, 'fetch', 'global.fetch', localOnly);
    for (const name of ['node:http', 'node:https']) { const mod = require(name); patch(mod, 'request', `${name}.request`, localOnly); patch(mod, 'get', `${name}.get`, localOnly); } const net = require('node:net'); patch(net, 'connect', 'node:net.connect', localOnly); patch(net, 'createConnection', 'node:net.createConnection', localOnly); patch(net.Socket.prototype, 'connect', 'net.Socket.connect', localOnly); patch(require('node:tls'), 'connect', 'node:tls.connect', localOnly);
    const dns = require('node:dns'); patch(dns, 'lookup', 'node:dns.lookup', localOnly); patch(dns, 'resolve', 'node:dns.resolve', localOnly); const dp = require('node:dns/promises'); patch(dp, 'lookup', 'node:dns.promises.lookup', localOnly); patch(dp, 'resolve', 'node:dns.promises.resolve', localOnly);
  } catch (error) { restore(); throw error; } return { counts, restore };
}
function c0(binary: string, f: ReturnType<typeof fixture>): Record<string, any> {
  const request = { role_id: 'spec-review', stance: 'owner', subject: { kind: 'requirement', id: 'SYS-REQ-001', fingerprint: f.fingerprint }, output_schema_id: 'proof.findings/v1', output_schema: Buffer.from(f.schema).toString('base64') }; const r = spawnSync(binary, ['resolve-role-invocation'], { cwd: f.root, input: JSON.stringify(request), env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' }, encoding: 'utf8', timeout: 120000, maxBuffer: 8388608 });
  if (r.status !== 0 || r.signal || r.error || r.stderr !== '' || !r.stdout.endsWith('\n') || r.stdout.slice(0, -1).includes('\n') || r.stdout.includes('\r')) throw new Error(`C0 failed: ${r.stderr}`); const output = r.stdout.slice(0, -1); const value = JSON.parse(output) as Record<string, any>; if (JSON.stringify(Object.keys(value)) !== JSON.stringify(C0_KEYS) || goCompatibleProofJson(value) !== output) throw new Error('C0 is not canonical ordered 12-field JSON'); return value;
}

function managed(request: ManagedRunStartRequest, summary: ReviewSummary, failed = false): ManagedAgentRun {
  const b = request.binding; return { binding: b, started: Promise.resolve({ version: 1, kind: 'started', binding: b }), outcome: Promise.resolve(failed ? { version: 1, kind: 'failed', binding: b } : { version: 1, kind: 'succeeded', binding: b, summary }), cancel: async () => ({ version: 1, kind: 'cancelled', binding: b, reason: 'deadline' }), close: async () => ({ version: 1, kind: 'cleanup', binding: b, status: 'clean', activeChildren: 0, activeResources: 0 }) };
}
class LocalCatalog extends CheckProvider {
  getName() { return 'exp-0207b0b-catalog'; } getDescription() { return 'local one-item catalog observer'; } async validateConfig() { return true; } async isAvailable() { return true; } getRequirements() { return []; } getSupportedConfigKeys() { return ['type']; }
  async execute() { return { issues: [], output: { components: [{ id: 'A', path: 'a' }] } }; }
  startManaged(request: ManagedRunStartRequest) { return managed(request, { issues: [], output: { components: [{ id: 'A', path: 'a' }] } }); }
}
class LocalVerify extends CheckProvider {
  readonly claims: Array<Readonly<Record<string, unknown>>> = []; getName() { return 'exp-0207b0b-verify'; } getDescription() { return 'local verify observer'; } async validateConfig() { return true; } async isAvailable() { return true; } getRequirements() { return []; } getSupportedConfigKeys() { return ['type']; }
  async execute(_pr: PRInfo, _config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, context?: ExecutionContext) { this.claims.push(context?.claims || {}); return { issues: [], output: { verified: true } }; }
}
function config(c0Value: Record<string, any>, includeRuntimeAi = false): VisorConfig {
  const strict = { type: 'object', additionalProperties: false, required: ['decision'], properties: { decision: { type: 'string', enum: ['accept'] } } }; const item = { type: 'object', additionalProperties: false, required: ['id', 'path'], properties: { id: { type: 'string' }, path: { type: 'string' } } };
  const inspect = { type: 'governed-proof-inspect', message: GOVERNED_PROOF_INSPECT_MESSAGE, instructions: c0Value.instructions, invocation: { role_id: c0Value.role_id, stance: c0Value.stance, subject: c0Value.subject, output_schema_id: c0Value.output_schema_id, output_schema: c0Value.output_schema }, invocation_digest: c0Value.invocation_digest, result_schema: Buffer.from(c0Value.output_schema, 'base64').toString(), profile: 'luna-xhigh-readonly-v1', ...(includeRuntimeAi ? { ai: { timeout: 600000 } } : {}), consumes: [{ claim: 'component.item@1', as: 'component' }], emits: [{ claim: 'proof.candidate@1', from: 'output' }] };
  return { version: '1.0', max_parallelism: 1, workspace: { enabled: false }, claim_types: { 'component.catalog@1': { schema: { type: 'object', additionalProperties: false, required: ['components'], properties: { components: { type: 'array', items: item } } } }, 'component.item@1': { schema: item }, 'proof.candidate@1': { schema: strict }, 'proof.admitted_receipt@1': { schema: { type: 'object' } } }, checks: { discover: { type: 'exp-0207b0b-catalog', emits: [{ claim: 'component.catalog@1', from: 'output' }], expand: { claim: 'component.catalog@1', template: 'one-component', items_pointer: '/components', key_pointer: '/id', item_claim: 'component.item@1' } } }, subgraphs: { 'one-component': { input: { name: 'component', claim: 'component.item@1' }, checks: { inspect, proof_admit: { type: 'proof-admit', consumes: [{ claim: 'proof.candidate@1', as: 'candidate' }], emits: [{ claim: 'proof.admitted_receipt@1', from: 'output' }] }, verify: { type: 'exp-0207b0b-verify', consumes: [{ claim: 'proof.candidate@1', as: 'candidate' }, { claim: 'proof.admitted_receipt@1', as: 'receipt' }] } } } } } as VisorConfig;
}
function observe(plan: ReturnType<typeof compileClaimPlan>) { return [...plan.expansionPlan.byOwner.discover.template.templateNodeKeys]; }

describe('EXP-0207B0b one-live-A two-gated engine path', () => {
  const phaseI = LIVE ? it.skip : it;
  const phaseII = LIVE ? it : it.skip;
  phaseI('runs only zero-model P0 preload and restores exact touched state', async () => {
    let f: ReturnType<typeof fixture> | undefined; let binding: ReturnType<typeof realProbeBinding> | undefined; let guards: ReturnType<typeof sentinels> | undefined; let originalBytes: Buffer | undefined; let originalMode: number | undefined; let map: Map<string, CheckProvider> | undefined; let originalEntries: [string, CheckProvider][] | undefined; let originalInspect: CheckProvider | undefined;
    try {
      acceptedProbe(); acceptedCodex(); f = fixture(); originalBytes = readFileSync(f.requirement); originalMode = lstatSync(f.requirement).mode; binding = realProbeBinding(); guards = sentinels(binding.agent); const authority = c0(acceptedProof(), f); const cfg = config(authority, true); const plan = compileClaimPlan(cfg);
      expect((cfg.subgraphs!['one-component'].checks!.inspect as any).ai).toEqual({ timeout: 600000 }); expect(observe(plan)).toEqual(['inspect', 'proof_admit', 'verify']); expect(plan.expansionPlan.byOwner.discover.template.templateNodeKeys).toHaveLength(3); expect(authority.subject.fingerprint).toBe(f.fingerprint);
      const registry = CheckProviderRegistry.getInstance(); const desc = Object.getOwnPropertyDescriptor(registry as any, 'providers')!; map = desc.value as Map<string, CheckProvider>; originalEntries = [...map.entries()]; originalInspect = map.get('governed-proof-inspect'); expect(registry.getProvider('governed-proof-inspect')).toBe(originalInspect); expect([...map.keys()]).toEqual(originalEntries.map(([key]) => key));
      const lifecycle = { answers: 0, cancels: 0, closes: 0 }; const focusedInspect = createGovernedProofInspectProviderForFocusedTest(() => ({ answer: () => { lifecycle.answers++; return new Promise<never>(() => {}); }, cancel: () => { lifecycle.cancels++; }, close: () => { lifecycle.closes++; } })); map.set('exp-0207b0b-catalog', new LocalCatalog()); map.set('governed-proof-inspect', focusedInspect); jest.useFakeTimers();
      try {
        const timeoutEngine = new StateMachineExecutionEngine(f.root); const run = timeoutEngine.executeGroupedChecks(prInfo, ['discover'], undefined, cfg, 'table', false, 1);
        for (let i = 0; i < 100 && lifecycle.answers === 0; i++) await Promise.resolve();
        expect(lifecycle.answers).toBe(1); await jest.advanceTimersByTimeAsync(599999); expect(lifecycle.cancels).toBe(0); expect(lifecycle.closes).toBe(0); await jest.advanceTimersByTimeAsync(1); const timeoutResult = await run;
        expect(lifecycle.cancels).toBe(1); expect(lifecycle.closes).toBe(1); expect(timeoutResult.statistics.failedExecutions).toBe(1);
      } finally { jest.useRealTimers(); }
      for (const key of ['Probe.initialize', 'Probe.answerGoverned', 'Probe.close', 'child_process.spawn', 'global.fetch', 'node:http.request', 'node:http.get', 'node:https.request', 'node:https.get', 'node:net.connect', 'node:net.createConnection', 'net.Socket.connect', 'node:tls.connect', 'node:dns.lookup', 'node:dns.resolve', 'node:dns.promises.lookup', 'node:dns.promises.resolve']) expect(guards.counts[key]).toBe(0); expect(readFileSync(f.requirement)).toEqual(originalBytes); expect(lstatSync(f.requirement).mode).toBe(originalMode);
    } finally {
      const errors: unknown[] = []; const clean = (fn: () => void) => { try { fn(); } catch (error) { errors.push(error); } }; clean(() => { if (map && originalEntries) { map.clear(); for (const entry of originalEntries) map.set(entry[0], entry[1]); } }); clean(() => { if (map && originalEntries) { expect(map.get('governed-proof-inspect')).toBe(originalInspect); expect([...map.keys()]).toEqual(originalEntries.map(([key]) => key)); } }); clean(() => guards?.restore()); clean(() => binding?.restore()); clean(() => { if (f && originalBytes) writeFileSync(f.requirement, originalBytes); }); clean(() => { if (f && originalMode !== undefined) expect(lstatSync(f.requirement).mode).toBe(originalMode); }); clean(() => { if (f) rmSync(f.root, { recursive: true, force: true }); }); clean(() => { if (f) expect(existsSync(f.root)).toBe(false); }); if (errors[0]) throw errors[0];
    }
  });

  phaseII('executes one real A and proves candidate, receipt, verify, replay, and checkpoint invariants', async () => {
    let f: ReturnType<typeof fixture> | undefined; let originalBytes: Buffer | undefined; let originalStat: ReturnType<typeof lstatSync> | undefined; let binding: ReturnType<typeof realProbeBinding> | undefined; let registry: CheckProviderRegistry | undefined; let map: Map<string, CheckProvider> | undefined; let originalEntries: [string, CheckProvider][] | undefined; let inspect: CheckProvider | undefined; let verify: LocalVerify | undefined; let catalog: LocalCatalog | undefined; let wrapperRestore = () => {}; let phaseIIGuards: ReturnType<typeof sentinels> | undefined; let previousPath: string | undefined; let pathCaptured = false; let admission: CheckProvider | undefined;
    try {
      const exactProbe = acceptedProbe(); const exactProof = acceptedProof(); const exactCodex = acceptedCodex(); const currentFixture = f = fixture(); originalBytes = readFileSync(currentFixture.requirement); originalStat = lstatSync(currentFixture.requirement); const currentBinding = binding = realProbeBinding(); previousPath = process.env.PATH; pathCaptured = true; process.env.PATH = `${dirname(exactCodex)}:/usr/bin:/bin`; if (realpathSync(join(dirname(exactCodex), 'codex')) !== exactCodex) throw new Error('bare Codex realpath mismatch'); const bareVersion = spawnSync('codex', ['--version'], { env: { PATH: process.env.PATH, HOME: '/tmp' }, encoding: 'utf8', timeout: 10000 }); if (bareVersion.status !== 0 || !/0\.150\.1/.test(bareVersion.stdout)) throw new Error('bare Codex version mismatch'); phaseIIGuards = sentinels(currentBinding.agent, new Set([exactProbe, exactProof, exactCodex, 'codex']), true, false); const productProbe = require('@probelabs/probe') as { ProbeAgent: object }; if (productProbe.ProbeAgent !== currentBinding.agent) throw new Error('Phase II requires product-bound exact rc332 CJS ProbeAgent'); const currentRegistry = registry = CheckProviderRegistry.getInstance(); const desc = Object.getOwnPropertyDescriptor(currentRegistry as any, 'providers'); if (!desc?.value || !(desc.value instanceof Map)) throw new Error('provider registry map descriptor missing'); const currentMap = map = desc.value as Map<string, CheckProvider>; const entries = originalEntries = [...currentMap.entries()]; inspect = currentMap.get('governed-proof-inspect'); expect(currentRegistry.getProvider('governed-proof-inspect')).toBe(inspect); expect([...currentMap.keys()]).toEqual(entries.map(([key]) => key)); const authority = c0(exactProof, currentFixture); const cfg = config(authority, true); const currentCatalog = catalog = new LocalCatalog(); const currentVerify = verify = new LocalVerify(); currentMap.set(currentCatalog.getName(), currentCatalog); currentMap.set(currentVerify.getName(), currentVerify); admission = createProofAdmitProviderForFocusedTest(exactProof); currentMap.set('proof-admit', admission); expect(currentMap.get('governed-proof-inspect')).toBe(inspect); expect([...currentMap.keys()].slice(0, entries.length)).toEqual(entries.map(([key]) => key));
      const counts = { initialize: 0, answerGoverned: 0, close: 0 }; const proto = currentBinding.agent.prototype; const patches: Patch[] = []; try { for (const key of ['initialize', 'answerGoverned', 'close'] as const) { const d = Object.getOwnPropertyDescriptor(proto, key)!; const original = d.value as (...args: any[]) => unknown; Object.defineProperty(proto, key, { ...d, value: function (this: object, ...args: any[]) { counts[key]++; return original.apply(this, args); } }); patches.push({ target: proto, key, descriptor: d }); } } catch (error) { for (const p of patches.reverse()) { try { Object.defineProperty(p.target, p.key, p.descriptor); } catch {} } throw error; } wrapperRestore = () => { let first: unknown; for (const p of patches.reverse()) { try { Object.defineProperty(p.target, p.key, p.descriptor); } catch (error) { first ||= error; } } if (first) throw first; };
      const engine = new StateMachineExecutionEngine(currentFixture.root); const plan = compileClaimPlan(cfg); const result = await engine.executeGroupedChecks(prInfo, ['discover'], undefined, cfg, 'table', false, 1); expect(phaseIIGuards).toBeDefined(); for (const key of ['child_process.spawn', 'global.fetch', 'node:http.request', 'node:http.get', 'node:https.request', 'node:https.get', 'node:net.connect', 'node:net.createConnection', 'net.Socket.connect', 'node:tls.connect', 'node:dns.lookup', 'node:dns.resolve', 'node:dns.promises.lookup', 'node:dns.promises.resolve']) expect(phaseIIGuards!.counts[key]).toBe(0); const journal = (engine as any)._lastContext.journal as ExecutionJournal; const events = journal.readRuntimeEvents() as readonly any[]; const scoped = events.filter(event => event.scope?.[0]?.key === 'A'); const candidates = scoped.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1'); const receipts = scoped.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1');
      expect(result.statistics.failedExecutions).toBe(0); expect(candidates).toHaveLength(1); expect(receipts).toHaveLength(1); expect(scoped.filter(event => event.type === 'NodeGenerationActivated').map(event => event.checkId)).toEqual(['inspect', 'proof_admit', 'verify']); expect(verify.claims).toHaveLength(1); expect(candidates[0].proofCandidateEvidenceFingerprint).toBe(sha256Canonical(candidates[0].proofCandidateEvidence)); expect(scoped.filter(event => event.type === 'ManagedRunTerminated')).toEqual(expect.arrayContaining([expect.objectContaining({ binding: expect.objectContaining({ checkId: 'inspect' }), controllerDecision: 'completed', cleanupStatus: 'clean' }), expect.objectContaining({ binding: expect.objectContaining({ checkId: 'proof_admit' }), controllerDecision: 'completed', cleanupStatus: 'clean' })]));
      const att = candidates[0].proofCandidateEvidence.probe.attestation; expect(att.dispatch.tool).toBe('codex'); expect(att.evidence.eventCount).toBe(1); expect(counts).toEqual({ initialize: 1, answerGoverned: 1, close: 1 }); expect(journal.getInstanceProjection()).toEqual(journal.replayInstanceProjection()); const checkpoint = journal.exportGraphCheckpoint((engine as any)._lastContext.sessionId); const restored = ExecutionJournal.restoreGraphCheckpoint(plan, JSON.parse(JSON.stringify(checkpoint))); expect(JSON.stringify(restored.exportGraphCheckpoint(checkpoint.sessionId))).toBe(JSON.stringify(checkpoint)); expect(restored.getInstanceProjection()).toEqual(journal.getInstanceProjection()); expect(counts).toEqual({ initialize: 1, answerGoverned: 1, close: 1 });
    } finally {
      const errors: unknown[] = []; const clean = (fn: () => void) => { try { fn(); } catch (error) { errors.push(error); } }; clean(() => { if (f && originalBytes) writeFileSync(f.requirement, originalBytes); }); clean(() => wrapperRestore()); clean(() => { if (map && originalEntries) { map.clear(); for (const entry of originalEntries) map.set(entry[0], entry[1]); } }); clean(() => { if (map && originalEntries) { expect(map.get('governed-proof-inspect')).toBe(inspect); expect([...map.keys()]).toEqual(originalEntries.map(([key]) => key)); } }); clean(() => phaseIIGuards?.restore()); clean(() => binding?.restore()); clean(() => { if (pathCaptured) { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; pathCaptured = false; } }); clean(() => { if (f && originalBytes && originalStat) { expect(readFileSync(f.requirement)).toEqual(originalBytes); expect(lstatSync(f.requirement).mode).toBe(originalStat.mode); } }); clean(() => { if (f) rmSync(f.root, { recursive: true, force: true }); }); clean(() => { if (f) expect(existsSync(f.root)).toBe(false); }); if (errors[0]) throw errors[0];
    }
  }, 660000);
});
