import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJsonparserStagedDemo } from '../../examples/agent-governance/exp-0210-jsonparser-staged/run-demo';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';

type AnyRecord = Record<string, any>;
type Artifact = { source: string; value: AnyRecord };
const STAGES = ['inspect', 'proof_admit', 'spec_review', 'spec_review_admit', 'verify'];
const JSONPARSER_SOURCE_PATHS = [
  'bytes.go', 'bytes_safe.go', 'bytes_test.go', 'bytes_unsafe.go',
  'bytes_unsafe_test.go', 'escape.go', 'escape_test.go', 'fuzz.go',
  'go.mod', 'go.sum', 'parser.go', 'parser_error_test.go', 'parser_test.go',
];

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function allFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const file = join(root, name);
    if (statSync(file).isDirectory()) out.push(...allFiles(file));
    else out.push(file);
  }
  return out;
}

function jsonArtifacts(root: string, report: AnyRecord): Artifact[] {
  const artifacts: Artifact[] = [{ source: 'returned-report', value: report }];
  for (const file of allFiles(root)) {
    if (!/\.(json|jsonl|ndjson)$/i.test(file)) continue;
    const text = readFileSync(file, 'utf8').trim();
    if (!text) continue;
    try {
      const value = JSON.parse(text);
      if (isRecord(value)) artifacts.push({ source: file, value });
    } catch {
      // Non-JSON artifacts are checked through their JSON references below.
    }
  }
  return artifacts;
}

function checkpointArtifacts(artifacts: Artifact[]): Artifact[] {
  const found: Artifact[] = [];
  const visit = (value: unknown, source: string): void => {
    if (!isRecord(value)) return;
    if (Array.isArray(value.events) && isRecord(value.frontier) && typeof value.sessionId === 'string') {
      found.push({ source, value });
    }
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && /checkpoint/i.test(key)) {
        try { visit(JSON.parse(child), `${source}.${key}`); } catch { /* malformed artifacts fail below */ }
      } else if (isRecord(child)) visit(child, `${source}.${key}`);
    }
  };
  for (const artifact of artifacts) visit(artifact.value, artifact.source);
  // Distinct published names are evidence in their own right: a complete
  // baseline and a continued checkpoint may intentionally have identical
  // bytes.  Keep them separate so namedCheckpoint can enforce uniqueness per
  // required artifact name.
  return found;
}

function namedCheckpoint(all: Artifact[], pattern: RegExp, otherwise?: (value: AnyRecord) => boolean): AnyRecord {
  const matches = all.filter(artifact => pattern.test(artifact.source) && (!otherwise || otherwise(artifact.value)));
  if (matches.length !== 1) throw new Error(`required checkpoint ${pattern} absent or ambiguous (${matches.length})`);
  return matches[0].value;
}

function projection(checkpoint: AnyRecord, config: AnyRecord): AnyRecord {
  const plan = compileClaimPlan(config);
  return ExecutionJournal.restoreGraphCheckpoint(plan, checkpoint).getInstanceProjection() as AnyRecord;
}

function activeClaims(view: AnyRecord, claim: string, scopeLength?: number): AnyRecord[] {
  return Object.values(view.claimsById).filter((value: any) => value.claim === claim && value.active === true && (scopeLength === undefined || value.scope.length === scopeLength)) as AnyRecord[];
}

function componentId(value: AnyRecord): string {
  return String(value.scope?.at(-1)?.key ?? value.payload?.component_id ?? value.payload?.componentId ?? '');
}

function payload(claim: AnyRecord): AnyRecord {
  const value = typeof claim.payload === 'string' ? JSON.parse(claim.payload) : claim.payload;
  if (!isRecord(value)) throw new Error(`claim ${claim.claimId} has no object payload`);
  return value;
}

function instancesByComponent(view: AnyRecord): Map<string, AnyRecord> {
  const result = new Map<string, AnyRecord>();
  for (const instance of Object.values(view.instancesById) as AnyRecord[]) {
    const key = String(instance.itemKey ?? '');
    if (key && key !== 'jsonparser') result.set(key, instance);
  }
  return result;
}

function componentGenerations(view: AnyRecord, id: string): AnyRecord[] {
  const instance = instancesByComponent(view).get(id);
  if (!instance) throw new Error(`component instance ${id} absent`);
  return Object.values(view.generationsById).filter((generation: any) => generation.subgraphInstanceId === instance.subgraphInstanceId) as AnyRecord[];
}

function attemptStages(checkpoint: AnyRecord, view: AnyRecord, id: string): string[] {
  const instance = instancesByComponent(view).get(id);
  if (!instance) return [];
  return checkpoint.events.filter((event: any) => event.type === 'AttemptStarted' && event.scope?.some((scope: any) => scope.subgraphInstanceId === instance.subgraphInstanceId)).map((event: any) => String(event.checkId));
}

