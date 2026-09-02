import { describe, expect, it, jest } from '@jest/globals';
jest.unmock('child_process');
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import type { PRInfo } from '../../src/pr-analyzer';
import { CheckProvider, type CheckProviderConfig, type ExecutionContext } from '../../src/providers/check-provider.interface';
import type { ReviewSummary } from '../../src/reviewer';
import type { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { createGovernedProofInspectProviderForFocusedTest, governedResultDigest, type GovernedProbeRunnerRequest } from '../../src/providers/governed-proof-inspect-check-provider';
import { canonicalJson, immutableCanonicalValue, sha256Canonical } from '../../src/state-machine/graph/claim-kernel';

const PROFILE = resolve(__dirname, '../../examples/agent-governance/exp-0209-discovery-egress/visor.yaml');
const PROOF_AUTHORITY = '/Users/buger/go/src/reqforge-exp-0207a-proof-cli-admission';
const prInfo = { number: 1, title: 'EXP-0209', author: 'test', base: 'main', head: 'demo', files: [], totalAdditions: 0, totalDeletions: 0, eventType: 'manual' } as PRInfo;

function proofTopJson(value: Record<string, unknown>): string {
  return `{${Object.keys(value).filter(key => key !== 'receipt_id').sort((a, b) => Buffer.from(a).compare(Buffer.from(b))).map(key => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(',')}}`;
}
function proofDomainDigest(domain: string, encoded: string): string {
  const bytes = Buffer.from(encoded, 'utf8'); const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(domain).update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}
function proofCanonicalForTest(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(proofCanonicalForTest).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))).map(key => `${JSON.stringify(key)}:${proofCanonicalForTest(object[key])}`).join(',')}}`;
}

function providerMap(registry: CheckProviderRegistry): Map<string, CheckProvider> { return Object.getOwnPropertyDescriptor(registry as any, 'providers')!.value as Map<string, CheckProvider>; }
type ComponentTimelineEvent = { component: string; stage: 'stage1-start' | 'stage1-finish' | 'stage2-start' | 'stage2-finish'; at: number };
abstract class TimedComponentProvider extends CheckProvider {
  constructor(protected readonly timeline: ComponentTimelineEvent[]) { super(); }
  async validateConfig(config: unknown): Promise<boolean> { return !!config && typeof config === 'object' && (config as any).type === this.getName(); }
  async isAvailable(): Promise<boolean> { return true; }
  getRequirements(): string[] { return []; }
  getSupportedConfigKeys(): string[] { return ['type', 'consumes', 'emits', 'depends_on']; }
  protected component(context?: ExecutionContext): string {
    const payload = context?.claims?.component?.payload as Record<string, unknown> | undefined;
    const component = typeof payload?.component_id === 'string' ? payload.component_id : '';
    if (!component) throw new Error('missing component WorkItem');
    return component;
  }
}
class TimedComponentStage1Provider extends TimedComponentProvider {
  getName(): string { return 'timed-component-stage1'; }
  getDescription(): string { return 'Focused integration provider for parallel stage-one component work'; }
  async execute(_pr: PRInfo, _config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, context?: ExecutionContext): Promise<ReviewSummary> {
    const component = this.component(context);
    const durations: Record<string, readonly [number, number]> = { alpha: [120, 30], beta: [15, 30], gamma: [15, 30] };
    const [first] = durations[component] || [15, 15];
    const mark = (stage: ComponentTimelineEvent['stage']) => this.timeline.push({ component, stage, at: Date.now() });
    mark('stage1-start'); await new Promise(resolve => setTimeout(resolve, first)); mark('stage1-finish');
    return { issues: [], output: { status: 'stage1-complete' } };
  }
}
class TimedComponentStage2Provider extends TimedComponentProvider {
  getName(): string { return 'timed-component-stage2'; }
  getDescription(): string { return 'Focused integration provider for early stage-two component work'; }
  async execute(_pr: PRInfo, _config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, context?: ExecutionContext): Promise<ReviewSummary> {
    const component = this.component(context);
    const second = ({ alpha: 30, beta: 30, gamma: 30 } as Record<string, number>)[component] || 15;
    const mark = (stage: ComponentTimelineEvent['stage']) => this.timeline.push({ component, stage, at: Date.now() });
    mark('stage2-start'); await new Promise(resolve => setTimeout(resolve, second)); mark('stage2-finish');
    return { issues: [], output: { status: 'onboarded' } };
  }
}
function fakeDiscovery(request: GovernedProbeRunnerRequest) {
  const data = immutableCanonicalValue({ version: 'proof.component-catalog-candidate/v1', project_id: 'journalservice', components: [
    { id: 'alpha', responsibility: 'HTTP adapter', owned_paths: ['alpha.go'], dependency_closure: ['alpha.go'], entry_points: ['alpha.go:Serve'], state_effects: ['request'], interfaces: [{ name: 'HTTP' }], uncertainty: [] },
    { id: 'beta', responsibility: 'service policy', owned_paths: ['beta.go'], dependency_closure: ['beta.go'], entry_points: ['beta.go:Apply'], state_effects: ['policy'], interfaces: [{ name: 'Policy' }], uncertainty: [] },
    { id: 'gamma', responsibility: 'storage domain', owned_paths: ['gamma.go'], dependency_closure: ['gamma.go'], entry_points: ['gamma.go:Store'], state_effects: ['storage'], interfaces: [{ name: 'Store' }], uncertainty: [] },
  ] });
  const d = 'a'.repeat(64);
  return { data, runtimeAttestation: { version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' }, observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' }, executionContext: { source: 'caller', invocationDigest: request.invocationDigest }, dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${d}`, promptBytes: 17 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' } }, resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: governedResultDigest(data), canonicalBytes: Buffer.byteLength(canonicalJson(data)) } };
}
function withProofFixture<T>(fn: (proof: string, root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'visor-exp0209-')); const proof = join(root, 'proof');
  // These are the exact paths returned by the fake inventory and candidate;
  // WorkItems below are always derived from the candidate's IDs and paths.
  for (const path of ['alpha.go', 'beta.go', 'gamma.go']) writeFileSync(join(root, path), `package journal\\n// ${path}\\n`, 'utf8');
  const script = `#!${process.execPath}
const fs=require('fs'),crypto=require('crypto');
const root=${JSON.stringify(root)}; const pids=${JSON.stringify(join(root, 'pids'))}; const commands=${JSON.stringify(join(root, 'commands'))};
fs.appendFileSync(pids,process.pid+'\\n'); fs.appendFileSync(commands,process.argv.slice(2).join(' ')+'\\n'); let input='';
function canon(v){if(Array.isArray(v))return '['+v.map(canon).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort((a,b)=>Buffer.from(a).compare(Buffer.from(b))).map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';return JSON.stringify(v)}
function top(v){return '{'+Object.keys(v).filter(k=>k!=='receipt_id').sort((a,b)=>Buffer.from(a).compare(Buffer.from(b))).map(k=>JSON.stringify(k)+':'+JSON.stringify(v[k])).join(',')+'}'}
function hasKeys(v,keys){return v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k))}
function digest(domain,bytes){const n=Buffer.alloc(8);n.writeBigUInt64BE(BigInt(bytes.length));return 'sha256:'+crypto.createHash('sha256').update(domain).update(Buffer.from([0])).update(n).update(bytes).digest('hex')}
function sha(bytes){return 'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')}
function fileHash(path){return sha(fs.readFileSync(root+'/'+path))}
function inventory(){return {version:'proof.structural-inventory/v1',authority:{version:'proof.project-authority/v1',project_id:'journalservice',subject_fingerprint:'sha256:'+'a'.repeat(64),code_fingerprint:'sha256:'+'2'.repeat(64),tests_fingerprint:'sha256:'+'3'.repeat(64)},sorted_paths:['alpha.go','beta.go','gamma.go'],sorted_module_paths:[],boundary_fingerprint:'sha256:'+'8'.repeat(64),input_state:['alpha.go','beta.go','gamma.go'].map(path=>({owner_kind:'onboarding_structural_inventory',owner_id:'journalservice',input_kind:'code',path,file_hash:fileHash(path)}))}}
function item(component){const id=component.id,paths=[...component.owned_paths].sort(goSort),closure=[...(component.dependency_closure||component.owned_paths)].sort(goSort);const subject={version:'proof.component-subject/v1',project_id:'journalservice',component_id:id,sorted_owned_paths:paths,sorted_dependency_closure:closure,fingerprint:'sha256:'+'4'.repeat(64)};return {version:'reqproof.onboarding-component-work-item/v1',project_id:'journalservice',component_id:id,sorted_owned_paths:paths,sorted_dependency_closure:closure,proof_path_mapping:{paths,components:[id],owner:'onboard',risk_tier:0,enforcement:'soft'},proof_input_state:closure.map(path=>({owner_kind:'onboarding_component',owner_id:id,input_kind:'code',path,file_hash:fileHash(path)})),proof_component_subject:subject}}
function goSort(a,b){return Buffer.from(a).compare(Buffer.from(b))}
function catalog(candidate){return {version:candidate.version,project_id:candidate.project_id,components:[...candidate.components].sort((a,b)=>goSort(a.id,b.id)).map(component=>{const out={id:component.id,responsibility:component.responsibility,owned_paths:[...component.owned_paths].sort(goSort)};if(component.dependency_closure!==undefined)out.dependency_closure=[...component.dependency_closure].sort(goSort);for(const key of ['entry_points','state_effects','interfaces','uncertainty'])if(component[key]&&component[key].length)out[key]=key==='interfaces'?component[key]:[...component[key]].sort(goSort);return out})}}
function receipt(projection, candidate, admission){const items=projection.work_items;const authorities=items.map(value=>({component_id:value.component_id,work_item_digest:sha(Buffer.from(JSON.stringify(value))),subject:value.proof_component_subject})).sort((a,b)=>goSort(a.component_id,b.component_id));const inv=projection.inventory;const r={version:'proof.catalog-revalidation-receipt/v2',decision:'accepted',project_id:'journalservice',project_fingerprint:inv.authority.subject_fingerprint,boundary_fingerprint:inv.boundary_fingerprint,inventory_claim_id:digest('proof.structural-inventory/claim/v1',Buffer.from(JSON.stringify(inv))),catalog_claim_id:digest('proof.component-catalog-candidate/claim/v1',Buffer.from(canon(candidate))),admission_candidate_id:admission.receipt.CandidateID,admission_result_digest:admission.receipt.ProbeResultDigest,admission_receipt_id:admission.receipt.receipt_id,component_authorities:authorities,project_lineage:null,receipt_id:''};r.receipt_id=digest('proof.catalog-revalidation-receipt/id/v2',Buffer.from(top(r)));return r}
process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{try{const args=process.argv.slice(2).join(' ');if(args==='onboarding inventory'){if(input!=='')throw new Error('inventory accepts no stdin');const o=inventory();process.stdout.write(JSON.stringify(o,null,2)+'\\n');return}if(args==='admit-candidate'){const req=JSON.parse(input),c=req.candidate,p=c&&c.Publication;if(!c||!p||c.Version!=='proof.role-result-candidate-envelope/v1'||!hasKeys(c,['Version','Invocation','InvocationDigest','RoleID','Stance','Subject','AttestationVersion','ExecutionSource','ProbeInvocationDigest','IdentityVersion','IdentitySource','ResultDigest','CanonicalBytes','ProbeResultBytes','VisorPayloadBytes','Publication','Binding','Termination'])||!hasKeys(p,['Version','Type','SessionID','CheckID','Scope','NodeInstanceID','NodeGenerationID','AttemptID','Fence','ClaimID','Claim','PayloadFingerprint','ProducerCheckID','Payload','ParentClaimIDs'])||!hasKeys(c.Binding,['ManagedRunID','SessionID','CheckID','Scope','NodeInstanceID','NodeGenerationID','AttemptID','Fence'])||!hasKeys(c.Termination,['Version','Type','SessionID','Scope','Binding','CleanupStatus','ControllerDecision','FailureCode']))throw new Error('candidate is truncated');const unsigned={Version:'proof.role-result-candidate-admission/v2',Status:'ADMITTED',CandidateID:digest('proof.role-result-candidate-envelope/id/v1',Buffer.from(JSON.stringify(c))),ProbeResultDigest:c.ResultDigest,ProbeCanonicalBytes:c.CanonicalBytes,ClaimID:p.ClaimID,Claim:p.Claim,PayloadFingerprint:p.PayloadFingerprint,InvocationDigest:c.InvocationDigest,RoleID:c.RoleID,Stance:c.Stance,Subject:c.Subject,ProducerCheckID:p.ProducerCheckID,ParentClaimIDs:p.ParentClaimIDs,Binding:c.Binding,Termination:c.Termination,ProjectLineage:null};const receipt={...unsigned,receipt_id:digest('proof.role-result-candidate-receipt/id/v2',Buffer.from(top(unsigned)))};const o={version:'proof.role-result-candidate-cli-decision/v1',status:'ADMITTED',receipt,reject_code:null};process.stdout.write(canon(o)+'\\n');return}if(args==='onboarding revalidate'){const req=JSON.parse(input),candidate=req&&req.candidate,admission=req&&req.admission,admissionKeys=['version','status','receipt','reject_code'],receiptKeys=['Version','Status','CandidateID','ProbeResultDigest','ProbeCanonicalBytes','ClaimID','Claim','PayloadFingerprint','InvocationDigest','RoleID','Stance','Subject','ProducerCheckID','ParentClaimIDs','Binding','Termination','ProjectLineage','receipt_id'];if(!req||canon(req)!==input||req.version!=='proof.catalog-revalidation-request/v2'||!candidate||!admission||JSON.stringify(Object.keys(admission).sort())!==JSON.stringify(admissionKeys.slice().sort())||admission.status!=='ADMITTED'||admission.reject_code!==null||!admission.receipt||JSON.stringify(Object.keys(admission.receipt).sort())!==JSON.stringify(receiptKeys.slice().sort()))throw new Error('admission is truncated');if(candidate.version!=='proof.component-catalog-candidate/v1'||!Array.isArray(candidate.components)||candidate.components.length<2||candidate.components.length>4)throw new Error('candidate is truncated');const inv=inventory(),items=candidate.components.map(item),o={version:'proof.catalog-revalidation/v2',inventory:inv,catalog:catalog(candidate),work_items:items,receipt:null};o.receipt=receipt(o,candidate,admission);process.stdout.write(JSON.stringify(o,null,2)+'\\n');return}if(args==='onboarding work-items'){const req=JSON.parse(input),keys=['version','candidate','admission','revalidation_receipt'];if(!req||JSON.stringify(Object.keys(req))!==JSON.stringify(keys)||req.version!=='proof.onboarding-work-items-request/v1'||!req.candidate||!req.admission||!req.revalidation_receipt)throw new Error('work-items request is truncated');const candidate=req.candidate,inv=inventory(),o={version:'proof.onboarding-work-item-projection/v1',authority:inv.authority,catalog:catalog(candidate),work_items:candidate.components.map(item)};process.stdout.write(JSON.stringify(o,null,2)+'\\n');return}throw new Error('unsupported command '+args)}catch(e){process.stderr.write(String(e));process.exitCode=1}});`;
  writeFileSync(proof, script, 'utf8'); chmodSync(proof, 0o755);
  return Promise.resolve(fn(proof, root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function pinnedProofBinary(): string {
  const configured = process.env.VISOR_PROOF_ADMISSION_BIN;
  if (configured) return configured;
  const binary = join(tmpdir(), `visor-exp0209-proof-head-${process.pid}`);
  if (!existsSync(binary)) {
    // Build the committed authority, not an in-progress checkout.  This
    // keeps the wire-fidelity test pinned even when the sibling Proof worker
    // has an uncommitted source edit in its shared workspace.
    const source = mkdtempSync(join(tmpdir(), 'visor-exp0209-proof-source-'));
    try {
      const archive = execFileSync('git', ['-C', PROOF_AUTHORITY, 'archive', 'HEAD'], { maxBuffer: 256 * 1024 * 1024 });
      execFileSync('tar', ['-xf', '-', '-C', source], { input: archive, stdio: ['pipe', 'pipe', 'pipe'] });
      execFileSync('go', ['build', '-o', binary, './cmd/proof'], {
        cwd: source,
        env: { ...process.env, GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
        stdio: 'pipe',
      });
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  }
  return binary;
}

it('accepts the committed Proof inventory wire through the real pinned binary', async () => {
  expect(existsSync(PROOF_AUTHORITY)).toBe(true);
  const root = mkdtempSync(join(tmpdir(), 'visor-exp0209-real-proof-'));
  writeFileSync(join(root, 'proof.yaml'), 'project:\n  name: wire-fidelity\n', 'utf8');
  writeFileSync(join(root, 'a.go'), 'package wirefidelity\n\nfunc A() {}\n', 'utf8');
  try {
    const [{ createProofAdmissionCapability }, { createProofStructuralInventoryProviderFromCapability }] = await Promise.all([
      import('../../src/providers/proof-admission-cli-child'),
      import('../../src/providers/proof-catalog-check-providers'),
    ]);
    const scope = [{ kind: 'keyed' as const, expansionOwnerCheck: 'project', key: 'wire-fidelity', subgraphInstanceId: 'a'.repeat(64) }];
    const project = immutableCanonicalValue({ claimId: sha256Canonical('wire-fidelity-project'), claim: 'project.discovery_item@1', payload: { project_id: 'wire-fidelity', root }, payloadFingerprint: sha256Canonical({ project_id: 'wire-fidelity', root }), producerCheckId: 'project', scope, parentClaimIds: [], provenance: 'attempt' as const, attemptId: 'b'.repeat(64), fence: 1 });
    const binding = immutableCanonicalValue({ managedRunId: sha256Canonical('real-inventory'), sessionId: 'real', checkId: 'structural_inventory', scope, nodeInstanceId: sha256Canonical('real-node'), nodeGenerationId: sha256Canonical('real-generation'), attemptId: sha256Canonical('real-attempt'), fence: 1 });
    const provider = createProofStructuralInventoryProviderFromCapability(createProofAdmissionCapability(pinnedProofBinary()));
    const run = provider.startManaged({ prInfo, checkConfig: { type: 'proof-structural-inventory', consumes: [], emits: [] }, dependencyResults: new Map(), executionContext: { claims: { project } }, binding, executionConfigDigest: '1'.repeat(64), workingDirectory: root });
    await expect(run.started).resolves.toMatchObject({ kind: 'started' });
    const outcome: any = await run.outcome;
    expect(outcome.kind).toBe('succeeded');
    expect(outcome.summary.output).toMatchObject({ version: 'proof.structural-inventory/v1', authority: { project_id: 'wire-fidelity' }, sorted_paths: ['a.go'] });
    await expect(run.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

it('runs the real pinned Proof admission, revalidation, and activation-safe WorkItems wire', async () => {
  expect(existsSync(PROOF_AUTHORITY)).toBe(true);
  const root = mkdtempSync(join(tmpdir(), 'visor-exp0209-real-e2e-'));
  writeFileSync(join(root, 'proof.yaml'), 'project:\n  name: wire-e2e\n', 'utf8');
  for (const path of ['B.go', 'a.go', 'gamma.go']) writeFileSync(join(root, path), 'package wiree2e\n\nfunc Marker() {}\n', 'utf8');
  try {
    const binary = pinnedProofBinary();
    const invoke = (args: string[], input: string): string => execFileSync(binary, args, { cwd: root, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' } });
    const inventory = JSON.parse(invoke(['onboarding', 'inventory'], '')) as Record<string, any>;
    expect(inventory.version).toBe('proof.structural-inventory/v1');
    expect(inventory.sorted_paths).toEqual(['B.go', 'a.go', 'gamma.go']);
    const outputSchema = Buffer.from('{"type":"object","additionalProperties":false}', 'utf8').toString('base64');
    const subject = { kind: 'project', id: inventory.authority.project_id, fingerprint: inventory.authority.subject_fingerprint };
    const invocationRequest = { role_id: 'onboard', stance: 'owner', subject, output_schema_id: 'proof.component-catalog-candidate@1', output_schema: outputSchema };
    const invocation = JSON.parse(invoke(['resolve-role-invocation'], JSON.stringify(invocationRequest))) as Record<string, any>;
    const candidatePayload = {
      version: 'proof.component-catalog-candidate/v1', project_id: inventory.authority.project_id,
      // Deliberately unsorted component/descriptive arrays: Proof normalizes
      // these on revalidation, while the candidate wire remains exact.
      components: [
        { id: 'a', responsibility: 'lowercase component', owned_paths: ['a.go'], dependency_closure: ['a.go'], entry_points: ['z', 'A'], state_effects: ['b', 'A'], interfaces: [{ name: 'A' }], uncertainty: ['u2', 'u1'] },
        { id: 'B', responsibility: 'uppercase component', owned_paths: ['B.go'] },
        { id: 'gamma', responsibility: 'third component', owned_paths: ['gamma.go'], dependency_closure: ['gamma.go'] },
      ],
    };
    const candidateText = proofCanonicalForTest(candidatePayload);
    const payloadBytes = Buffer.from(candidateText, 'utf8');
    const bare = (seed: string): string => createHash('sha256').update(seed).digest('hex');
    const payloadFingerprint = createHash('sha256').update(payloadBytes).digest('hex');
    const candidateScope = [{ Kind: 'keyed', ExpansionOwnerCheck: 'project', Key: 'wire-e2e', SubgraphInstanceID: bare('scope') }];
    const binding = { ManagedRunID: bare('managed'), SessionID: 'real-session', CheckID: 'inspect', Scope: candidateScope, NodeInstanceID: bare('node'), NodeGenerationID: bare('generation'), AttemptID: bare('attempt'), Fence: 1 };
    const publication = { Version: 1, Type: 'ClaimPublished', SessionID: binding.SessionID, CheckID: binding.CheckID, Scope: candidateScope, NodeInstanceID: binding.NodeInstanceID, NodeGenerationID: binding.NodeGenerationID, AttemptID: binding.AttemptID, Fence: binding.Fence, ClaimID: bare('claim'), Claim: 'proof.candidate@1', PayloadFingerprint: payloadFingerprint, ProducerCheckID: 'inspect', Payload: payloadBytes.toString('base64'), ParentClaimIDs: [bare('parent-a'), bare('parent-b')].sort() };
    const termination = { Version: 1, Type: 'ManagedRunTerminated', SessionID: binding.SessionID, Scope: candidateScope, Binding: binding, CleanupStatus: 'clean', ControllerDecision: 'completed', FailureCode: null };
    const candidate = {
      Version: 'proof.role-result-candidate-envelope/v1', Invocation: invocationRequest, InvocationDigest: invocation.invocation_digest, RoleID: invocation.role_id, Stance: invocation.stance, Subject: invocation.subject,
      AttestationVersion: 'probe.governed-codex-attestation/v2', ExecutionSource: 'caller', ProbeInvocationDigest: invocation.invocation_digest, IdentityVersion: 'probe.governed-result-identity/v1', IdentitySource: 'probe-host-schema-valid-json', ResultDigest: proofDomainDigest('probe.governed-result-identity/data/v1', candidateText), CanonicalBytes: payloadBytes.length, ProbeResultBytes: payloadBytes.toString('base64'), VisorPayloadBytes: payloadBytes.toString('base64'), Publication: publication, Binding: binding, Termination: termination,
    };
    const candidateTextWire = JSON.stringify(candidate);
    const admissionWire = invoke(['admit-candidate'], JSON.stringify({ version: 'proof.role-result-candidate-cli-request/v1', candidate })).trimEnd();
    const admission = JSON.parse(admissionWire) as Record<string, any>;
    expect(admission.status).toBe('ADMITTED');
    expect(admission.receipt.Version).toBe('proof.role-result-candidate-admission/v2');
    expect(Object.prototype.hasOwnProperty.call(admission.receipt, 'ProjectLineage')).toBe(true);
    const revalidationRequest = proofCanonicalForTest({ version: 'proof.catalog-revalidation-request/v2', candidate: candidatePayload, admission });
    const revalidation = JSON.parse(invoke(['onboarding', 'revalidate'], revalidationRequest)) as Record<string, any>;
    expect(revalidation.version).toBe('proof.catalog-revalidation/v2');
    expect(revalidation.receipt.version).toBe('proof.catalog-revalidation-receipt/v2');
    expect(revalidation.work_items).toHaveLength(3);
    expect(revalidation.catalog.components.map((component: any) => component.id)).toEqual(['B', 'a', 'gamma']);
    const normalizedA = revalidation.catalog.components.find((component: any) => component.id === 'a');
    expect(normalizedA.entry_points).toEqual(['A', 'z']);
    expect(normalizedA.state_effects).toEqual(['A', 'b']);
    expect(normalizedA.uncertainty).toEqual(['u1', 'u2']);
    const workItemsRequest = `{"version":"proof.onboarding-work-items-request/v1","candidate":${candidateText},"admission":${admissionWire},"revalidation_receipt":${proofCanonicalForTest(revalidation.receipt)}}`;
    const workItems = JSON.parse(invoke(['onboarding', 'work-items'], workItemsRequest)) as Record<string, any>;
    expect(workItems.version).toBe('proof.onboarding-work-item-projection/v1');
    expect(workItems.catalog).toEqual(revalidation.catalog);
    expect(workItems.work_items.map((item: any) => item.component_id)).toEqual(['B', 'a', 'gamma']);
    expect(candidateTextWire).toContain('proof.role-result-candidate-envelope/v1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

describe('EXP-0209 admitted discovery egress', () => {
  it('settles both new managed Proof providers and reaps their process groups', async () => {
    await withProofFixture(async (proof, root) => {
      const [{ createProofAdmissionCapability }, providers, admittedProviders] = await Promise.all([
        import('../../src/providers/proof-admission-cli-child'),
        import('../../src/providers/proof-catalog-check-providers'),
        import('../../src/providers/proof-admitted-catalog-check-provider'),
      ]);
      const capability = createProofAdmissionCapability(proof);
      const scope = [{ kind: 'keyed' as const, expansionOwnerCheck: 'project', key: 'journalservice', subgraphInstanceId: 'a'.repeat(64) }];
      const makeClaim = (claim: string, payload: unknown, producerCheckId: string, parentClaimIds: string[] = []) => immutableCanonicalValue({ claimId: sha256Canonical({ claim, payload, producerCheckId }), claim, payload, payloadFingerprint: sha256Canonical(payload), producerCheckId, scope, parentClaimIds: [...parentClaimIds].sort(), provenance: 'attempt' as const, attemptId: 'b'.repeat(64), fence: 1 });
      const binding = (checkId: string) => immutableCanonicalValue({ managedRunId: sha256Canonical(checkId), sessionId: 'session', checkId, scope, nodeInstanceId: sha256Canonical(`${checkId}:node`), nodeGenerationId: sha256Canonical(`${checkId}:generation`), attemptId: sha256Canonical(`${checkId}:attempt`), fence: 1 });
      const project = makeClaim('project.discovery_item@1', { project_id: 'journalservice', root: '.' }, 'project');
      const structural = providers.createProofStructuralInventoryProviderFromCapability(capability);
      const structuralRun = structural.startManaged({ prInfo, checkConfig: { type: 'proof-structural-inventory', consumes: [], emits: [] }, dependencyResults: new Map(), executionContext: { claims: { project } }, binding: binding('structural_inventory'), executionConfigDigest: '1'.repeat(64), workingDirectory: root });
      await expect(structuralRun.started).resolves.toMatchObject({ kind: 'started' });
      const structuralOutcome: any = await structuralRun.outcome;
      expect(structuralOutcome.kind).toBe('succeeded');
      await expect(structuralRun.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
      const inventory = makeClaim('proof.structural_inventory@1', structuralOutcome.summary.output, 'structural_inventory', [project.claimId]);
      const candidatePayload = fakeDiscovery({} as GovernedProbeRunnerRequest).data;
      const candidate = makeClaim('proof.candidate@1', candidatePayload, 'inspect', [project.claimId, inventory.claimId]);
      const candidateBytes = Buffer.from(canonicalJson(candidatePayload), 'utf8');
      const candidateBinding = {
        ManagedRunID: 'a'.repeat(64), SessionID: 'session', CheckID: 'inspect',
        Scope: [{ Kind: 'keyed', ExpansionOwnerCheck: 'project', Key: 'journalservice', SubgraphInstanceID: 'a'.repeat(64) }],
        NodeInstanceID: 'b'.repeat(64), NodeGenerationID: 'c'.repeat(64), AttemptID: 'd'.repeat(64), Fence: 1,
      };
      const candidateTermination = {
        Version: 1, Type: 'ManagedRunTerminated', SessionID: 'session', Scope: candidateBinding.Scope,
        Binding: candidateBinding, CleanupStatus: 'clean', ControllerDecision: 'completed', FailureCode: null,
      };
      const candidateEnvelope = {
        Version: 'proof.role-result-candidate-envelope/v1',
        Invocation: { role_id: 'onboard', stance: 'owner', subject: { kind: 'project', id: 'journalservice', fingerprint: (inventory.payload as any).authority.subject_fingerprint }, output_schema_id: 'proof.component-catalog-candidate@1', output_schema: 'e30=' },
        InvocationDigest: 'sha256:' + '4'.repeat(64), RoleID: 'onboard', Stance: 'owner', Subject: { kind: 'project', id: 'journalservice', fingerprint: (inventory.payload as any).authority.subject_fingerprint },
        AttestationVersion: 'probe.governed-codex-attestation/v2', ExecutionSource: 'caller', ProbeInvocationDigest: 'sha256:' + '4'.repeat(64), IdentityVersion: 'probe.governed-result-identity/v1', IdentitySource: 'probe-host-schema-valid-json', ResultDigest: governedResultDigest(candidatePayload), CanonicalBytes: candidateBytes.length, ProbeResultBytes: candidateBytes.toString('base64'), VisorPayloadBytes: candidateBytes.toString('base64'),
        Publication: { Version: 1, Type: 'ClaimPublished', SessionID: 'session', CheckID: 'inspect', Scope: candidateBinding.Scope, NodeInstanceID: candidateBinding.NodeInstanceID, NodeGenerationID: candidateBinding.NodeGenerationID, AttemptID: candidateBinding.AttemptID, Fence: 1, ClaimID: candidate.claimId, Claim: candidate.claim, PayloadFingerprint: candidate.payloadFingerprint, ProducerCheckID: 'inspect', Payload: candidateBytes.toString('base64'), ParentClaimIDs: candidate.parentClaimIds },
        Binding: candidateBinding, Termination: candidateTermination,
      };
      const candidateEnvelopeWire = JSON.stringify(candidateEnvelope);
      const admissionReceipt: Record<string, unknown> = {
        Version: 'proof.role-result-candidate-admission/v2', Status: 'ADMITTED',
        CandidateID: proofDomainDigest('proof.role-result-candidate-envelope/id/v1', candidateEnvelopeWire), ProbeResultDigest: governedResultDigest(candidatePayload), ProbeCanonicalBytes: candidateBytes.length,
        ClaimID: candidate.claimId, Claim: candidate.claim, PayloadFingerprint: candidate.payloadFingerprint,
        InvocationDigest: 'sha256:' + '4'.repeat(64), RoleID: 'onboard', Stance: 'owner', Subject: { kind: 'project', id: 'journalservice', fingerprint: (inventory.payload as any).authority.subject_fingerprint },
        ProducerCheckID: 'inspect', ParentClaimIDs: candidate.parentClaimIds,
        Binding: candidateBinding,
        Termination: candidateTermination,
        ProjectLineage: null, receipt_id: '',
      };
      admissionReceipt.receipt_id = proofDomainDigest('proof.role-result-candidate-receipt/id/v2', proofTopJson(admissionReceipt));
      const admissionDecision = { version: 'proof.role-result-candidate-cli-decision/v1', status: 'ADMITTED', receipt: admissionReceipt, reject_code: null };
      const admissionWire = canonicalJson(admissionDecision);
      const admission = makeClaim('proof.admitted_receipt@1', { ...admissionReceipt, __proof_admission_wire: admissionWire }, 'proof_admit', [candidate.claimId]);
      expect((admission.payload as any).__proof_admission_wire).toBe(admissionWire);
      const revalidator = providers.createProofCatalogRevalidationProviderFromCapability(capability);
      const revalidationRun = revalidator.startManaged({ prInfo, checkConfig: { type: 'proof-catalog-revalidate', consumes: [], emits: [] }, dependencyResults: new Map(), executionContext: { claims: { current_inventory: inventory, candidate, receipt: admission } }, binding: binding('revalidate_catalog'), executionConfigDigest: '2'.repeat(64), workingDirectory: root });
      await expect(revalidationRun.started).resolves.toMatchObject({ kind: 'started' });
      const revalidationOutcome: any = await revalidationRun.outcome;
      expect(revalidationOutcome).toMatchObject({ kind: 'succeeded', summary: { output: { version: 'proof.catalog-revalidation/v2' } } });
      await expect(revalidationRun.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
      const revalidation = makeClaim('proof.catalog_revalidation@1', revalidationOutcome.summary.output, 'revalidate_catalog', [inventory.claimId, candidate.claimId, admission.claimId]);
      const workItems = admittedProviders.createProofAdmittedCatalogProviderFromCapability(capability);
      const workItemsRun = workItems.startManaged({ prInfo, checkConfig: { type: 'proof-admitted-catalog', consumes: [], emits: [] }, dependencyResults: new Map(), executionContext: { claims: { current_inventory: inventory, candidate, receipt: admission, current_revalidation: revalidation } }, binding: binding('materialize_catalog'), executionConfigDigest: '3'.repeat(64), workingDirectory: root });
      await expect(workItemsRun.started).resolves.toMatchObject({ kind: 'started' });
      await expect(workItemsRun.outcome).resolves.toMatchObject({ kind: 'succeeded' });
      await expect(workItemsRun.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
      const pids = existsSync(join(root, 'pids')) ? readFileSync(join(root, 'pids'), 'utf8').trim().split('\n').map(Number) : [];
      expect(pids).toHaveLength(3);
      expect(readFileSync(join(root, 'commands'), 'utf8').trim().split('\n')).toEqual(['onboarding inventory', 'onboarding revalidate', 'onboarding work-items']);
      for (const pid of pids) expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    });
  });

  it('executes authored providers through the native scheduler and replays independent keyed fanout', async () => {
    await withProofFixture(async (proof, root) => {
      const config: any = yaml.load(readFileSync(PROFILE, 'utf8'));
      const [{ CheckProviderRegistry }, { createProofAdmissionCapability }, { StateMachineExecutionEngine }] = await Promise.all([
        import('../../src/providers/check-provider-registry'),
        import('../../src/providers/proof-admission-cli-child'),
        import('../../src/state-machine-execution-engine'),
      ]);
      const registry = CheckProviderRegistry.getInstance(); const providers = providerMap(registry); const original = [...providers.entries()]; let discoveryCalls = 0;
      const timeline: ComponentTimelineEvent[] = [];
      const componentChecks = config.subgraphs['onboard-component'].checks;
      config.claim_types['component.stage1@1'] = { schema: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { const: 'stage1-complete' } } } };
      componentChecks.stage1 = { ...componentChecks.inspect, type: 'timed-component-stage1', consumes: [{ claim: 'component.work_item@1', as: 'component' }], emits: [{ claim: 'component.stage1@1', from: 'output' }] };
      componentChecks.stage2 = { type: 'timed-component-stage2', depends_on: ['stage1'], consumes: [{ claim: 'component.work_item@1', as: 'component' }, { claim: 'component.stage1@1', as: 'stage1' }], emits: [{ claim: 'component.onboarded@1', from: 'output' }] };
      delete componentChecks.inspect;
      providers.set('timed-component-stage1', new TimedComponentStage1Provider(timeline));
      providers.set('timed-component-stage2', new TimedComponentStage2Provider(timeline));
      providers.set('governed-proof-inspect', createGovernedProofInspectProviderForFocusedTest(() => ({ answer: (request: GovernedProbeRunnerRequest) => { discoveryCalls++; return fakeDiscovery(request); }, cancel: () => {}, close: () => {} }))); registry.bootstrapProofAdmission(createProofAdmissionCapability(proof));
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const engine = new StateMachineExecutionEngine(root);
        const running = engine.executeGroupedChecks(prInfo, ['project'], undefined, config, 'json', false, 3);
        const result = await Promise.race([
          running,
          new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => {
            const journal = (engine as any)._lastContext?.journal;
            const events = journal?.readRuntimeEvents?.() || [];
            reject(new Error(`AUTHORED_GRAPH_WATCHDOG ${canonicalJson(events.slice(-8))}`));
          }, 5000); }),
        ]);
        if (watchdog) clearTimeout(watchdog);
        const journal = (engine as any)._lastContext.journal; const events: any[] = journal.readRuntimeEvents();
        expect(result.statistics.failedExecutions).toBe(0); expect(discoveryCalls).toBe(1);
        const published = (claim: string) => events.findIndex(event => event.type === 'ClaimPublished' && event.claim === claim);
        const inventory = published('proof.structural_inventory@1'), candidate = published('proof.candidate@1'), admission = published('proof.admitted_receipt@1'), revalidation = published('proof.catalog_revalidation@1'), catalog = published('component.catalog@1');
        expect(inventory).toBeGreaterThan(-1); expect(candidate).toBeGreaterThan(inventory); expect(admission).toBeGreaterThan(candidate); expect(revalidation).toBeGreaterThan(admission); expect(catalog).toBeGreaterThan(revalidation);
        const admissionEvent: any = events[admission];
        expect(typeof admissionEvent.payload.__proof_admission_wire).toBe('string');
        expect(JSON.parse(admissionEvent.payload.__proof_admission_wire)).toEqual(expect.objectContaining({ version: 'proof.role-result-candidate-cli-decision/v1', status: 'ADMITTED', receipt: expect.objectContaining({ Version: 'proof.role-result-candidate-admission/v2', Status: 'ADMITTED', ProjectLineage: null }), reject_code: null }));
        const components = Object.values(journal.getInstanceProjection().instancesById).filter((value: any) => value.scope.length === 2) as any[];
        expect(components.map(value => value.itemKey).sort()).toEqual(['alpha', 'beta', 'gamma']);
        const event = (component: string, stage: ComponentTimelineEvent['stage']) => timeline.find(value => value.component === component && value.stage === stage)?.at;
        const starts = ['alpha', 'beta', 'gamma'].map(component => event(component, 'stage1-start'));
        expect(starts.every(value => value !== undefined)).toBe(true);
        expect(Math.max(...starts as number[]) - Math.min(...starts as number[])).toBeLessThan(80);
        expect(event('beta', 'stage2-start')).toBeLessThan(event('alpha', 'stage1-finish') as number);
        expect(event('gamma', 'stage2-start')).toBeLessThan(event('alpha', 'stage1-finish') as number);
        const stage1Claims = events.filter(value => value.type === 'ClaimPublished' && value.claim === 'component.stage1@1') as any[];
        const stage2Activations = events.filter(value => value.type === 'NodeGenerationActivated' && value.checkId === 'stage2') as any[];
        expect(stage1Claims).toHaveLength(3); expect(stage2Activations).toHaveLength(3);
        for (const activation of stage2Activations) {
          const stage1 = stage1Claims.find(value => value.scope[value.scope.length - 1]?.subgraphInstanceId === activation.subgraphInstanceId);
          expect(stage1).toBeDefined(); expect(activation.activeInputClaimIds).toContain(stage1.claimId);
        }
        expect(journal.replayInstanceProjection()).toEqual(journal.getInstanceProjection());
      } finally { if (watchdog) clearTimeout(watchdog); providers.clear(); for (const entry of original) providers.set(entry[0], entry[1]); CheckProviderRegistry.clearInstance(); }
    });
  });
});
