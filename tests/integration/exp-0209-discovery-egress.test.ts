import { describe, expect, it, jest } from '@jest/globals';
jest.unmock('child_process');
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
const prInfo = { number: 1, title: 'EXP-0209', author: 'test', base: 'main', head: 'demo', files: [], totalAdditions: 0, totalDeletions: 0, eventType: 'manual' } as PRInfo;

function providerMap(registry: CheckProviderRegistry): Map<string, CheckProvider> { return Object.getOwnPropertyDescriptor(registry as any, 'providers')!.value as Map<string, CheckProvider>; }
type ComponentTimelineEvent = { component: string; stage: 'stage1-start' | 'stage1-finish' | 'stage2-start' | 'stage2-finish'; at: number };
class TimedComponentProvider extends CheckProvider {
  constructor(private readonly timeline: ComponentTimelineEvent[]) { super(); }
  getName(): string { return 'timed-component'; }
  getDescription(): string { return 'Focused integration provider with observable two-stage component work'; }
  async validateConfig(config: unknown): Promise<boolean> { return !!config && typeof config === 'object' && (config as any).type === this.getName(); }
  async isAvailable(): Promise<boolean> { return true; }
  getRequirements(): string[] { return []; }
  getSupportedConfigKeys(): string[] { return ['type', 'consumes', 'emits']; }
  async execute(_pr: PRInfo, _config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, context?: ExecutionContext): Promise<ReviewSummary> {
    const payload = context?.claims?.component?.payload as Record<string, unknown> | undefined;
    const component = typeof payload?.component_id === 'string' ? payload.component_id : '';
    if (!component) throw new Error('missing component WorkItem');
    const durations: Record<string, readonly [number, number]> = { alpha: [120, 30], beta: [15, 30], gamma: [15, 30] };
    const [first, second] = durations[component] || [15, 15];
    const mark = (stage: ComponentTimelineEvent['stage']) => this.timeline.push({ component, stage, at: Date.now() });
    mark('stage1-start'); await new Promise(resolve => setTimeout(resolve, first)); mark('stage1-finish');
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
function canon(v){if(Array.isArray(v))return '['+v.map(canon).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';return JSON.stringify(v)}
function digest(domain,bytes){const n=Buffer.alloc(8);n.writeBigUInt64BE(BigInt(bytes.length));return 'sha256:'+crypto.createHash('sha256').update(domain).update(Buffer.from([0])).update(n).update(bytes).digest('hex')}
function sha(bytes){return 'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')}
function fileHash(path){return sha(fs.readFileSync(root+'/'+path))}
function inventory(){return {version:'proof.structural-inventory/v1',authority:{version:'proof.project-authority/v1',project_id:'journalservice',subject_fingerprint:'sha256:'+'1'.repeat(64),code_fingerprint:'sha256:'+'2'.repeat(64),tests_fingerprint:'sha256:'+'3'.repeat(64)},sorted_paths:['alpha.go','beta.go','gamma.go'],sorted_module_paths:[],boundary_fingerprint:'sha256:'+'8'.repeat(64),input_state:['alpha.go','beta.go','gamma.go'].map(path=>({owner_kind:'onboarding_structural_inventory',owner_id:'journalservice',input_kind:'code',path,file_hash:fileHash(path)}))}}
function item(component){const id=component.id,paths=[...component.owned_paths].sort(),closure=[...(component.dependency_closure||component.owned_paths)].sort();const subject={version:'proof.component-subject/v1',project_id:'journalservice',component_id:id,sorted_owned_paths:paths,sorted_dependency_closure:closure,fingerprint:'sha256:'+'4'.repeat(64)};return {version:'reqproof.onboarding-component-work-item/v1',project_id:'journalservice',component_id:id,sorted_owned_paths:paths,sorted_dependency_closure:closure,proof_path_mapping:{paths,components:[id],owner:'onboard',risk_tier:0,enforcement:'soft'},proof_input_state:closure.map(path=>({owner_kind:'onboarding_component',owner_id:id,input_kind:'code',path,file_hash:fileHash(path)})),proof_component_subject:subject}}
function catalog(candidate){return {version:candidate.version,project_id:candidate.project_id,components:[...candidate.components].sort((a,b)=>a.id.localeCompare(b.id)).map(component=>{const out={id:component.id,responsibility:component.responsibility,owned_paths:[...component.owned_paths].sort(),dependency_closure:[...(component.dependency_closure||component.owned_paths)].sort()};for(const key of ['entry_points','state_effects','interfaces','uncertainty'])if(component[key]&&component[key].length)out[key]=key==='interfaces'?component[key]:[...component[key]].sort();return out})}}
function receipt(projection, candidate, admission){const items=projection.work_items;const authorities=items.map(value=>({component_id:value.component_id,work_item_digest:sha(Buffer.from(JSON.stringify(value))),subject:value.proof_component_subject})).sort((a,b)=>a.component_id.localeCompare(b.component_id));const inv=projection.inventory;const r={version:'proof.catalog-revalidation-receipt/v1',decision:'accepted',project_id:'journalservice',project_fingerprint:inv.authority.subject_fingerprint,boundary_fingerprint:inv.boundary_fingerprint,inventory_claim_id:digest('proof.structural-inventory/claim/v1',Buffer.from(JSON.stringify(inv))),catalog_claim_id:digest('proof.component-catalog-candidate/claim/v1',Buffer.from(JSON.stringify(candidate))),admission_candidate_id:admission.receipt.CandidateID,admission_result_digest:admission.receipt.ProbeResultDigest,admission_receipt_id:admission.receipt.receipt_id,component_authorities:authorities,receipt_id:''};r.receipt_id=digest('proof.catalog-revalidation-receipt/id/v1',Buffer.from(JSON.stringify(r)));return r}
process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{try{const args=process.argv.slice(2).join(' ');if(args==='onboarding inventory'){if(input!=='')throw new Error('inventory accepts no stdin');const o=inventory();process.stdout.write(JSON.stringify(o,null,2)+'\\n');return}if(args==='admit-candidate'){const req=JSON.parse(input),c=req.candidate,p=c.Publication;const unsigned={Version:'proof.role-result-candidate-admission/v1',Status:'ADMITTED',CandidateID:digest('proof.role-result-candidate-envelope/id/v1',Buffer.from(JSON.stringify(c))),ProbeResultDigest:c.ResultDigest,ProbeCanonicalBytes:c.CanonicalBytes,ClaimID:p.ClaimID,Claim:p.Claim,PayloadFingerprint:p.PayloadFingerprint,InvocationDigest:c.InvocationDigest,RoleID:c.RoleID,Stance:c.Stance,Subject:c.Subject,ProducerCheckID:p.ProducerCheckID,ParentClaimIDs:p.ParentClaimIDs,Binding:c.Binding,Termination:c.Termination};const receipt={...unsigned,receipt_id:digest('proof.role-result-candidate-receipt/id/v1',Buffer.from(JSON.stringify(unsigned)))};const o={version:'proof.role-result-candidate-cli-decision/v1',status:'ADMITTED',receipt,reject_code:null};process.stdout.write(JSON.stringify(o)+'\\n');return}if(args==='onboarding revalidate'){const req=JSON.parse(input),candidate=req.candidate,admission=req.admission,inv=inventory(),items=candidate.components.map(item),o={version:'proof.catalog-revalidation/v1',inventory:inv,catalog:catalog(candidate),work_items:items,receipt:null};o.receipt=receipt(o,candidate,admission);process.stdout.write(JSON.stringify(o,null,2)+'\\n');return}throw new Error('unsupported command '+args)}catch(e){process.stderr.write(String(e));process.exitCode=1}});`;
  writeFileSync(proof, script, 'utf8'); chmodSync(proof, 0o755);
  return Promise.resolve(fn(proof, root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('EXP-0209 admitted discovery egress', () => {
  it('settles both new managed Proof providers and reaps their process groups', async () => {
    await withProofFixture(async (proof, root) => {
      const [{ createProofAdmissionCapability }, providers] = await Promise.all([
        import('../../src/providers/proof-admission-cli-child'),
        import('../../src/providers/proof-catalog-check-providers'),
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
      const admission = makeClaim('proof.admitted_receipt@1', {
        Version: 'proof.role-result-candidate-admission/v1', Status: 'ADMITTED',
        CandidateID: 'sha256:' + '1'.repeat(64), ProbeResultDigest: 'sha256:' + '2'.repeat(64),
        ClaimID: candidate.claimId, Claim: candidate.claim, PayloadFingerprint: candidate.payloadFingerprint,
        ProducerCheckID: 'inspect', ParentClaimIDs: candidate.parentClaimIds,
        receipt_id: 'sha256:' + '3'.repeat(64),
      }, 'proof_admit', [candidate.claimId]);
      const revalidator = providers.createProofCatalogRevalidationProviderFromCapability(capability);
      const revalidationRun = revalidator.startManaged({ prInfo, checkConfig: { type: 'proof-catalog-revalidate', consumes: [], emits: [] }, dependencyResults: new Map(), executionContext: { claims: { current_inventory: inventory, candidate, receipt: admission } }, binding: binding('revalidate_catalog'), executionConfigDigest: '2'.repeat(64), workingDirectory: root });
      await expect(revalidationRun.started).resolves.toMatchObject({ kind: 'started' });
      await expect(revalidationRun.outcome).resolves.toMatchObject({ kind: 'succeeded', summary: { output: { version: 'proof.catalog-revalidation/v1' } } });
      await expect(revalidationRun.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
      const pids = existsSync(join(root, 'pids')) ? readFileSync(join(root, 'pids'), 'utf8').trim().split('\n').map(Number) : [];
      expect(pids).toHaveLength(2);
      expect(readFileSync(join(root, 'commands'), 'utf8').trim().split('\n')).toEqual(['onboarding inventory', 'onboarding revalidate']);
      for (const pid of pids) expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    });
  });

  it('executes authored providers through the native scheduler and replays independent keyed fanout', async () => {
    await withProofFixture(async (proof, root) => {
      const config: any = yaml.load(readFileSync(PROFILE, 'utf8'));
      config.subgraphs['onboard-component'].checks.inspect.type = 'timed-component';
      const [{ CheckProviderRegistry }, { createProofAdmissionCapability }, { StateMachineExecutionEngine }] = await Promise.all([
        import('../../src/providers/check-provider-registry'),
        import('../../src/providers/proof-admission-cli-child'),
        import('../../src/state-machine-execution-engine'),
      ]);
      const registry = CheckProviderRegistry.getInstance(); const providers = providerMap(registry); const original = [...providers.entries()]; let discoveryCalls = 0;
      const timeline: ComponentTimelineEvent[] = [];
      providers.set('timed-component', new TimedComponentProvider(timeline));
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
        const components = Object.values(journal.getInstanceProjection().instancesById).filter((value: any) => value.scope.length === 2) as any[];
        expect(components.map(value => value.itemKey).sort()).toEqual(['alpha', 'beta', 'gamma']);
        const event = (component: string, stage: ComponentTimelineEvent['stage']) => timeline.find(value => value.component === component && value.stage === stage)?.at;
        const starts = ['alpha', 'beta', 'gamma'].map(component => event(component, 'stage1-start'));
        expect(starts.every(value => value !== undefined)).toBe(true);
        expect(Math.max(...starts as number[]) - Math.min(...starts as number[])).toBeLessThan(80);
        expect(event('beta', 'stage2-start')).toBeLessThan(event('alpha', 'stage1-finish') as number);
        expect(event('gamma', 'stage2-start')).toBeLessThan(event('alpha', 'stage1-finish') as number);
        expect(journal.replayInstanceProjection()).toEqual(journal.getInstanceProjection());
      } finally { if (watchdog) clearTimeout(watchdog); providers.clear(); for (const entry of original) providers.set(entry[0], entry[1]); CheckProviderRegistry.clearInstance(); }
    });
  });
});
