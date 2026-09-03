import { describe, expect, it, jest } from '@jest/globals';
const { execFileSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';
import { buildCatalogRevalidationRequest } from '../../examples/agent-governance/exp-0209-discovery-egress/run-live-demo';
import type { PRInfo } from '../../src/pr-analyzer';
import type { GovernedProbeRunnerRequest } from '../../src/providers/governed-proof-inspect-check-provider';
import { immutableProofCanonicalValue, proofCanonicalJson, proofGovernedResultDigest, proofPayloadFingerprint } from '../../src/providers/proof-wire';
import { canonicalJson, compileClaimSchema, immutableCanonicalValue, sha256Canonical } from '../../src/state-machine/graph/claim-kernel';

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

function fakeDiscovery(request: GovernedProbeRunnerRequest, preserveSignedZero = true) {
  const data = { version: 'proof.component-catalog-candidate/v1', project_id: 'journalservice', components: [
    { id: 'alpha', responsibility: 'HTTP adapter', owned_paths: ['alpha.go'], dependency_closure: ['alpha.go'], entry_points: ['alpha.go:Serve'], state_effects: ['request'], interfaces: preserveSignedZero ? [{ name: 'HTTP', '\uE000': 'private-use', '\u{10000}': 'astral' }, { n: -0 }] : [{ name: 'HTTP' }, { n: 0 }], uncertainty: [] },
    { id: 'beta', responsibility: 'service policy', owned_paths: ['beta.go'], dependency_closure: ['beta.go'], entry_points: ['beta.go:Apply'], state_effects: ['policy'], interfaces: [{ name: 'Policy' }], uncertainty: [] },
    { id: 'gamma', responsibility: 'storage domain', owned_paths: ['gamma.go'], dependency_closure: ['gamma.go'], entry_points: ['gamma.go:Store'], state_effects: ['storage'], interfaces: [{ name: 'Store' }], uncertainty: [] },
  ] };
  const d = 'a'.repeat(64);
  return { data, runtimeAttestation: { version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' }, observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' }, executionContext: { source: 'caller', invocationDigest: request.invocationDigest }, dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${d}`, promptBytes: 17 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' } }, resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: proofGovernedResultDigest(data), canonicalBytes: Buffer.byteLength(proofCanonicalJson(data), 'utf8') } };
}
function fakeComponent(request: GovernedProbeRunnerRequest) {
  const authority = request.invocation.component_authority as Record<string, any>;
  const subject = authority.subject as Record<string, any>;
  const coordinate = (path: string) => ({ path, line: 1 });
  const reviewedFiles = subject.sorted_owned_paths.map((path: string) => ({ path, coordinates: [coordinate(path)] }));
  const data = immutableCanonicalValue({
    schema: 'reqproof.component-onboarding/v1',
    project: subject.project_id,
    shard: subject.component_id,
    reviewedFiles,
    requirements: ['STK', 'SYS', 'SW', 'INT'].map((kind, index) => ({
      id: `${kind}-${subject.component_id}-${index + 1}`,
      text: `${kind} evidence for ${subject.component_id}`,
      coordinates: [coordinate(subject.sorted_owned_paths[0])],
    })),
    interfaces: [{ name: `${subject.component_id}-boundary`, coordinates: [coordinate(subject.sorted_owned_paths[0])] }],
    findings: [{ id: `finding-${subject.component_id}`, severity: 'info', title: 'No blocking finding', calibration: 'confirmed', confidence: 1, coordinates: [coordinate(subject.sorted_owned_paths[0])] }],
    unknowns: [],
    repositoryMutated: false,
    commandsExecuted: false,
    checklistCompleted: false,
  });
  const bytes = canonicalJson(data);
  const d = 'a'.repeat(64);
  return {
    data,
    runtimeAttestation: {
      version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1',
      requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
      observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' },
      executionContext: { source: 'caller', invocationDigest: request.invocationDigest },
      dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${d}`, promptBytes: 0 },
      evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
    },
    resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: proofDomainDigest('probe.governed-result-identity/data/v1', bytes), canonicalBytes: Buffer.byteLength(bytes, 'utf8') },
  };
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
function canon(v){if(typeof v==='number'&&Object.is(v,-0))return '-0';if(Array.isArray(v))return '['+v.map(canon).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort((a,b)=>Buffer.from(a).compare(Buffer.from(b))).map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';return JSON.stringify(v)}
function top(v, includeReceiptID=false){return '{'+Object.keys(v).filter(k=>includeReceiptID||k!=='receipt_id').sort((a,b)=>Buffer.from(a).compare(Buffer.from(b))).map(k=>JSON.stringify(k)+':'+JSON.stringify(v[k])).join(',')+'}'}
function hasKeys(v,keys){return v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k))}
function digest(domain,bytes){const n=Buffer.alloc(8);n.writeBigUInt64BE(BigInt(bytes.length));return 'sha256:'+crypto.createHash('sha256').update(domain).update(Buffer.from([0])).update(n).update(bytes).digest('hex')}
function sha(bytes){return 'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')}
function fileHash(path){return sha(fs.readFileSync(root+'/'+path))}
function inventory(){return {version:'proof.structural-inventory/v1',authority:{version:'proof.project-authority/v1',project_id:'journalservice',subject_fingerprint:'sha256:'+'a'.repeat(64),code_fingerprint:'sha256:'+'2'.repeat(64),tests_fingerprint:'sha256:'+'3'.repeat(64)},sorted_paths:['alpha.go','beta.go','gamma.go'],sorted_module_paths:[],boundary_fingerprint:'sha256:'+'8'.repeat(64),input_state:['alpha.go','beta.go','gamma.go'].map(path=>({owner_kind:'onboarding_structural_inventory',owner_id:'journalservice',input_kind:'code',path,file_hash:fileHash(path)}))}}
function item(component){const id=component.id,paths=[...component.owned_paths].sort(goSort),closure=[...(component.dependency_closure||component.owned_paths)].sort(goSort);const subject={version:'proof.component-subject/v1',project_id:'journalservice',component_id:id,sorted_owned_paths:paths,sorted_dependency_closure:closure,fingerprint:'sha256:'+'4'.repeat(64)};return {version:'reqproof.onboarding-component-work-item/v1',project_id:'journalservice',component_id:id,sorted_owned_paths:paths,sorted_dependency_closure:closure,proof_path_mapping:{paths,components:[id],owner:'onboard',risk_tier:0,enforcement:'soft'},proof_input_state:closure.map(path=>({owner_kind:'onboarding_component',owner_id:id,input_kind:'code',path,file_hash:fileHash(path)})),proof_component_subject:subject}}
function goSort(a,b){return Buffer.from(a).compare(Buffer.from(b))}
function catalog(candidate){return {version:candidate.version,project_id:candidate.project_id,components:[...candidate.components].sort((a,b)=>goSort(a.id,b.id)).map(component=>{const out={id:component.id,responsibility:component.responsibility,owned_paths:[...component.owned_paths].sort(goSort)};if(component.dependency_closure!==undefined)out.dependency_closure=[...component.dependency_closure].sort(goSort);for(const key of ['entry_points','state_effects','interfaces','uncertainty'])if(component[key]&&component[key].length)out[key]=key==='interfaces'?component[key]:[...component[key]].sort(goSort);return out})}}
function receipt(projection, candidate, admission){const items=projection.work_items;const authorities=items.map(value=>({component_id:value.component_id,work_item_digest:sha(Buffer.from(JSON.stringify(value))),subject:value.proof_component_subject})).sort((a,b)=>goSort(a.component_id,b.component_id));const inv=projection.inventory;const r={version:'proof.catalog-revalidation-receipt/v2',decision:'accepted',project_id:'journalservice',project_fingerprint:inv.authority.subject_fingerprint,boundary_fingerprint:inv.boundary_fingerprint,inventory_claim_id:digest('proof.structural-inventory/claim/v1',Buffer.from(JSON.stringify(inv))),catalog_claim_id:digest('proof.component-catalog-candidate/claim/v1',Buffer.from(canon(candidate))),admission_candidate_id:admission.receipt.CandidateID,admission_result_digest:admission.receipt.ProbeResultDigest,admission_receipt_id:admission.receipt.receipt_id,component_authorities:authorities,project_lineage:null,receipt_id:''};r.receipt_id=digest('proof.catalog-revalidation-receipt/id/v2',Buffer.from(top(r,true)));return r}
// The fixture keeps inventory on the historical generic wire and uses Proof
// canonical bytes only for the signed-zero revalidation projection below.
process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{try{const args=process.argv.slice(2).join(' ');if(args==='onboarding inventory'){if(input!=='')throw new Error('inventory accepts no stdin');const o=inventory();process.stdout.write(JSON.stringify(o,null,2)+'\\n');return}if(args==='admit-candidate'){const req=JSON.parse(input),c=req.candidate,p=c&&c.Publication;if(!c||!p||c.Version!=='proof.role-result-candidate-envelope/v1'||!hasKeys(c,['Version','Invocation','InvocationDigest','RoleID','Stance','Subject','AttestationVersion','ExecutionSource','ProbeInvocationDigest','IdentityVersion','IdentitySource','ResultDigest','CanonicalBytes','ProbeResultBytes','VisorPayloadBytes','Publication','Binding','Termination'])||!hasKeys(p,['Version','Type','SessionID','CheckID','Scope','NodeInstanceID','NodeGenerationID','AttemptID','Fence','ClaimID','Claim','PayloadFingerprint','ProducerCheckID','Payload','ParentClaimIDs'])||!hasKeys(c.Binding,['ManagedRunID','SessionID','CheckID','Scope','NodeInstanceID','NodeGenerationID','AttemptID','Fence'])||!hasKeys(c.Termination,['Version','Type','SessionID','Scope','Binding','CleanupStatus','ControllerDecision','FailureCode']))throw new Error('candidate is truncated');const unsigned={Version:'proof.role-result-candidate-admission/v2',Status:'ADMITTED',CandidateID:digest('proof.role-result-candidate-envelope/id/v1',Buffer.from(JSON.stringify(c))),ProbeResultDigest:c.ResultDigest,ProbeCanonicalBytes:c.CanonicalBytes,ClaimID:p.ClaimID,Claim:p.Claim,PayloadFingerprint:p.PayloadFingerprint,InvocationDigest:c.InvocationDigest,RoleID:c.RoleID,Stance:c.Stance,Subject:c.Subject,ProducerCheckID:p.ProducerCheckID,ParentClaimIDs:p.ParentClaimIDs,Binding:c.Binding,Termination:c.Termination,ProjectLineage:null};const receipt={...unsigned,receipt_id:digest('proof.role-result-candidate-receipt/id/v2',Buffer.from(top(unsigned)))};const o={version:'proof.role-result-candidate-cli-decision/v1',status:'ADMITTED',receipt,reject_code:null};process.stdout.write(canon(o)+'\\n');return}if(args==='onboarding revalidate'){const req=JSON.parse(input),candidate=req&&req.candidate,admission=req&&req.admission,admissionKeys=['version','status','receipt','reject_code'],receiptKeys=['Version','Status','CandidateID','ProbeResultDigest','ProbeCanonicalBytes','ClaimID','Claim','PayloadFingerprint','InvocationDigest','RoleID','Stance','Subject','ProducerCheckID','ParentClaimIDs','Binding','Termination','ProjectLineage','receipt_id'];if(!req||canon(req)!==input||req.version!=='proof.catalog-revalidation-request/v2'||!candidate||!admission||JSON.stringify(Object.keys(admission).sort())!==JSON.stringify(admissionKeys.slice().sort())||admission.status!=='ADMITTED'||admission.reject_code!==null||!admission.receipt||JSON.stringify(Object.keys(admission.receipt).sort())!==JSON.stringify(receiptKeys.slice().sort()))throw new Error('admission is truncated');if(candidate.version!=='proof.component-catalog-candidate/v1'||!Array.isArray(candidate.components)||candidate.components.length<2||candidate.components.length>4)throw new Error('candidate is truncated');const inv=inventory(),items=candidate.components.map(item),o={version:'proof.catalog-revalidation/v2',inventory:inv,catalog:catalog(candidate),work_items:items,receipt:null};o.receipt=receipt(o,candidate,admission);process.stdout.write(JSON.stringify(o,null,2)+'\\n');return}if(args==='onboarding work-items'){const req=JSON.parse(input),keys=['version','candidate','admission','revalidation_receipt'];if(!req||JSON.stringify(Object.keys(req))!==JSON.stringify(keys)||req.version!=='proof.onboarding-work-items-request/v1'||!req.candidate||!req.admission||!req.revalidation_receipt)throw new Error('work-items request is truncated');const candidate=req.candidate,inv=inventory(),o={version:'proof.onboarding-work-item-projection/v1',authority:inv.authority,catalog:catalog(candidate),work_items:candidate.components.map(item)};process.stdout.write(JSON.stringify(o,null,2)+'\\n');return}throw new Error('unsupported command '+args)}catch(e){process.stderr.write(String(e));process.exitCode=1}});`;
  // Preserve Proof's signed-zero bytes in the synthetic revalidation
  // projection; inventory remains the historical generic wire.
  const proofWireScript = script.replace(
    "process.stdout.write(JSON.stringify(o,null,2)+'\\n');return}if(args==='onboarding work-items'",
    "process.stdout.write(canon(o)+'\\n');return}if(args==='onboarding work-items'",
  );
  const scriptWithC0 = proofWireScript.replace(
    "try{const args=process.argv.slice(2).join(' ');",
    "try{const args=process.argv.slice(2).join(' ');if(args==='resolve-role-invocation'){const req=JSON.parse(input),component=Object.prototype.hasOwnProperty.call(req,'component_authority'),o={version:'proof.role-invocation/v1',role_id:req.role_id,role_source:'fixture',stance:req.stance,subject:req.subject,...(component?{component_authority:req.component_authority}:{}),authority:{},output_schema_id:req.output_schema_id,output_schema:req.output_schema,output_schema_digest:sha(Buffer.from(req.output_schema,'base64')),instructions:'fixture component inspection instructions',role_text_digest:sha(Buffer.from('fixture component inspection instructions')),invocation_digest:'sha256:'+'4'.repeat(64)};process.stdout.write(JSON.stringify(o)+'\\n');return}"
  );
  writeFileSync(proof, scriptWithC0, 'utf8'); chmodSync(proof, 0o755);
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
    jest.resetModules();
    jest.doMock('child_process', () => jest.requireActual('child_process'));
    jest.doMock('node:child_process', () => jest.requireActual('node:child_process'));
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
    const revalidationRequest = buildCatalogRevalidationRequest(candidatePayload, admissionWire);
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

    const malformedPayload = JSON.parse(candidateText) as Record<string, any>;
    malformedPayload.components[0].dependency_closure = ['not-in-inventory.go'];
    const malformedText = proofCanonicalForTest(malformedPayload);
    const malformedBytes = Buffer.from(malformedText, 'utf8');
    const malformedCandidate = {
      ...candidate,
      ResultDigest: proofDomainDigest('probe.governed-result-identity/data/v1', malformedText),
      CanonicalBytes: malformedBytes.length,
      ProbeResultBytes: malformedBytes.toString('base64'),
      VisorPayloadBytes: malformedBytes.toString('base64'),
      Publication: {
        ...candidate.Publication,
        PayloadFingerprint: createHash('sha256').update(malformedBytes).digest('hex'),
        Payload: malformedBytes.toString('base64'),
      },
    };
    const malformedAdmissionWire = invoke(['admit-candidate'], JSON.stringify({ version: 'proof.role-result-candidate-cli-request/v1', candidate: malformedCandidate })).trimEnd();
    expect(JSON.parse(malformedAdmissionWire).status).toBe('ADMITTED');
    const malformedRevalidationRequest = proofCanonicalForTest({ version: 'proof.catalog-revalidation-request/v2', candidate: malformedPayload, admission: JSON.parse(malformedAdmissionWire) });
    expect(() => invoke(['onboarding', 'revalidate'], malformedRevalidationRequest)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

it('runs the real Proof inventory, admission, revalidation, and fresh WorkItems through Visor managed providers', async () => {
  expect(existsSync(PROOF_AUTHORITY)).toBe(true);
  const repository = mkdtempSync(join(tmpdir(), 'visor-exp0209-managed-proof-'));
  const root = join(repository, 'nested-project');
  const files = ['alpha.go', 'beta.go', 'gamma.go'];
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'proof.yaml'), 'project:\n  name: journalservice\n', 'utf8');
  for (const path of files) writeFileSync(join(root, path), `package journal\n// ${path}\n`, 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'visor-test@example.invalid'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Visor test'], { cwd: repository });
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repository });
  try {
    jest.resetModules();
    jest.doMock('child_process', () => jest.requireActual('child_process'));
    jest.doMock('node:child_process', () => jest.requireActual('node:child_process'));
    const [child, providers, admitModule, admittedModule] = await Promise.all([
      import('../../src/providers/proof-admission-cli-child'),
      import('../../src/providers/proof-catalog-check-providers'),
      import('../../src/providers/proof-admit-check-provider'),
      import('../../src/providers/proof-admitted-catalog-check-provider'),
    ]);
    const capability = child.createProofAdmissionCapability(pinnedProofBinary());
    const scope = [{ kind: 'keyed' as const, expansionOwnerCheck: 'project', key: 'journalservice', subgraphInstanceId: 'a'.repeat(64) }];
    const makeClaim = (claim: string, payload: unknown, producerCheckId: string, parentClaimIds: string[] = []) => {
      const wireMode = claim === 'proof.candidate@1' ? 'proof' as const : 'generic' as const;
      const immutablePayload = wireMode === 'proof' ? immutableProofCanonicalValue(payload) : immutableCanonicalValue(payload);
      const payloadFingerprint = wireMode === 'proof' ? proofPayloadFingerprint(payload) : sha256Canonical(payload);
      return Object.freeze({
        claimId: sha256Canonical({ claim, payload: immutablePayload, producerCheckId }), claim, payload: immutablePayload, payloadFingerprint,
        producerCheckId, scope: immutableCanonicalValue(scope), parentClaimIds: [...parentClaimIds].sort(), provenance: 'attempt' as const,
        attemptId: 'b'.repeat(64), fence: 1,
        wireMode,
      });
    };
    const binding = (checkId: string) => immutableCanonicalValue({
      managedRunId: sha256Canonical(`managed:${checkId}`), sessionId: 'real-managed-session', checkId, scope,
      nodeInstanceId: sha256Canonical(`node:${checkId}`), nodeGenerationId: sha256Canonical(`generation:${checkId}`),
      attemptId: sha256Canonical(`attempt:${checkId}`), fence: 1,
    });
    const project = makeClaim('project.discovery_item@1', { project_id: 'journalservice', root }, 'project');
    const structural = providers.createProofStructuralInventoryProviderFromCapability(capability);
    const inventoryRun = structural.startManaged({
      prInfo, checkConfig: { type: 'proof-structural-inventory', consumes: [], emits: [] }, dependencyResults: new Map(),
      executionContext: { claims: { project } }, binding: binding('structural_inventory'), executionConfigDigest: '1'.repeat(64), workingDirectory: root,
    });
    await expect(inventoryRun.started).resolves.toMatchObject({ kind: 'started' });
    let inventoryOutput: Record<string, unknown>;
    try {
      const outcome: any = await inventoryRun.outcome;
      expect(outcome.kind).toBe('succeeded');
      inventoryOutput = outcome.summary.output;
    } finally {
      await expect(inventoryRun.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
    }
    expect(inventoryOutput!.version).toBe('proof.structural-inventory/v1');
    expect(inventoryOutput!.sorted_paths).toEqual(files);
    const inventory = makeClaim('proof.structural_inventory@1', inventoryOutput!, 'structural_inventory', [project.claimId]);
    const authority = inventoryOutput!.authority as Record<string, unknown>;
    const subject = { kind: 'project', id: 'journalservice', fingerprint: authority.subject_fingerprint };
    const outputSchema = Buffer.from('{"type":"object","additionalProperties":false}', 'utf8').toString('base64');
    const invocationRequest = { role_id: 'onboard', stance: 'owner', subject, output_schema_id: 'proof.component-catalog-candidate@1', output_schema: outputSchema };
    const invocation = await child.resolveProofRoleInvocation(capability, invocationRequest, root);
      const candidatePayload = immutableProofCanonicalValue({
      version: 'proof.component-catalog-candidate/v1', project_id: 'journalservice', components: [
        { id: 'alpha', responsibility: 'HTTP <>&\u2028\u2029 adapter', owned_paths: ['alpha.go'], dependency_closure: ['alpha.go'], entry_points: ['z', 'A'], state_effects: ['b', 'A'], interfaces: [{ name: 'HTTP', '\uE000': 'private-use', '\u{10000}': 'astral' }], uncertainty: ['u2', 'u1'] },
        { id: 'beta', responsibility: 'service policy', owned_paths: ['beta.go'], dependency_closure: ['beta.go'] },
        { id: 'gamma', responsibility: 'storage domain', owned_paths: ['gamma.go'], dependency_closure: ['gamma.go'] },
      ],
    });
    const candidateBytes = Buffer.from(proofCanonicalJson(candidatePayload), 'utf8');
    expect(proofCanonicalJson({ '\uE000': 1, '\u{10000}': 2 })).toBe('{"\uE000":1,"\u{10000}":2}');
    expect(Object.keys(JSON.parse(candidateBytes.toString('utf8')).components[0].interfaces[0])).toEqual(['name', '\uE000', '\u{10000}']);
    let candidate = makeClaim('proof.candidate@1', candidatePayload, 'inspect', [project.claimId, inventory.claimId]);
    const proofScope = scope.map(part => ({ Kind: 'keyed', ExpansionOwnerCheck: part.expansionOwnerCheck, Key: part.key, SubgraphInstanceID: part.subgraphInstanceId }));
    const candidateBinding = { ManagedRunID: sha256Canonical('candidate-managed'), SessionID: 'real-managed-session', CheckID: 'inspect', Scope: proofScope, NodeInstanceID: sha256Canonical('candidate-node'), NodeGenerationID: sha256Canonical('candidate-generation'), AttemptID: sha256Canonical('candidate-attempt'), Fence: 1 };
    const candidateTermination = { Version: 1, Type: 'ManagedRunTerminated', SessionID: candidateBinding.SessionID, Scope: proofScope, Binding: candidateBinding, CleanupStatus: 'clean', ControllerDecision: 'completed', FailureCode: null };
    const candidateEnvelope = {
      Version: 'proof.role-result-candidate-envelope/v1', Invocation: invocationRequest, InvocationDigest: invocation.invocation_digest,
      RoleID: invocation.role_id, Stance: invocation.stance, Subject: invocation.subject,
      AttestationVersion: 'probe.governed-codex-attestation/v2', ExecutionSource: 'caller', ProbeInvocationDigest: invocation.invocation_digest,
      IdentityVersion: 'probe.governed-result-identity/v1', IdentitySource: 'probe-host-schema-valid-json', ResultDigest: proofGovernedResultDigest(candidatePayload), CanonicalBytes: candidateBytes.length,
      ProbeResultBytes: candidateBytes.toString('base64'), VisorPayloadBytes: candidateBytes.toString('base64'),
      Publication: { Version: 1, Type: 'ClaimPublished', SessionID: candidateBinding.SessionID, CheckID: 'inspect', Scope: proofScope, NodeInstanceID: candidateBinding.NodeInstanceID, NodeGenerationID: candidateBinding.NodeGenerationID, AttemptID: candidateBinding.AttemptID, Fence: 1, ClaimID: candidate.claimId, Claim: candidate.claim, PayloadFingerprint: candidate.payloadFingerprint, ProducerCheckID: 'inspect', Payload: candidateBytes.toString('base64'), ParentClaimIDs: candidate.parentClaimIds },
      Binding: candidateBinding, Termination: candidateTermination,
    };
    const candidateEvidence = {
      version: 'visor.proof-candidate-evidence/v1',
      role: { invocation: invocationRequest, invocationDigest: invocation.invocation_digest },
      probe: {
        attestation: {
          version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1',
          requested: { profileDigest: 'a'.repeat(64), cwdDigest: 'a'.repeat(64), probeToolsDigest: 'a'.repeat(64), model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
          observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: 'a'.repeat(64), permissionProfileDigest: 'a'.repeat(64), filesystem: 'restricted-read-root', network: 'restricted' },
          executionContext: { source: 'caller', invocationDigest: invocation.invocation_digest },
          dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'a'.repeat(64)}`, promptBytes: 0 },
          evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
        },
        resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: proofGovernedResultDigest(candidatePayload), canonicalBytes: candidateBytes.length },
      },
    };
    candidate = { ...candidate, proofAdmission: candidateEvidence };
    candidate = {
      ...candidate,
      claimId: sha256Canonical({
        claim: candidate.claim,
        payloadFingerprint: candidate.payloadFingerprint,
        producerCheckId: candidate.producerCheckId,
        scope: candidate.scope,
        attemptId: candidate.attemptId,
        fence: candidate.fence,
        parentClaimIds: [...candidate.parentClaimIds].sort(),
        proofCandidateEvidenceFingerprint: sha256Canonical(candidateEvidence),
      }),
    };
    candidateEnvelope.Publication.ClaimID = candidate.claimId;
    const admissionProvider = admitModule.createProofAdmitProviderFromCapability(capability);
    const admissionRun = admissionProvider.startManaged({
      prInfo, checkConfig: { type: 'proof-admit', consumes: [{ claim: 'proof.candidate@1', as: 'candidate' }], emits: [] },
      dependencyResults: new Map([['inspect', { issues: [], output: candidatePayload }]]), executionContext: { claims: { candidate } }, binding: binding('proof_admit'), executionConfigDigest: '2'.repeat(64), workingDirectory: root,
      proofAdmissionRequest: JSON.stringify({ version: 'proof.role-result-candidate-cli-request/v1', candidate: candidateEnvelope }),
    });
    await expect(admissionRun.started).resolves.toMatchObject({ kind: 'started' });
    let admissionOutput: Record<string, unknown>;
    try {
      const outcome: any = await admissionRun.outcome;
      expect(outcome.kind).toBe('succeeded');
      admissionOutput = outcome.summary.output;
    } finally {
      await expect(admissionRun.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
    }
    expect(admissionOutput!.Version).toBe('proof.role-result-candidate-admission/v2');
    expect(admissionOutput!.ProjectLineage).toEqual(expect.objectContaining({ version: 'proof.git-project-lineage-binding/v1' }));
    const admission = makeClaim('proof.admitted_receipt@1', admissionOutput!, 'proof_admit', [candidate.claimId]);
    const revalidator = providers.createProofCatalogRevalidationProviderFromCapability(capability);
    const revalidationRun = revalidator.startManaged({
      prInfo, checkConfig: { type: 'proof-catalog-revalidate', consumes: [], emits: [] }, dependencyResults: new Map(),
      executionContext: { claims: { current_inventory: inventory, candidate, receipt: admission } }, binding: binding('revalidate_catalog'), executionConfigDigest: '3'.repeat(64), workingDirectory: root,
    });
    await expect(revalidationRun.started).resolves.toMatchObject({ kind: 'started' });
    let revalidationOutput: Record<string, unknown>;
    try {
      const outcome: any = await revalidationRun.outcome;
      expect(outcome.kind).toBe('succeeded');
      revalidationOutput = outcome.summary.output;
    } finally {
      await expect(revalidationRun.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
    }
    expect(revalidationOutput!.version).toBe('proof.catalog-revalidation/v2');
    expect((revalidationOutput!.receipt as Record<string, unknown>).project_lineage).toEqual(expect.objectContaining({ version: 'proof.git-project-lineage-binding/v1' }));
    expect((revalidationOutput!.work_items as unknown[]).map(item => (item as Record<string, unknown>).component_id)).toEqual(['alpha', 'beta', 'gamma']);
    const revalidation = makeClaim('proof.catalog_revalidation@1', revalidationOutput!, 'revalidate_catalog', [inventory.claimId, candidate.claimId, admission.claimId]);
    const materializer = admittedModule.createProofAdmittedCatalogProviderFromCapability(capability);
    const workItemsRun = materializer.startManaged({
      prInfo, checkConfig: { type: 'proof-admitted-catalog', consumes: [], emits: [] }, dependencyResults: new Map(),
      executionContext: { claims: { current_inventory: inventory, candidate, receipt: admission, current_revalidation: revalidation } }, binding: binding('materialize_catalog'), executionConfigDigest: '4'.repeat(64), workingDirectory: root,
    });
    await expect(workItemsRun.started).resolves.toMatchObject({ kind: 'started' });
    try {
      const outcome: any = await workItemsRun.outcome;
      expect(outcome.kind).toBe('succeeded');
      expect(outcome.summary.output.components.map((item: Record<string, unknown>) => item.component_id)).toEqual(['alpha', 'beta', 'gamma']);
      expect(outcome.summary.output.components).toHaveLength(3);
    } finally {
      await expect(workItemsRun.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}, 120000);

describe('EXP-0209 admitted discovery egress', () => {
  it('settles both new managed Proof providers and reaps their process groups', async () => {
    await withProofFixture(async (proof, root) => {
      jest.resetModules();
      jest.doMock('child_process', () => jest.requireActual('child_process'));
      jest.doMock('node:child_process', () => jest.requireActual('node:child_process'));
      const [{ createProofAdmissionCapability }, providers, admittedProviders] = await Promise.all([
        import('../../src/providers/proof-admission-cli-child'),
        import('../../src/providers/proof-catalog-check-providers'),
        import('../../src/providers/proof-admitted-catalog-check-provider'),
      ]);
      const capability = createProofAdmissionCapability(proof);
      const scope = [{ kind: 'keyed' as const, expansionOwnerCheck: 'project', key: 'journalservice', subgraphInstanceId: 'a'.repeat(64) }];
      const makeClaim = (claim: string, payload: unknown, producerCheckId: string, parentClaimIds: string[] = []) => { const wireMode = claim === 'proof.candidate@1' || claim === 'proof.catalog_revalidation@1' ? 'proof' as const : 'generic' as const; const immutablePayload = wireMode === 'proof' ? immutableProofCanonicalValue(payload) : immutableCanonicalValue(payload); return Object.freeze({ claimId: sha256Canonical({ claim, payload: immutablePayload, producerCheckId }), claim, payload: immutablePayload, payloadFingerprint: wireMode === 'proof' ? proofPayloadFingerprint(payload) : sha256Canonical(payload), producerCheckId, scope: immutableCanonicalValue(scope), parentClaimIds: [...parentClaimIds].sort(), provenance: 'attempt' as const, attemptId: 'b'.repeat(64), fence: 1, wireMode }); };
      const binding = (checkId: string) => immutableCanonicalValue({ managedRunId: sha256Canonical(checkId), sessionId: 'session', checkId, scope, nodeInstanceId: sha256Canonical(`${checkId}:node`), nodeGenerationId: sha256Canonical(`${checkId}:generation`), attemptId: sha256Canonical(`${checkId}:attempt`), fence: 1 });
      const project = makeClaim('project.discovery_item@1', { project_id: 'journalservice', root: '.' }, 'project');
      const structural = providers.createProofStructuralInventoryProviderFromCapability(capability);
      const structuralRun = structural.startManaged({ prInfo, checkConfig: { type: 'proof-structural-inventory', consumes: [], emits: [] }, dependencyResults: new Map(), executionContext: { claims: { project } }, binding: binding('structural_inventory'), executionConfigDigest: '1'.repeat(64), workingDirectory: root });
      await expect(structuralRun.started).resolves.toMatchObject({ kind: 'started' });
      const structuralOutcome: any = await structuralRun.outcome;
      expect(structuralOutcome.kind).toBe('succeeded');
      await expect(structuralRun.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
      const inventory = makeClaim('proof.structural_inventory@1', structuralOutcome.summary.output, 'structural_inventory', [project.claimId]);
      // This direct-provider lifecycle intentionally exercises the historical
      // generic materializer surface. Keep its fixture free of Proof-owned
      // signed-zero bytes; the managed graph path below is the authoritative
      // Proof-wire fidelity regression.
      const candidatePayload = fakeDiscovery({} as GovernedProbeRunnerRequest).data;
      const alphaFixture = candidatePayload.components.find(component => component.id === 'alpha');
      if (alphaFixture) alphaFixture.interfaces = alphaFixture.interfaces.map(value => Object.prototype.hasOwnProperty.call(value, 'n') ? { ...value, n: 0 } : value);
      let candidate = makeClaim('proof.candidate@1', candidatePayload, 'inspect', [project.claimId, inventory.claimId]);
      const candidateBytes = Buffer.from(proofCanonicalJson(candidatePayload), 'utf8');
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
        AttestationVersion: 'probe.governed-codex-attestation/v2', ExecutionSource: 'caller', ProbeInvocationDigest: 'sha256:' + '4'.repeat(64), IdentityVersion: 'probe.governed-result-identity/v1', IdentitySource: 'probe-host-schema-valid-json', ResultDigest: proofGovernedResultDigest(candidatePayload), CanonicalBytes: candidateBytes.length, ProbeResultBytes: candidateBytes.toString('base64'), VisorPayloadBytes: candidateBytes.toString('base64'),
        Publication: { Version: 1, Type: 'ClaimPublished', SessionID: 'session', CheckID: 'inspect', Scope: candidateBinding.Scope, NodeInstanceID: candidateBinding.NodeInstanceID, NodeGenerationID: candidateBinding.NodeGenerationID, AttemptID: candidateBinding.AttemptID, Fence: 1, ClaimID: candidate.claimId, Claim: candidate.claim, PayloadFingerprint: candidate.payloadFingerprint, ProducerCheckID: 'inspect', Payload: candidateBytes.toString('base64'), ParentClaimIDs: candidate.parentClaimIds },
        Binding: candidateBinding, Termination: candidateTermination,
      };
      let candidateEnvelopeWire = JSON.stringify(candidateEnvelope);
      candidate = {
        ...candidate,
        proofAdmission: {
          version: 'visor.proof-candidate-evidence/v1',
          role: { invocation: candidateEnvelope.Invocation, invocationDigest: candidateEnvelope.InvocationDigest },
          probe: {
            attestation: {
              version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1',
              requested: { profileDigest: 'a'.repeat(64), cwdDigest: 'a'.repeat(64), probeToolsDigest: 'a'.repeat(64), model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
              observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: 'a'.repeat(64), permissionProfileDigest: 'a'.repeat(64), filesystem: 'restricted-read-root', network: 'restricted' },
              executionContext: { source: 'caller', invocationDigest: candidateEnvelope.InvocationDigest },
              dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'a'.repeat(64)}`, promptBytes: 0 },
              evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
            },
            resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: proofGovernedResultDigest(candidatePayload), canonicalBytes: candidateBytes.length },
          },
        },
      };
      candidate = {
        ...candidate,
        claimId: sha256Canonical({
          claim: candidate.claim,
          payloadFingerprint: candidate.payloadFingerprint,
          producerCheckId: candidate.producerCheckId,
          scope: candidate.scope,
          attemptId: candidate.attemptId,
          fence: candidate.fence,
          parentClaimIds: [...candidate.parentClaimIds].sort(),
          proofCandidateEvidenceFingerprint: sha256Canonical(candidate.proofAdmission),
        }),
      };
      candidateEnvelope.Publication.ClaimID = candidate.claimId;
      candidateEnvelopeWire = JSON.stringify(candidateEnvelope);
      const admissionReceipt: Record<string, unknown> = {
        Version: 'proof.role-result-candidate-admission/v2', Status: 'ADMITTED',
        CandidateID: proofDomainDigest('proof.role-result-candidate-envelope/id/v1', candidateEnvelopeWire), ProbeResultDigest: proofGovernedResultDigest(candidatePayload), ProbeCanonicalBytes: candidateBytes.length,
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

  it('runs the checked-in component topology through real Proof C0, admission, replay, and checkpoint restore', async () => {
    expect(existsSync(PROOF_AUTHORITY)).toBe(true);
    const repository = mkdtempSync(join(tmpdir(), 'visor-exp0209-component-egress-'));
    const root = join(repository, 'nested-project');
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o700);
    writeFileSync(join(root, 'proof.yaml'), 'project:\n  name: journalservice\n', 'utf8');
    for (const name of ['alpha.go', 'beta.go', 'gamma.go']) writeFileSync(join(root, name), `package journal\n// ${name}\n`, 'utf8');
    const runSync = jest.requireActual<typeof import('node:child_process')>('node:child_process').execFileSync;
    runSync('git', ['init', '-q'], { cwd: repository });
    runSync('git', ['config', 'user.email', 'visor-exp0209@example.invalid'], { cwd: repository });
    runSync('git', ['config', 'user.name', 'Visor EXP-0209'], { cwd: repository });
    runSync('git', ['add', '.'], { cwd: repository });
    runSync('git', ['commit', '-qm', 'component egress fixture'], { cwd: repository });
    try {
      jest.resetModules();
      jest.doMock('child_process', () => jest.requireActual('child_process'));
      jest.doMock('node:child_process', () => jest.requireActual('node:child_process'));
      const config: any = yaml.load(readFileSync(PROFILE, 'utf8'));
      config.checks.project.value.projects[0].root = root;
      const [{ CheckProviderRegistry }, child, engineModule, governed] = await Promise.all([
        import('../../src/providers/check-provider-registry'),
        import('../../src/providers/proof-admission-cli-child'),
        import('../../src/state-machine-execution-engine'),
        import('../../src/providers/governed-proof-inspect-check-provider'),
      ]);
      const binary = pinnedProofBinary();
      const capability = child.createProofAdmissionCapability(binary);
      const directInventory = JSON.parse(runSync(binary, ['onboarding', 'inventory'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
      }));
      expect(directInventory.version).toBe('proof.structural-inventory/v1');
      const rootCheck = config.subgraphs['discover-project'].checks.inspect;
      const rootInvocation = {
        role_id: 'onboard',
        stance: 'owner',
        subject: { kind: 'project', id: directInventory.authority.project_id, fingerprint: directInventory.authority.subject_fingerprint },
        output_schema_id: rootCheck.invocation.output_schema_id,
        output_schema: rootCheck.invocation.output_schema,
      };
      const resolvedRoot = await child.resolveProofRoleInvocation(capability, rootInvocation, root);
      rootCheck.invocation = rootInvocation;
      rootCheck.instructions = resolvedRoot.instructions;
      rootCheck.invocation_digest = resolvedRoot.invocation_digest;
      rootCheck.result_schema = Buffer.from(rootInvocation.output_schema, 'base64').toString('utf8');
      const registry = CheckProviderRegistry.getInstance();
      registry.bootstrapProofAdmission(capability);
      const providers = Object.getOwnPropertyDescriptor(registry as any, 'providers')!.value as Map<string, unknown>;
      const originalGoverned = providers.get('governed-proof-inspect');
      let preserveSignedZero = true;
      let discoveryCalls = 0;
      const componentCalls: string[] = [];
      let releaseComponents!: () => void;
      const componentBarrier = new Promise<void>(resolve => { releaseComponents = resolve; });
      const fakeProbe = governed.createGovernedProofInspectProviderForFocusedTest((request: GovernedProbeRunnerRequest) => ({
        preview: () => ({ source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'a'.repeat(64)}`, promptBytes: 17 }),
        answer: async () => {
          const subject = request.invocation.subject as Record<string, unknown>;
          if (subject.kind === 'project') {
            discoveryCalls++;
            return fakeDiscovery(request, preserveSignedZero);
          }
          const authority = request.invocation.component_authority as Record<string, any>;
          const componentSubject = authority.subject as Record<string, any>;
          const componentId = componentSubject.component_id as string;
          componentCalls.push(componentId);
          if (new Set(componentCalls).size === 3) releaseComponents();
          await componentBarrier;
          return fakeComponent(request);
        },
        cancel: () => undefined,
        close: () => undefined,
      }), capability);
      providers.set('governed-proof-inspect', fakeProbe);
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const engine = new engineModule.StateMachineExecutionEngine(root);
        const running = engine.executeGroupedChecks(prInfo, ['project'], undefined, config, 'json', false, 3);
        const result = await Promise.race([
          running,
          new Promise<never>((_resolve, reject) => {
            watchdog = setTimeout(() => reject(new Error(`COMPONENT_EGRESS_WATCHDOG ${canonicalJson((engine as any)._lastContext?.journal?.readRuntimeEvents?.().slice(-12) || [])}`)), 30000);
          }),
        ]);
        if (watchdog) clearTimeout(watchdog);
        const journal = (engine as any)._lastContext.journal;
        const events: any[] = journal.readRuntimeEvents();
        expect(result.statistics.failedExecutions).toBe(0);
        expect(discoveryCalls).toBe(1);
        expect(componentCalls).toHaveLength(3);
        expect(new Set(componentCalls)).toEqual(new Set(['alpha', 'beta', 'gamma']));
        const published = (claim: string) => events.filter(event => event.type === 'ClaimPublished' && event.claim === claim);
        const inventories = published('proof.structural_inventory@1');
        const candidates = published('proof.candidate@1');
        const admissions = published('proof.admitted_receipt@1');
        const revalidations = published('proof.catalog_revalidation@1');
        const catalogs = published('component.catalog@1');
        const reconciliations = published('proof.project_reconciliation_receipt@1');
        expect(inventories).toHaveLength(1);
        expect(candidates).toHaveLength(4);
        expect(admissions).toHaveLength(4);
        expect(revalidations).toHaveLength(1);
        expect(catalogs).toHaveLength(1);
        expect(reconciliations).toHaveLength(1);
        expect(reconciliations[0].wireMode).toBe('proof');
        expect(reconciliations[0].payload.version).toBe('proof.project-reconciliation-receipt/v1');
        expect(reconciliations[0].payload.component_admissions).toHaveLength(3);
        expect(reconciliations[0].payload.covered_work_item_digests).toHaveLength(3);
        const componentCandidates = candidates.filter(event => event.scope.length === 2);
        const componentAdmissions = admissions.filter(event => event.scope.length === 2);
        const projectCandidates = candidates.filter(event => event.scope.length === 1);
        const projectAdmissions = admissions.filter(event => event.scope.length === 1);
        expect(new Set(componentCandidates.map(event => canonicalJson(event.scope))).size).toBe(3);
        expect(new Set(componentAdmissions.map(event => canonicalJson(event.scope))).size).toBe(3);
        expect(projectCandidates).toHaveLength(1);
        expect(projectAdmissions).toHaveLength(1);
        expect(inventories[0].wireMode).toBe('generic');
        expect(projectCandidates[0].wireMode).toBe('proof');
        expect(projectCandidates[0].proofCandidateEvidence.role.invocation.output_schema_id).toBe('proof.component-catalog-candidate@1');
        expect(revalidations[0].wireMode).toBe('proof');
        expect(Object.is(revalidations[0].payload.catalog.components[0].interfaces[1].n, -0)).toBe(true);
        const revalidationClaim = journal.getInstanceProjection().claimsById[revalidations[0].claimId];
        expect(revalidationClaim.payloadFingerprint).toBe(revalidations[0].payloadFingerprint);
        expect(Object.is(revalidationClaim.payload.catalog.components[0].interfaces[1].n, -0)).toBe(true);
        expect(componentCandidates.every(event => event.wireMode === 'generic')).toBe(true);
        expect(componentCandidates.map(event => event.proofCandidateEvidence.role.invocation.output_schema_id)).toEqual([
          'reqproof.component-onboarding/v1',
          'reqproof.component-onboarding/v1',
          'reqproof.component-onboarding/v1',
        ]);
        const projectReceipt = JSON.parse(projectAdmissions[0].payload.__proof_admission_wire).receipt;
        expect(projectReceipt.Version).toBe('proof.role-result-candidate-admission/v2');
        expect(Object.prototype.hasOwnProperty.call(projectReceipt, 'ProjectLineage')).toBe(true);
        for (const admission of componentAdmissions) {
          const receipt = JSON.parse(admission.payload.__proof_admission_wire).receipt;
          expect(receipt.Version).toBe('proof.role-result-candidate-admission/v1');
          expect(Object.prototype.hasOwnProperty.call(receipt, 'ProjectLineage')).toBe(false);
        }
        const validateReceipt = (engine as any)._lastContext.claimPlan.validatorsByClaim['proof.admitted_receipt@1'] as (value: unknown) => void;
        const componentReceipt = JSON.parse(componentAdmissions[0].payload.__proof_admission_wire).receipt;
        const projectWithoutLineage = { ...projectReceipt };
        delete projectWithoutLineage.ProjectLineage;
        expect(() => validateReceipt(projectWithoutLineage)).toThrow();
        expect(() => validateReceipt({ ...projectReceipt, Subject: { ...projectReceipt.Subject, kind: 'component' } })).toThrow();
        expect(() => validateReceipt({ ...componentReceipt, ProjectLineage: null })).toThrow();
        expect(() => validateReceipt({ ...componentReceipt, Subject: { ...componentReceipt.Subject, kind: 'project' } })).toThrow();
        const signedZero = projectCandidates[0].payload.components[0].interfaces[1].n;
        expect(Object.is(signedZero, -0)).toBe(true);
        expect(projectCandidates[0].payload.components[0].interfaces[0]['\uE000']).toBe('private-use');
        expect(projectCandidates[0].payload.components[0].interfaces[0]['\u{10000}']).toBe('astral');
        for (const admission of admissions) {
          const candidate = candidates.find(value => value.claimId === admission.parentClaimIds[0]);
          expect(candidate).toBeDefined();
          const wire = JSON.parse(admission.payload.__proof_admission_wire);
          expect(wire).toEqual(expect.objectContaining({ version: 'proof.role-result-candidate-cli-decision/v1', status: 'ADMITTED', reject_code: null }));
          expect(wire.receipt).toEqual(expect.objectContaining({ ClaimID: candidate.claimId, Claim: 'proof.candidate@1', Status: 'ADMITTED' }));
        }
        const expectedReconciliationParents = [
          revalidations[0].claimId,
          ...componentAdmissions.map(event => event.claimId),
        ].sort();
        expect(reconciliations[0].parentClaimIds).toEqual(expectedReconciliationParents);
        expect(reconciliations[0].payload.component_admissions.map((row: any) => row.component_id)).toEqual(['alpha', 'beta', 'gamma']);
        const inspectActivations = events.filter(event => event.type === 'NodeGenerationActivated' && event.checkId === 'inspect' && event.scope.length === 2);
        const verifyActivations = events.filter(event => event.type === 'NodeGenerationActivated' && event.checkId === 'verify' && event.scope.length === 2);
        expect(inspectActivations).toHaveLength(3);
        expect(verifyActivations).toHaveLength(3);
        for (const activation of inspectActivations) {
          const execution = journal.getGeneratedExecution(activation.nodeGenerationId);
          const authority = journal.getProofComponentInvocationAuthority(activation.nodeGenerationId);
          const component = execution.claims.component;
          const candidate = componentCandidates.find(value => canonicalJson(value.scope) === canonicalJson(activation.scope));
          const admission = componentAdmissions.find(value => canonicalJson(value.scope) === canonicalJson(activation.scope));
          expect(candidate).toBeDefined();
          expect(admission).toBeDefined();
          expect(authority.work_item.component_id).toBe(component.payload.component_id);
          expect(authority.subject.component_id).toBe(component.payload.component_id);
          expect(candidate.payload.project).toBe(authority.subject.project_id);
          expect(candidate.payload.shard).toBe(authority.subject.component_id);
          expect(candidate.payload.reviewedFiles.map((value: any) => value.path)).toEqual(authority.subject.sorted_owned_paths);
          expect(candidate.parentClaimIds).toContain(component.claimId);
          const verify = verifyActivations.find(value => canonicalJson(value.scope) === canonicalJson(activation.scope));
          expect(verify?.activeInputClaimIds).toEqual(expect.arrayContaining([candidate!.claimId, admission!.claimId]));
        }
        const replay = journal.replayInstanceProjection();
        expect(replay).toEqual(journal.getInstanceProjection());
        const replayRevalidation: any = replay.claimsById[revalidations[0].claimId];
        expect(replayRevalidation.claimId).toBe(revalidations[0].claimId);
        expect(replayRevalidation.payloadFingerprint).toBe(revalidations[0].payloadFingerprint);
        expect(Object.is(replayRevalidation.payload.catalog.components[0].interfaces[1].n, -0)).toBe(true);
        const replayProjectCandidate: any = replay.claimsById[projectCandidates[0].claimId];
        expect(Object.is(replayProjectCandidate.payload.components[0].interfaces[1].n, -0)).toBe(true);
        const sessionId = (engine as any)._lastContext.sessionId;
        const checkpoint = journal.exportGraphCheckpoint(sessionId);
        const { publishGraphCheckpointFile, readGraphCheckpointFile } = await import('../../src/graph-checkpoint-file');
        const { canonicalGraphCheckpointJson, ExecutionJournal } = await import('../../src/snapshot-store');
        const checkpointPath = join(root, 'component-egress-checkpoint.json');
        expect(statSync(root).mode & 0o777).toBe(0o700);
        publishGraphCheckpointFile(checkpoint, checkpointPath);
        expect(readFileSync(checkpointPath, 'utf8')).toContain(':-0');
        const restored = ExecutionJournal.restoreGraphCheckpoint((engine as any)._lastContext.claimPlan, readGraphCheckpointFile(checkpointPath));
        expect(restored.replayInstanceProjection()).toEqual(restored.getInstanceProjection());
        for (const activation of inspectActivations) {
          expect(restored.getProofComponentInvocationAuthority(activation.nodeGenerationId)).toEqual(journal.getProofComponentInvocationAuthority(activation.nodeGenerationId));
        }
        const restoredProjectCandidate: any = restored.getInstanceProjection().claimsById[projectCandidates[0].claimId];
        expect(Object.is(restoredProjectCandidate.payload.components[0].interfaces[1].n, -0)).toBe(true);
        const restoredRevalidation: any = restored.getInstanceProjection().claimsById[revalidations[0].claimId];
        expect(restoredRevalidation.claimId).toBe(revalidations[0].claimId);
        expect(restoredRevalidation.payloadFingerprint).toBe(revalidations[0].payloadFingerprint);
        expect(Object.is(restoredRevalidation.payload.catalog.components[0].interfaces[1].n, -0)).toBe(true);
        const restoredReconciliation: any = restored.getInstanceProjection().claimsById[reconciliations[0].claimId];
        expect(restoredReconciliation.payload).toEqual(reconciliations[0].payload);
        expect(restoredReconciliation.parentClaimIds).toEqual(expectedReconciliationParents);

        const cloneCheckpoint = (value: any): any => Array.isArray(value)
          ? value.map(cloneCheckpoint)
          : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneCheckpoint(child)]))
            : value;

        // A forged final receipt is rejected even when both the publication
        // identity and outer checkpoint integrity are recomputed.
        const forgedReconciliation = cloneCheckpoint(checkpoint);
        const forgedEvent = forgedReconciliation.events.find((event: any) => event.type === 'ClaimPublished' && event.claim === 'proof.project_reconciliation_receipt@1');
        expect(forgedEvent).toBeDefined();
        forgedEvent.payload.component_admissions[0].candidate_id = `sha256:${'f'.repeat(64)}`;
        forgedEvent.payloadFingerprint = proofPayloadFingerprint(forgedEvent.payload);
        forgedEvent.claimId = sha256Canonical({
          claim: forgedEvent.claim,
          payloadFingerprint: forgedEvent.payloadFingerprint,
          producerCheckId: forgedEvent.checkId,
          scope: forgedEvent.scope,
          attemptId: forgedEvent.attemptId,
          fence: forgedEvent.fence,
          parentClaimIds: [...forgedEvent.parentClaimIds].sort(),
        });
        const forgedBody = {
          kind: forgedReconciliation.kind,
          version: forgedReconciliation.version,
          sessionId: forgedReconciliation.sessionId,
          graphSemanticDigest: forgedReconciliation.graphSemanticDigest,
          frontier: forgedReconciliation.frontier,
          events: forgedReconciliation.events,
        };
        forgedReconciliation.integrity.digest = createHash('sha256').update(canonicalGraphCheckpointJson(forgedBody), 'utf8').digest('hex');
        expect(() => ExecutionJournal.restoreGraphCheckpoint((engine as any)._lastContext.claimPlan, forgedReconciliation)).toThrow(/reconciliation|receipt|identity|Proof authority replay/i);
        // Pre-wire-mode v1 checkpoints omitted generated wireMode. This
        // deliberately collapsed signed-zero payload is not accepted: strict
        // Proof lineage catches the byte loss before replay can proceed.
        const legacy = cloneCheckpoint(checkpoint);
        for (const event of legacy.events) {
          if (event.type === 'ClaimPublished' && event.nodeGenerationId) delete event.wireMode;
        }
        const legacyBody = {
          kind: legacy.kind,
          version: legacy.version,
          sessionId: legacy.sessionId,
          graphSemanticDigest: legacy.graphSemanticDigest,
          frontier: legacy.frontier,
          events: legacy.events,
        };
        legacy.integrity.digest = createHash('sha256').update(canonicalGraphCheckpointJson(legacyBody), 'utf8').digest('hex');
        expect(() => ExecutionJournal.restoreGraphCheckpoint((engine as any)._lastContext.claimPlan, legacy)).toThrow(/strict lineage|detached/i);

        // Rehashing a Proof revalidation publication must not turn a changed
        // catalog into an acceptable checkpoint. The outer integrity and the
        // publication identity are both recomputed so this exercises strict
        // candidate/admission/revalidation lineage, rather than only hashing.
        const tamperedRevalidation = cloneCheckpoint(checkpoint);
        const tamperedRevalidationEvent = tamperedRevalidation.events.find((event: any) => event.type === 'ClaimPublished' && event.claim === 'proof.catalog_revalidation@1');
        expect(tamperedRevalidationEvent).toBeDefined();
        tamperedRevalidationEvent.payload.catalog.components[0].interfaces[1].n = 0;
        tamperedRevalidationEvent.payloadFingerprint = proofPayloadFingerprint(tamperedRevalidationEvent.payload);
        tamperedRevalidationEvent.claimId = sha256Canonical({
          claim: tamperedRevalidationEvent.claim,
          payloadFingerprint: tamperedRevalidationEvent.payloadFingerprint,
          producerCheckId: tamperedRevalidationEvent.checkId,
          scope: tamperedRevalidationEvent.scope,
          attemptId: tamperedRevalidationEvent.attemptId,
          fence: tamperedRevalidationEvent.fence,
          parentClaimIds: [...tamperedRevalidationEvent.parentClaimIds].sort(),
        });
        const tamperedRevalidationBody = {
          kind: tamperedRevalidation.kind,
          version: tamperedRevalidation.version,
          sessionId: tamperedRevalidation.sessionId,
          graphSemanticDigest: tamperedRevalidation.graphSemanticDigest,
          frontier: tamperedRevalidation.frontier,
          events: tamperedRevalidation.events,
        };
        tamperedRevalidation.integrity.digest = createHash('sha256').update(canonicalGraphCheckpointJson(tamperedRevalidationBody), 'utf8').digest('hex');
        expect(() => ExecutionJournal.restoreGraphCheckpoint((engine as any)._lastContext.claimPlan, tamperedRevalidation)).toThrow(/strict lineage|catalog|revalidation/i);

        const restoredAdmissions = Object.values(restored.getInstanceProjection().claimsById).filter((value: any) => value.claim === 'proof.admitted_receipt@1');
        expect(restoredAdmissions).toHaveLength(4);
        expect(restoredAdmissions.map((value: any) => value.payload)).toEqual(expect.arrayContaining(admissions.map(value => value.payload)));
        const tampered = JSON.parse(JSON.stringify(checkpoint));
        const tamperedCandidate = tampered.events.find((event: any) => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1' && event.scope.length === 1);
        tamperedCandidate.payload.components[0].interfaces[1].n = 0;
        const tamperedBody = {
          kind: tampered.kind,
          version: tampered.version,
          sessionId: tampered.sessionId,
          graphSemanticDigest: tampered.graphSemanticDigest,
          frontier: tampered.frontier,
          events: tampered.events,
        };
        tampered.integrity.digest = createHash('sha256').update(canonicalGraphCheckpointJson(tamperedBody), 'utf8').digest('hex');
        expect(() => ExecutionJournal.restoreGraphCheckpoint((engine as any)._lastContext.claimPlan, tampered)).toThrow();

        // A pre-wire-mode reserved revalidation may migrate with an explicit
        // generic marker only when its historical Proof bytes have no semantic
        // distinction from the generic canonical bytes. The live compiled lane
        // above still publishes Proof mode; this is restore-only compatibility.
        preserveSignedZero = false;
        discoveryCalls = 0;
        componentCalls.splice(0, componentCalls.length);
        const safeEngine = new engineModule.StateMachineExecutionEngine(root);
        const safeResult = await safeEngine.executeGroupedChecks(prInfo, ['project'], undefined, config, 'json', false, 3);
        expect(safeResult.statistics.failedExecutions).toBe(0);
        const safeJournal = (safeEngine as any)._lastContext.journal;
        const safeRevalidation = safeJournal.readRuntimeEvents().find((event: any) => event.type === 'ClaimPublished' && event.claim === 'proof.catalog_revalidation@1');
        expect(safeRevalidation?.wireMode).toBe('proof');
        const safeCheckpoint = cloneCheckpoint(safeJournal.exportGraphCheckpoint((safeEngine as any)._lastContext.sessionId));
        const safeRevalidationWire = safeCheckpoint.events.find((event: any) => event.type === 'ClaimPublished' && event.claim === 'proof.catalog_revalidation@1');
        expect(safeRevalidationWire).toBeDefined();
        safeRevalidationWire.wireMode = 'generic';
        const safeBody = {
          kind: safeCheckpoint.kind,
          version: safeCheckpoint.version,
          sessionId: safeCheckpoint.sessionId,
          graphSemanticDigest: safeCheckpoint.graphSemanticDigest,
          frontier: safeCheckpoint.frontier,
          events: safeCheckpoint.events,
        };
        safeCheckpoint.integrity.digest = createHash('sha256').update(canonicalGraphCheckpointJson(safeBody), 'utf8').digest('hex');
        const safeRestored = ExecutionJournal.restoreGraphCheckpoint((safeEngine as any)._lastContext.claimPlan, safeCheckpoint);
        expect(safeRestored.readRuntimeEvents().find((event: any) => event.type === 'ClaimPublished' && event.claim === 'proof.catalog_revalidation@1')?.wireMode).toBe('generic');
        expect(safeRestored.getInstanceProjection().claimsById[safeRevalidation.claimId].payload).toEqual(safeJournal.getInstanceProjection().claimsById[safeRevalidation.claimId].payload);
      } finally {
        if (watchdog) clearTimeout(watchdog);
        providers.set('governed-proof-inspect', originalGoverned);
        CheckProviderRegistry.clearInstance();
      }
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }, 180000);

  it('accepts the retained Attempt-003 HTTP candidate shape at the widened 16-item cap', () => {
    // Portable shape oracle for retained Attempt-003 HTTP final: rollout SHA-256
    // 079d2f301e069b8e6c11594e4189d99052ef8d5f3db07fb0ede94262c1c11ed1;
    // final JSON SHA-256 6c52614628dc2ecbf0d87288f942c6f9948373461ee90d0397b6f7f28f20ac11 (12801 bytes), 4/4/4/3 IDs.
    const config: any = yaml.load(readFileSync(PROFILE, 'utf8'));
    const claimSchema = config.claim_types['proof.candidate@1'].schema.oneOf.find((schema: any) => schema.properties?.requirements);
    const invocationBytes = Buffer.from(config.subgraphs['onboard-component'].checks.inspect.invocation.output_schema, 'base64').toString('utf8');
    expect(invocationBytes).toBe(JSON.stringify(claimSchema));
    expect(createHash('sha256').update(invocationBytes).digest('hex')).toBe('049c5872c0f7eff8d4524acae058f05d4659cfabef73d45665306f19633759a6');
    expect(claimSchema.properties.requirements.maxItems).toBe(16);
    expect(config.claim_types['project.catalog@1'].schema.properties.projects.maxItems).toBe(1);
    expect(claimSchema.properties.interfaces.maxItems).toBe(32);
    const coordinate = () => [{ path: 'http.go', line: 1 }];
    const prefixes = ['STK', 'SYS', 'SW', 'INT'];
    const requirements = prefixes.flatMap(prefix => Array.from({ length: prefix === 'INT' ? 3 : 4 }, (_, index) => ({ id: `${prefix}-ATTEMPT003-${index}`, text: `Requirement ${prefix}-${index}`, coordinates: coordinate() })));
    expect(requirements).toHaveLength(15);
    const candidate = { schema: 'reqproof.component-onboarding/v1', project: 'journalservice', shard: 'http-api', reviewedFiles: [{ path: 'http.go', coordinates: coordinate() }], requirements, interfaces: [], findings: [], unknowns: [], repositoryMutated: false, commandsExecuted: false, checklistCompleted: false };
    const validate = compileClaimSchema(claimSchema);
    expect(() => validate(candidate)).not.toThrow();
    const seventeen = [...requirements, { ...requirements[0], id: 'STK-ATTEMPT003-EXTRA-1' }, { ...requirements[0], id: 'STK-ATTEMPT003-EXTRA-2' }];
    expect(seventeen).toHaveLength(17);
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true });
    addFormats(ajv);
    const oldSchema = JSON.parse(JSON.stringify(claimSchema));
    oldSchema.properties.requirements.maxItems = 12;
    const oldValidate = ajv.compile(oldSchema);
    expect(oldValidate(candidate)).toBe(false);
    expect(oldValidate.errors?.map(error => ({ keyword: error.keyword, instancePath: error.instancePath, limit: (error.params as any).limit }))).toEqual([{ keyword: 'maxItems', instancePath: '/requirements', limit: 12 }]);
    const newValidate = ajv.compile(claimSchema);
    expect(newValidate({ ...candidate, requirements: seventeen })).toBe(false);
    expect(newValidate.errors?.map(error => ({ keyword: error.keyword, instancePath: error.instancePath, limit: (error.params as any).limit }))).toEqual([{ keyword: 'maxItems', instancePath: '/requirements', limit: 16 }]);
    expect(() => validate({ ...candidate, requirements: seventeen })).toThrow(/more than 16 items/);
  });
});