function stageClaim(view: AnyRecord, claim: string, id: string): AnyRecord {
  const matches = activeClaims(view, claim, 2).filter(value => componentId(value) === id);
  if (matches.length !== 1) throw new Error(`expected one active ${claim} for ${id}, got ${matches.length}`);
  return matches[0];
}

function requiredField(value: AnyRecord, names: string[]): any {
  for (const name of names) if (Object.prototype.hasOwnProperty.call(value, name)) return value[name];
  throw new Error(`missing required evidence field ${names.join('/')}`);
}

function expectComponentCallRoles(calls: unknown, expected: string[], label: string): void {
  expect(Array.isArray(calls)).toBe(true);
  const byComponent = new Map<string, string[]>();
  for (const call of calls as AnyRecord[]) {
    expect(call).toEqual(expect.objectContaining({ componentId: expect.any(String), roleId: expect.any(String) }));
    const roles = byComponent.get(call.componentId) || [];
    roles.push(call.roleId);
    byComponent.set(call.componentId, roles);
  }
  for (const componentId of expected) {
    const roles = byComponent.get(componentId);
    if (JSON.stringify(roles) !== JSON.stringify(['onboard', 'spec-review'])) {
      throw new Error(`${label} ${componentId} has unexpected role evidence`);
    }
  }
  expect([...byComponent.keys()].sort()).toEqual([...expected].sort());
}

function walk(value: unknown, callback: (key: string, value: unknown, parent: AnyRecord) => void): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    callback(key, child, value);
    if (isRecord(child)) walk(child, callback);
    else if (Array.isArray(child)) for (const entry of child) if (isRecord(entry)) walk(entry, callback);
  }
}

function proofByteEvidence(value: unknown): string[] {
  const result: string[] = [];
  walk(value, (key, child) => {
    if (typeof child === 'string' && /(?:proof|candidate|admission).*(?:bytes|wire)|(?:bytes|wire).*proof/i.test(key) && child.length > 0) result.push(child);
  });
  return result;
}

function assertGitEvidence(report: AnyRecord): void {
  const subject = report.subject;
  if (!isRecord(subject)) throw new Error('report subject is missing');
  const {
    git_status: gitStatus,
    git_status_after: gitStatusAfter,
    head_before: headBefore,
    head_after: headAfter,
    tree_sha256_before: treeBefore,
    tree_sha256_after: treeAfter,
    files_before: filesBefore,
    files_after: filesAfter,
  } = subject;
  if (!Array.isArray(gitStatus) || !Array.isArray(gitStatusAfter) ||
      typeof headBefore !== 'string' || !headBefore || typeof headAfter !== 'string' || !headAfter ||
      typeof treeBefore !== 'string' || !treeBefore || typeof treeAfter !== 'string' || !treeAfter ||
      !isRecord(filesBefore) || !isRecord(filesAfter)) {
    throw new Error('report subject git evidence has missing or invalid fields');
  }
  expect(gitStatus).toEqual(gitStatusAfter);
  expect(gitStatus).toEqual([]);
  expect(headBefore).toBe(headAfter);
  expect(treeBefore).toBe(treeAfter);
  expect(filesBefore).toEqual(filesAfter);
}

