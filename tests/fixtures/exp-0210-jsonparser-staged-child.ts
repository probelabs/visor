import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import type { PRInfo } from '../../src/pr-analyzer';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import type { GovernedProbeRunnerRequest } from '../../src/providers/governed-proof-inspect-check-provider';
import { createGovernedProofInspectProviderForFocusedTest } from '../../src/providers/governed-proof-inspect-check-provider';
import { governedResultDigest, proofCanonicalJson, immutableProofCanonicalValue } from '../../src/providers/proof-wire';
import { ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import { canonicalJson, immutableCanonicalValue } from '../../src/state-machine/graph/claim-kernel';
import { validateProofCurrentCatalogAuthorityBytes } from '../../src/providers/proof-catalog-check-providers';
import { createProofAdmissionCapability } from '../../src/providers/proof-admission-cli-child';

type Any = Record<string, any>;
const PROFILE = path.resolve(__dirname, '../../examples/agent-governance/exp-0210-jsonparser-staged/visor.yaml');
const PR: PRInfo = { number: 210, title: 'jsonparser staged demo', author: 'fixture', base: 'baseline', head: 'fixed', files: [], totalAdditions: 0, totalDeletions: 0, eventType: 'manual' };
const changedPaths = ['parser.go', 'parser_test.go'];

function invoke(binary: string, cwd: string, args: string[], input = ''): Any {
  return JSON.parse(execFileSync(binary, args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' } }));
}

function sortPaths(values: readonly string[]): string[] {
  return [...values].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

function digest(value: unknown): string { return createHash('sha256').update(proofCanonicalJson(value)).digest('hex'); }

function groupsFromInventory(inventory: Any): Any[] {
  const paths = sortPaths((inventory.sorted_paths || []).map(String));
  const units: string[][] = [];
  const used = new Set<string>();
  for (const file of paths) {
    if (used.has(file)) continue;
    const sibling = file.endsWith('.go') && !file.endsWith('_test.go') ? `${file.slice(0, -3)}_test.go` : undefined;
    const unit = sibling && paths.includes(sibling) ? [file, sibling] : [file];
    unit.forEach(value => used.add(value));
    units.push(sortPaths(unit));
  }
  while (units.length > 4) {
    const right = units.pop()!;
    units[units.length - 1] = sortPaths([...units[units.length - 1], ...right]);
  }
  return units.map(owned => ({
    id: `component-${digest(owned).slice(0, 16)}`,
    responsibility: `independently onboardable source family (${owned.join(', ')})`,
    owned_paths: owned,
    dependency_closure: owned,
    entry_points: owned.filter(value => value.endsWith('.go')),
    state_effects: [],
    interfaces: [],
    uncertainty: [],
  })).sort((a, b) => Buffer.from(a.id).compare(Buffer.from(b.id)));
}

function fakeDiscovery(request: GovernedProbeRunnerRequest, components: Any[]): Any {
  const project = (request.invocation.subject as Any).id;
  const data = immutableProofCanonicalValue({ version: 'proof.component-catalog-candidate/v1', project_id: project, components });
  const bytes = proofCanonicalJson(data);
  return { data, runtimeAttestation: attestation(request), resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: governedResultDigest(data, 'proof'), canonicalBytes: Buffer.byteLength(bytes, 'utf8') } };
}

function fakeComponent(request: GovernedProbeRunnerRequest): Any {
  const roleId = String(request.invocation.role_id);
  if (roleId !== 'onboard' && roleId !== 'spec-review') throw new Error(`unsupported component role ${roleId}`);
  const subject = (request.invocation.component_authority as Any).subject;
  const files = subject.sorted_owned_paths as string[];
  const coordinate = (file: string) => ({ path: file, line: 1 });
  const data = immutableCanonicalValue({
    schema: 'reqproof.component-onboarding/v1', project: subject.project_id, shard: subject.component_id,
    reviewedFiles: files.map(path => ({ path, coordinates: [coordinate(path)] })),
    requirements: ['STK', 'SYS', 'SW', 'INT'].map((kind, i) => ({ id: `${kind}-${subject.component_id}-${roleId}-${i + 1}`, text: `${kind} ${roleId} evidence`, coordinates: [coordinate(files[0])] })),
    interfaces: [{ name: `${subject.component_id}-${roleId}-boundary`, coordinates: [coordinate(files[0])] }],
    findings: [{ id: `finding-${subject.component_id}-${roleId}`, severity: 'info', title: `${roleId} has no blocking finding`, calibration: 'confirmed', confidence: 1, coordinates: [coordinate(files[0])] }],
    unknowns: [], repositoryMutated: false, commandsExecuted: false, checklistCompleted: false,
  });
  return { data, runtimeAttestation: attestation(request), resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: governedResultDigest(data, 'generic'), canonicalBytes: Buffer.byteLength(canonicalJson(data), 'utf8') } };
}

function attestation(request: GovernedProbeRunnerRequest): Any {
  const d = 'a'.repeat(64);
  return { version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' }, observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' }, executionContext: { source: 'caller', invocationDigest: request.invocationDigest }, dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${d}`, promptBytes: 0 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' } };
}

function installProbe(capability: object, components: Any[], calls: Any[]): () => void {
  const registry = CheckProviderRegistry.getInstance();
  const providers = Object.getOwnPropertyDescriptor(registry as any, 'providers')!.value as Map<string, unknown>;
  const previous = providers.get('governed-proof-inspect');
  const fake = createGovernedProofInspectProviderForFocusedTest((request: GovernedProbeRunnerRequest) => ({
    preview: () => ({ source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'a'.repeat(64)}`, promptBytes: 0 }),
    answer: async () => {
      const subject = request.invocation.subject as Any;
      if (subject.kind === 'project') return fakeDiscovery(request, components);
      calls.push(Object.freeze({ componentId: String((request.invocation.component_authority as Any).subject.component_id), roleId: String(request.invocation.role_id) }));
      return fakeComponent(request);
    }, cancel: () => undefined, close: () => undefined,
  }), capability);
  providers.set('governed-proof-inspect', fake);
  return () => { if (previous) providers.set('governed-proof-inspect', previous); else providers.delete('governed-proof-inspect'); CheckProviderRegistry.clearInstance(); };
}

