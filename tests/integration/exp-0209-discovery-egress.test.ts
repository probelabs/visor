import { describe, expect, it, jest } from '@jest/globals';
jest.unmock('child_process');
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import type { PRInfo } from '../../src/pr-analyzer';
import type { CheckProvider } from '../../src/providers/check-provider.interface';
import type { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { createGovernedProofInspectProviderForFocusedTest, governedResultDigest, type GovernedProbeRunnerRequest } from '../../src/providers/governed-proof-inspect-check-provider';
import { canonicalJson, immutableCanonicalValue, sha256Canonical } from '../../src/state-machine/graph/claim-kernel';

const PROFILE = resolve(__dirname, '../../examples/agent-governance/exp-0209-discovery-egress/visor.yaml');
const prInfo = { number: 1, title: 'EXP-0209', author: 'test', base: 'main', head: 'demo', files: [], totalAdditions: 0, totalDeletions: 0, eventType: 'manual' } as PRInfo;

function providerMap(registry: CheckProviderRegistry): Map<string, CheckProvider> { return Object.getOwnPropertyDescriptor(registry as any, 'providers')!.value as Map<string, CheckProvider>; }
function fakeDiscovery(request: GovernedProbeRunnerRequest) {
  const data = { components: [{ component_id: 'alpha', responsibility: 'HTTP adapter' }, { component_id: 'beta', responsibility: 'service policy' }, { component_id: 'gamma', responsibility: 'storage domain' }] };
  const d = 'a'.repeat(64);
  return { data, runtimeAttestation: { version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' }, observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' }, executionContext: { source: 'caller', invocationDigest: request.invocationDigest }, dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${d}`, promptBytes: 17 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' } }, resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: governedResultDigest(data), canonicalBytes: Buffer.byteLength(canonicalJson(data)) } };
}
function withProofFixture<T>(fn: (proof: string, root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'visor-exp0209-')); const proof = join(root, 'proof');
  const script = `#!${process.execPath}
const fs=require('fs'),crypto=require('crypto');fs.appendFileSync(${JSON.stringify(join(root, 'pids'))},process.pid+'\\n');let input='';function canon(v){if(Array.isArray(v))return '['+v.map(canon).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';return JSON.stringify(v)}function digest(domain,bytes){const n=Buffer.alloc(8);n.writeBigUInt64BE(BigInt(bytes.length));return 'sha256:'+crypto.createHash('sha256').update(domain).update(Buffer.from([0])).update(n).update(bytes).digest('hex')}function item(id){const p={componentId:id,roleId:'onboard',subjectFingerprint:'sha256:'+'2'.repeat(64)};return {authority:{claim:'proof.component_role_authority@1',claimId:'3'.repeat(64),payload:p,payloadFingerprint:crypto.createHash('sha256').update(canon(p)).digest('hex')},component_id:id,project_id:'journalservice',proof_component_subject:{fingerprint:'sha256:'+'2'.repeat(64),id,kind:'component'},proof_input_state:[],proof_path_mapping:[],sorted_dependency_closure:[id+'.go'],sorted_owned_paths:[id+'.go']}}process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{try{const r=JSON.parse(input);let o;if(process.argv[2]==='structural-inventory'){o={boundary_fingerprint:'sha256:'+'8'.repeat(64),package_identities:['journalservice'],project_id:r.project.payload.project_id,revision_fingerprint:'sha256:'+'9'.repeat(64),source_paths:['alpha.go','beta.go','gamma.go'],version:'proof.structural-inventory/v1'};process.stdout.write(canon(o)+'\\n');return}if(process.argv[2]==='admit-candidate'){const c=r.candidate,p=c.Publication,u={Version:'proof.role-result-candidate-admission/v1',Status:'ADMITTED',CandidateID:digest('proof.role-result-candidate-envelope/id/v1',Buffer.from(JSON.stringify(c))),ProbeResultDigest:c.ResultDigest,ProbeCanonicalBytes:c.CanonicalBytes,ClaimID:p.ClaimID,Claim:p.Claim,PayloadFingerprint:p.PayloadFingerprint,InvocationDigest:c.InvocationDigest,RoleID:c.RoleID,Stance:c.Stance,Subject:c.Subject,ProducerCheckID:p.ProducerCheckID,ParentClaimIDs:p.ParentClaimIDs,Binding:c.Binding,Termination:c.Termination};o={version:'proof.role-result-candidate-cli-decision/v1',status:'ADMITTED',receipt:{...u,receipt_id:digest('proof.role-result-candidate-receipt/id/v1',Buffer.from(JSON.stringify(u)))},reject_code:null};process.stdout.write(JSON.stringify(o)+'\\n');return}if(process.argv[2]==='catalog-revalidate'){const i=r.inventory,c=r.candidate,a=r.admission;o={admission_receipt_claim_id:a.claimId,boundary_fingerprint:i.payload.boundary_fingerprint,candidate_claim_id:c.claimId,candidate_payload_fingerprint:c.payloadFingerprint,revision_fingerprint:i.payload.revision_fingerprint,status:'ACCEPTED',structural_inventory_claim_id:i.claimId,version:'proof.catalog-revalidation/v1',work_items:['alpha','beta','gamma'].map(item)};process.stdout.write(canon(o)+'\\n');return}throw new Error('unsupported command')}catch(e){process.stderr.write(String(e));process.exitCode=1}});`;
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
      const candidate = makeClaim('proof.candidate@1', { components: [{ component_id: 'alpha' }, { component_id: 'beta' }] }, 'inspect', [project.claimId, inventory.claimId]);
      const admission = makeClaim('proof.admitted_receipt@1', { Status: 'ADMITTED' }, 'proof_admit', [candidate.claimId]);
      const revalidator = providers.createProofCatalogRevalidationProviderFromCapability(capability);
      const revalidationRun = revalidator.startManaged({ prInfo, checkConfig: { type: 'proof-catalog-revalidate', consumes: [], emits: [] }, dependencyResults: new Map(), executionContext: { claims: { current_inventory: inventory, candidate, receipt: admission } }, binding: binding('revalidate_catalog'), executionConfigDigest: '2'.repeat(64), workingDirectory: root });
      await expect(revalidationRun.started).resolves.toMatchObject({ kind: 'started' });
      await expect(revalidationRun.outcome).resolves.toMatchObject({ kind: 'succeeded', summary: { output: { status: 'ACCEPTED' } } });
      await expect(revalidationRun.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
      const pids = existsSync(join(root, 'pids')) ? readFileSync(join(root, 'pids'), 'utf8').trim().split('\n').map(Number) : [];
      expect(pids).toHaveLength(2);
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
          }, 1000); }),
        ]);
        if (watchdog) clearTimeout(watchdog);
        const journal = (engine as any)._lastContext.journal; const events: any[] = journal.readRuntimeEvents();
        expect(result.statistics.failedExecutions).toBe(0); expect(discoveryCalls).toBe(1);
        const published = (claim: string) => events.findIndex(event => event.type === 'ClaimPublished' && event.claim === claim);
        const inventory = published('proof.structural_inventory@1'), candidate = published('proof.candidate@1'), admission = published('proof.admitted_receipt@1'), revalidation = published('proof.catalog_revalidation@1'), catalog = published('component.catalog@1');
        expect(inventory).toBeGreaterThan(-1); expect(candidate).toBeGreaterThan(inventory); expect(admission).toBeGreaterThan(candidate); expect(revalidation).toBeGreaterThan(admission); expect(catalog).toBeGreaterThan(revalidation);
        const components = Object.values(journal.getInstanceProjection().instancesById).filter((value: any) => value.scope.length === 2) as any[];
        expect(components.map(value => value.itemKey).sort()).toEqual(['alpha', 'beta', 'gamma']); expect(journal.replayInstanceProjection()).toEqual(journal.getInstanceProjection());
      } finally { if (watchdog) clearTimeout(watchdog); providers.clear(); for (const entry of original) providers.set(entry[0], entry[1]); CheckProviderRegistry.clearInstance(); }
    });
  });
});