describe('EXP-0210 staged jsonparser onboarding', () => {
  it('proves dynamic partition, staged pause/resume, selective replacement, and replay from artifacts', async () => {
    const requestedOutput = mkdtempSync(join(tmpdir(), 'visor-exp0210-acceptance-'));
    try {
      const result = await runJsonparserStagedDemo(requestedOutput);
      expect(isRecord(result)).toBe(true);
      const outputDirectory = result.outputDirectory;
      expect(typeof outputDirectory).toBe('string');
      expect(existsSync(outputDirectory)).toBe(true);
      const report = result.report as AnyRecord;
      const artifacts = jsonArtifacts(outputDirectory, report);
      const checkpoints = checkpointArtifacts(artifacts);
      expect(checkpoints.length).toBeGreaterThanOrEqual(3);
      const baseline = namedCheckpoint(checkpoints, /baseline/i);
      const pause = namedCheckpoint(checkpoints, /pause|paused/i);
      const resumed = namedCheckpoint(checkpoints, /resume|continued|b-only/i, value => value.events.length > pause.events.length);
      const final = namedCheckpoint(checkpoints, /replacement|final|completed/i, value => value.events.length >= resumed.events.length);
      const effectiveConfig = JSON.parse(readFileSync(join(outputDirectory, 'effective-config.json'), 'utf8')) as AnyRecord;
      const effectiveConfigYaml = readFileSync(join(outputDirectory, 'effective-config.yaml'), 'utf8');
      expect(effectiveConfigYaml).toContain('subgraphs:');
      expect(effectiveConfigYaml).toContain('spec_review:');
      expect(effectiveConfigYaml).toContain('spec_review_admit:');
      const graphDot = readFileSync(join(outputDirectory, 'graph.dot'), 'utf8');
      expect(graphDot).toContain('discover_project__materialize_catalog -> subgraph__onboard_component;');
      expect(graphDot).toContain('onboard_component__inspect -> onboard_component__proof_admit;');
      expect(graphDot).toContain('onboard_component__proof_admit -> onboard_component__spec_review;');
      expect(graphDot).toContain('onboard_component__spec_review -> onboard_component__spec_review_admit;');
      expect(graphDot).toContain('onboard_component__spec_review_admit -> onboard_component__verify;');
      expect(graphDot).toContain('onboard_component__verify -> discover_project__project_reconcile;');
      expect(existsSync(join(outputDirectory, 'graph.svg'))).toBe(true);
      expect(existsSync(join(outputDirectory, 'graph.png'))).toBe(true);
      expect(report.execution_mode).toBe('deterministic-fake-probe');
      expect(report.attestation_evidence).toBe('synthetic-fixture');
      expect(report.model_calls).toBe(0);
      expect(report.network_calls).toBe(0);
      expect(report.proof_commit).toBe('543994bd68f2b6d6217749c4c19be737021b993a');
      expect(readFileSync(join(outputDirectory, 'demo-report.md'), 'utf8')).toEqual(expect.stringContaining('Execution mode: deterministic-fake-probe'));
      for (const name of ['baseline-source-manifest.json', 'fix-source-manifest.json']) {
        expect(existsSync(join(outputDirectory, name))).toBe(true);
        const manifest = JSON.parse(readFileSync(join(outputDirectory, name), 'utf8')) as AnyRecord;
        expect(manifest.file_count).toBe(13);
        expect(manifest.paths).toEqual(JSONPARSER_SOURCE_PATHS);
        expect(Object.keys(manifest.file_sha256).sort()).toEqual([...JSONPARSER_SOURCE_PATHS].sort());
        expect(Object.values(manifest.file_sha256).every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value as string))).toBe(true);
      }
      const baselineView = projection(baseline, effectiveConfig);
      const pauseView = projection(pause, effectiveConfig);
      const resumedView = projection(resumed, effectiveConfig);
      const finalView = projection(final, effectiveConfig);

      const inventory = activeClaims(baselineView, 'proof.structural_inventory@1', 1);
      const catalogs = activeClaims(baselineView, 'proof.candidate@1', 1);
      const items = activeClaims(baselineView, 'component.work_item@1', 2);
      expect(inventory).toHaveLength(1);
      expect(catalogs).toHaveLength(1);
      const catalog = payload(catalogs[0]);
      const components = Array.isArray(catalog.components) ? catalog.components : [];
      expect(components.length).toBeGreaterThanOrEqual(2);
      expect(components.length).toBeLessThanOrEqual(32);
      expect(items).toHaveLength(components.length);
      const componentIds = components.map(component => String(component.id)).sort();
      expect(items.map(item => String(payload(item).component_id)).sort()).toEqual(componentIds);
      const sortedInventoryPaths = [...(payload(inventory[0]).sorted_paths || [])].map(String).sort();
      const ownedPaths = items.flatMap(item => (payload(item).sorted_owned_paths || []).map(String));
      expect([...new Set(ownedPaths)].sort()).toEqual(sortedInventoryPaths);
      expect(ownedPaths.length).toBe(new Set(ownedPaths).size);

      const stagedAtPause = componentIds.filter(id => STAGES.every(stage => componentGenerations(pauseView, id).some(generation => generation.checkId === stage && generation.status === 'completed')));
      const inspectReadyAtPause = componentIds.filter(id => componentGenerations(pauseView, id).some(generation => generation.checkId === 'inspect' && generation.status === 'ready') && attemptStages(pause, pauseView, id).length === 0);
      expect(stagedAtPause).toHaveLength(componentIds.length - 1);
      expect(inspectReadyAtPause).toHaveLength(1);
      const changedId = String(requiredField(report, ['changed_component_id', 'changedComponentId']));
      expect(stagedAtPause).toContain(changedId);
      const untouchedId = inspectReadyAtPause[0];
      expect(attemptStages(resumed, resumedView, untouchedId).slice(-STAGES.length)).toEqual(STAGES);
      const calls = requiredField(report, ['calls']);
      expectComponentCallRoles(calls.pause, stagedAtPause, 'pause calls');
      expectComponentCallRoles(calls.resume, [untouchedId], 'resume calls');
      expectComponentCallRoles(calls.replacement, [changedId], 'replacement calls');
      expect(resumed.events.slice(0, pause.events.length)).toEqual(pause.events);
      expect(canonicalGraphCheckpointJson(resumed.events.slice(0, pause.events.length))).toBe(canonicalGraphCheckpointJson(pause.events));
      expect(attemptStages(final, finalView, changedId).slice(-STAGES.length)).toEqual(STAGES);
      expect(attemptStages(final, finalView, untouchedId).slice(-STAGES.length)).toEqual(attemptStages(resumed, resumedView, untouchedId).slice(-STAGES.length));
      const finalSuffix = final.events.slice(resumed.events.length).filter((event: any) => event.type === 'AttemptStarted');
      expect(finalSuffix.every((event: any) => event.scope?.at(-1)?.key === changedId || event.checkId === 'project_reconcile')).toBe(true);

      const changedCandidate = stageClaim(finalView, 'proof.component_spec_review_candidate@1', changedId);
      const changedReceipt = stageClaim(finalView, 'proof.component_spec_review_admitted_receipt@1', changedId);
      expect(changedCandidate.parentClaimIds).toHaveLength(3);
      expect(changedReceipt.parentClaimIds).toHaveLength(1);
      expect(changedReceipt.parentClaimIds).toEqual([changedCandidate.claimId]);
      const receiptPayload = payload(changedReceipt);
      const admissionWire = receiptPayload.__proof_admission_wire;
      expect(typeof admissionWire).toBe('string');
      expect(admissionWire.length).toBeGreaterThan(0);
      const decision = JSON.parse(admissionWire) as AnyRecord;
      const wireReceipt = decision.receipt as AnyRecord;
      expect(wireReceipt).toEqual(expect.objectContaining({ ClaimID: changedCandidate.claimId }));
      expect(receiptPayload.ClaimID).toBe(changedCandidate.claimId);
      expect(wireReceipt.CandidateID).toBe(receiptPayload.CandidateID);
      expect(proofByteEvidence(changedReceipt)).not.toHaveLength(0);
      const changedInstance = instancesByComponent(finalView).get(changedId)!;
      const verify = componentGenerations(finalView, changedId).find(generation => generation.checkId === 'verify' && generation.status === 'completed');
      expect(verify).toBeDefined();
      const verifyClaims = activeClaims(finalView, 'proof.candidate@1', 2).filter(value => componentId(value) === changedId)
        .concat(activeClaims(finalView, 'proof.admitted_receipt@1', 2).filter(value => componentId(value) === changedId))
        .concat([changedCandidate, changedReceipt]);
      expect(new Set(verify!.activeInputClaimIds)).toEqual(new Set(verifyClaims.map(value => value.claimId)));
      expect(verify!.activeInputClaimIds).toHaveLength(4);
      expect(changedInstance).toBeDefined();
      expect(activeClaims(finalView, 'proof.project_reconciliation_receipt@1', 1)).toHaveLength(1);
      expect(Object.values(finalView.generationsById).some((generation: any) => generation.checkId === 'project_reconcile' && generation.status === 'completed')).toBe(true);

      const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(effectiveConfig), final);
      expect(restored.getInstanceProjection()).toEqual(restored.replayInstanceProjection());
      expect(canonicalGraphCheckpointJson(restored.exportGraphCheckpoint(final.sessionId))).toBe(canonicalGraphCheckpointJson(final));
      const baselineUnchanged = Object.values(resumedView.claimsById).filter((claim: any) => componentId(claim) === untouchedId).sort((a: any, b: any) => a.claimId.localeCompare(b.claimId));
      const finalUnchanged = Object.values(finalView.claimsById).filter((claim: any) => componentId(claim) === untouchedId).sort((a: any, b: any) => a.claimId.localeCompare(b.claimId));
      expect(finalUnchanged).toEqual(baselineUnchanged);
      const baselineGenerations = componentGenerations(resumedView, untouchedId).sort((a, b) => a.nodeGenerationId.localeCompare(b.nodeGenerationId));
      const finalGenerations = componentGenerations(finalView, untouchedId).sort((a, b) => a.nodeGenerationId.localeCompare(b.nodeGenerationId));
      expect(finalGenerations).toEqual(baselineGenerations);

      expect(requiredField(report, ['modelCalls', 'model_calls'])).toBe(0);
      expect(requiredField(report, ['networkCalls', 'network_calls'])).toBe(0);
      expect(requiredField(report, ['retryCount', 'retry_count', 'retries'])).toBe(0);
      expect(requiredField(report, ['fallback', 'fallbackUsed', 'fallback_used'])).toBe(false);
      const eventText = JSON.stringify([...baseline.events, ...pause.events, ...resumed.events, ...final.events]);
      expect(eventText).not.toMatch(/model[_ ]?call|network[_ ]?request/i);
      assertGitEvidence(report);
    } finally {
      rmSync(requestedOutput, { recursive: true, force: true });
    }
  }, 180_000);
});