function setupConfig(binary: string, workspace: string): Any {
  const config = yaml.load(fs.readFileSync(PROFILE, 'utf8')) as Any;
  const inventory = invoke(binary, workspace, ['onboarding', 'inventory']);
  const check = config.subgraphs['discover-project'].checks.inspect;
  const invocation = { role_id: 'onboard', stance: 'owner', subject: { kind: 'project', id: inventory.authority.project_id, fingerprint: inventory.authority.subject_fingerprint }, output_schema_id: check.invocation.output_schema_id, output_schema: check.invocation.output_schema };
  const resolved = invoke(binary, workspace, ['resolve-role-invocation'], JSON.stringify(invocation));
  check.invocation = invocation;
  check.instructions = resolved.instructions;
  check.invocation_digest = resolved.invocation_digest;
  check.result_schema = Buffer.from(invocation.output_schema, 'base64').toString('utf8');
  return config;
}

function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function project(checkpoint: Any, config: Any): Any { return ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection(); }

function candidateAndAdmission(checkpoint: Any): { candidate: Any; admission: Any } {
  const candidate = checkpoint.events.find((e: Any) => e.type === 'ClaimPublished' && e.claim === 'proof.candidate@1' && e.scope.length === 1);
  const admission = checkpoint.events.find((e: Any) => e.type === 'ClaimPublished' && e.claim === 'proof.admitted_receipt@1' && e.scope.length === 1);
  if (!candidate || !admission) throw new Error('project discovery candidate/admission missing');
  return { candidate, admission };
}

function candidateView(event: Any): Any {
  return { ...event, provenance: 'attempt', proofAdmission: event.proofCandidateEvidence, wireMode: event.wireMode };
}

function proofRefresh(binary: string, workspace: string, checkpoint: Any, config: Any): { revalidationBytes: string; workItemsBytes: string; changedComponentId: string } {
  const { candidate, admission } = candidateAndAdmission(checkpoint);
  const candidatePayload = candidate.payload as Any;
  const admissionPayload = admission.payload as Any;
  const revalidationRequest = proofCanonicalJson({ version: 'proof.catalog-revalidation-request/v2', candidate: candidatePayload, admission: JSON.parse(admissionPayload.__proof_admission_wire) });
  const revalidation = invoke(binary, workspace, ['onboarding', 'revalidate'], revalidationRequest);
  const revalidationBytes = proofCanonicalJson(revalidation);
  const workItemsRequest = `{"version":${proofCanonicalJson('proof.onboarding-work-items-request/v1')},"candidate":${proofCanonicalJson(candidatePayload)},"admission":${admissionPayload.__proof_admission_wire},"revalidation_receipt":${proofCanonicalJson(revalidation.receipt)}}`;
  const workItems = invoke(binary, workspace, ['onboarding', 'work-items'], workItemsRequest);
  const workItemsBytes = proofCanonicalJson(workItems);
  const before = project(checkpoint, config);
  const baseItems = Object.values(before.claimsById).filter((c: Any) => c.claim === 'component.work_item@1' && c.active && c.scope.length === 2).map((c: Any) => c.payload);
  const validated = validateProofCurrentCatalogAuthorityBytes({ revalidationBytesBase64: Buffer.from(revalidationBytes).toString('base64'), workItemsBytesBase64: Buffer.from(workItemsBytes).toString('base64'), candidate: candidateView(candidate), admission: { ...admission, provenance: 'attempt' } } as any);
  const after = [...validated.items] as Any[];
  const byBefore = new Map(baseItems.map(item => [item.component_id, item]));
  const changed = after.filter(item => canonicalJson(byBefore.get(item.component_id)) !== canonicalJson(item));
  if (changed.length !== 1) throw new Error(`Proof did not select exactly one changed WorkItem (${changed.length})`);
  const id = String(changed[0].component_id);
  const changedItem = changed[0];
  if (!changedPaths.every(file => changedItem.sorted_owned_paths.includes(file))) throw new Error('changed WorkItem does not own the overlay');
  return { revalidationBytes, workItemsBytes, changedComponentId: id };
}

async function runEngine(binary: string, workspace: string, config: Any, components: Any[], mode: 'full' | 'pause' | 'resume', checkpoint?: Any): Promise<Any> {
  const capability = createProofAdmissionCapability(binary);
  const calls: Any[] = [];
  const gateObservations: Any[] = [];
  CheckProviderRegistry.getInstance().bootstrapProofAdmission(capability);
  const restore = installProbe(capability, components, calls);
  try {
    const engine = new StateMachineExecutionEngine(workspace);
    if (mode === 'resume') return { ...(await engine.resumeGraphCheckpoint({ checkpoint, config, prInfo: PR, maxParallelism: 3 })), calls };
    const ordered = components.slice().sort((a, b) => Buffer.from(a.id).compare(Buffer.from(b.id)));
    const owners = ordered.filter(component => changedPaths.every(file => component.owned_paths.includes(file)));
    if (owners.length !== 1) throw new Error(`changed paths have ${owners.length} component owners`);
    const hold = ordered.find(component => !changedPaths.some(file => component.owned_paths.includes(file)))?.id;
    if (!hold) throw new Error('no unaffected component available for pause');
    const gate = mode === 'pause' ? (generation: Any) => {
      const componentId = generation.scope?.at(-1)?.key;
      const decision = componentId === hold ? 'defer' : 'dispatch';
      gateObservations.push(Object.freeze({ nodeGenerationId: generation.nodeGenerationId, checkId: generation.checkId, componentId: componentId || null, decision }));
      return decision;
    } : undefined;
    await engine.executeGroupedChecks(PR, ['project'], undefined, config, 'json', false, 3, false, undefined, gate);
    return { checkpoint: engine.exportGraphCheckpoint(), calls, gateObservations: Object.freeze([...gateObservations]) };
  } finally {
    restore();
  }
}

async function main(): Promise<void> {
  const [mode, payloadPath] = process.argv.slice(2);
  if (!['prepare', 'pause', 'resume', 'replacement'].includes(mode || '')) throw new Error('child mode must be prepare, pause, resume, or replacement');
  const payload = JSON.parse(payloadPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(payloadPath, 'utf8')) as Any;
  for (const key of ['proofBinary', 'workspace', 'configPath', 'outputPath']) {
    if (typeof payload[key] !== 'string' || payload[key].length === 0 || !path.isAbsolute(payload[key])) throw new Error(`child payload ${key} is invalid`);
  }
  if ((mode === 'resume' || mode === 'replacement') && (typeof payload.checkpointPath !== 'string' || !path.isAbsolute(payload.checkpointPath))) throw new Error('child checkpointPath is invalid');
  if (mode === 'prepare') {
    const config = setupConfig(payload.proofBinary, payload.workspace);
    const inventory = invoke(payload.proofBinary, payload.workspace, ['onboarding', 'inventory']);
    writeJson(payload.outputPath, { config, inventory, components: groupsFromInventory(inventory) });
    return;
  }
  const configured = JSON.parse(fs.readFileSync(payload.configPath, 'utf8')) as Any;
  const config = configured.config && typeof configured.config === 'object' ? configured.config : configured;
  const inventory = invoke(payload.proofBinary, payload.workspace, ['onboarding', 'inventory']);
  const components = groupsFromInventory(inventory);
  if (mode === 'replacement') {
    const source = JSON.parse(fs.readFileSync(payload.checkpointPath, 'utf8')) as Any;
    const refreshed = proofRefresh(payload.proofBinary, payload.workspace, source, config);
    const capability = createProofAdmissionCapability(payload.proofBinary);
    const calls: Any[] = [];
    CheckProviderRegistry.getInstance().bootstrapProofAdmission(capability);
    const restore = installProbe(capability, components, calls);
    try {
      const before = project(source, config);
      const projectInstance = Object.values(before.instancesById).find((instance: any) => instance.itemKey === 'jsonparser' && !instance.parentSubgraphInstanceId) as Any;
      if (!projectInstance) throw new Error('project instance missing from continuation checkpoint');
      const engine = new StateMachineExecutionEngine(payload.workspace);
      const continued = await engine.continueProofCurrentCatalogCheckpoint({ checkpoint: source, projectSubgraphInstanceId: projectInstance.subgraphInstanceId, revalidationBytes: refreshed.revalidationBytes, workItemsBytes: refreshed.workItemsBytes, config, prInfo: PR, maxParallelism: 3 });
      writeJson(payload.outputPath, { checkpoint: continued.checkpoint, calls, refreshed });
      return;
    } finally { restore(); }
  }
  if (mode === 'pause') {
    const paused = await runEngine(payload.proofBinary, payload.workspace, config, components, 'pause');
    writeJson(payload.outputPath, { checkpoint: paused.checkpoint, calls: paused.calls, gateObservations: paused.gateObservations, components });
    return;
  }
  const result = await runEngine(payload.proofBinary, payload.workspace, config, components, 'resume', JSON.parse(fs.readFileSync(payload.checkpointPath, 'utf8')));
  writeJson(payload.outputPath, { checkpoint: result.checkpoint, calls: result.calls, components });
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`); process.exitCode = 1; });
