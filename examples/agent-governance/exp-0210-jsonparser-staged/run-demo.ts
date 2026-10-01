/*
 * EXP-0210 is a deterministic, zero-model scenario runner.  Proof and the
 * child process own all semantic and execution decisions; this controller
 * only materializes Git objects, passes exact checkpoint inputs, and publishes
 * the resulting evidence after the complete run has validated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../../src/snapshot-store';
import { compileClaimPlan } from '../../../src/state-machine/graph/claim-plan';
import { canonicalJson } from '../../../src/state-machine/graph/claim-kernel';

type AnyRecord = Record<string, any>;
type ChildCall = { componentId: string; roleId: string };
type ChildArtifact = { checkpoint: AnyRecord; baselineCheckpoint?: AnyRecord; calls: ChildCall[]; baselineCalls?: ChildCall[]; components?: AnyRecord[]; refreshed?: AnyRecord; config?: AnyRecord; inventory?: AnyRecord };
type RunResult = { outputDirectory: string; report: AnyRecord };

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SUBJECT_REPO = '/Users/buger/go/src/jsonparser';
const PROOF_REPO = '/Users/buger/go/src/reqforge-exp-0207a-proof-cli-admission';
const CHILD = path.resolve(__dirname, '../../../tests/fixtures/exp-0210-jsonparser-staged-child.ts');
const PROFILE = path.resolve(__dirname, 'visor.yaml');
const BASELINE_COMMIT = 'cb835d480ac58e1b4be76afeac49e89ed651c3b5';
const FIX_COMMIT = '3980c9c9b9919e643bd095fa4469bfa19e29f20c';
const PROOF_COMMIT = '543994bd68f2b6d6217749c4c19be737021b993a';
const STAGES = ['inspect', 'proof_admit', 'spec_review', 'spec_review_admit', 'verify'] as const;
const SUBJECT_FILES = [
  'bytes.go', 'bytes_safe.go', 'bytes_test.go', 'bytes_unsafe.go',
  'bytes_unsafe_test.go', 'escape.go', 'escape_test.go', 'fuzz.go',
  'go.mod', 'go.sum', 'parser.go', 'parser_error_test.go', 'parser_test.go',
] as const;
const OFFLINE_ENV = { GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' };

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(executable: string, args: string[], cwd: string, input?: Buffer | string): Buffer {
  return execFileSync(executable, args, {
    cwd, input, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, ...OFFLINE_ENV },
  });
}

function archive(repo: string, revision: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const tar = run('git', ['-C', repo, 'archive', revision, '--', ...SUBJECT_FILES], REPO_ROOT);
  run('tar', ['-xf', '-', '-C', destination], REPO_ROOT, tar);
  fs.writeFileSync(path.join(destination, 'proof.yaml'), 'project:\n  name: jsonparser\n  version: "1.0"\n', 'utf8');
}

function gitWorkspace(workspace: string, message: string): void {
  run('git', ['init', '-q'], workspace);
  run('git', ['config', 'user.email', 'visor-exp0210@example.invalid'], workspace);
  run('git', ['config', 'user.name', 'Visor EXP-0210'], workspace);
  run('git', ['add', '--', ...SUBJECT_FILES, 'proof.yaml'], workspace);
  run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message], workspace);
}

function buildProof(destination: string): string {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0210-proof-source-'));
  try {
    const tar = execFileSync('git', ['-C', PROOF_REPO, 'archive', PROOF_COMMIT, '--format=tar'], {
      cwd: REPO_ROOT,
      maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, ...OFFLINE_ENV },
    });
    run('tar', ['-xf', '-', '-C', source], REPO_ROOT, tar);
    const binary = path.join(destination, 'proof');
    run('go', ['build', '-o', binary, './cmd/proof'], source);
    return binary;
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function proofInvoke(binary: string, cwd: string, args: string[], input = ''): AnyRecord {
  return JSON.parse(run(binary, args, cwd, input).toString('utf8')) as AnyRecord;
}

function sourceState(): AnyRecord {
  const status = run('git', ['-C', SUBJECT_REPO, 'status', '--porcelain=v1'], REPO_ROOT).toString('utf8');
  const head = run('git', ['-C', SUBJECT_REPO, 'rev-parse', 'HEAD'], REPO_ROOT).toString('utf8').trim();
  const files = Object.fromEntries(SUBJECT_FILES.map(file => [file, sha256(fs.readFileSync(path.join(SUBJECT_REPO, file)))]));
  const tree = sha256(SUBJECT_FILES.map(file => `${files[file]}  ${file}\n`).join(''));
  return { git_status: status ? status.split('\n').filter(Boolean) : [], head, files, tree_sha256: tree };
}

function sourceManifest(workspace: string, revision: string): AnyRecord {
  const files = Object.fromEntries(SUBJECT_FILES.map(file => [file, sha256(fs.readFileSync(path.join(workspace, file)))]));
  return {
    version: 'urn:reqproof:exp-0210-source-manifest:v1',
    revision,
    file_count: SUBJECT_FILES.length,
    paths: [...SUBJECT_FILES],
    file_sha256: files,
    manifest_sha256: sha256(SUBJECT_FILES.map(file => `${files[file]}  ${file}\n`).join('')),
  };
}

function child(mode: string, payload: AnyRecord, work: string): ChildArtifact {
  const input = path.join(work, `${mode}.input.json`);
  const output = path.join(work, `${mode}.output.json`);
  writeJson(input, payload);
  run(process.execPath, ['-r', 'ts-node/register/transpile-only', CHILD, mode, input], REPO_ROOT);
  const result = JSON.parse(fs.readFileSync(output, 'utf8')) as ChildArtifact;
  return result;
}

function checkpointProjection(checkpoint: AnyRecord, config: AnyRecord): AnyRecord {
  return ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint).getInstanceProjection() as AnyRecord;
}

function event(checkpoint: AnyRecord, predicate: (value: AnyRecord) => boolean): AnyRecord {
  const matches = checkpoint.events.filter(predicate);
  if (matches.length !== 1) throw new Error(`expected one checkpoint event, got ${matches.length}`);
  return matches[0];
}

function projectSubgraphInstanceId(checkpoint: AnyRecord, config: AnyRecord): string {
  const projection = checkpointProjection(checkpoint, config);
  const projects = Object.values(projection.instancesById).filter((value: any) => value.itemKey === 'jsonparser') as AnyRecord[];
  if (projects.length !== 1) throw new Error(`expected one jsonparser instance, got ${projects.length}`);
  return String(projects[0].subgraphInstanceId);
}

function catalogArtifacts(checkpoint: AnyRecord, config: AnyRecord): AnyRecord {
  const projection = checkpointProjection(checkpoint, config);
  const candidate = event(checkpoint, value => value.type === 'ClaimPublished' && value.claim === 'proof.candidate@1' && value.scope.length === 1);
  const admission = event(checkpoint, value => value.type === 'ClaimPublished' && value.claim === 'proof.admitted_receipt@1' && value.scope.length === 1);
  const revalidation = event(checkpoint, value => value.type === 'ClaimPublished' && value.claim === 'proof.catalog_revalidation@1' && value.scope.length === 1);
  const items = Object.values(projection.claimsById).filter((value: any) => value.claim === 'component.work_item@1' && value.active && value.scope.length === 2).map((value: any) => value.payload);
  return {
    candidate: candidate.payload,
    admission: admission.payload,
    revalidation: revalidation.payload,
    work_items: { version: 'proof.onboarding-work-item-projection/v1', work_items: items },
  };
}

function componentIdForScope(value: AnyRecord): string {
  return String(value.scope?.at(-1)?.key ?? value.payload?.component_id ?? '');
}

function componentGenerations(view: AnyRecord, id: string): AnyRecord[] {
  const instance = Object.values(view.instancesById).find((value: any) => value.itemKey === id) as AnyRecord | undefined;
  if (!instance) throw new Error(`component instance ${id} is absent`);
  return Object.values(view.generationsById).filter((value: any) => value.subgraphInstanceId === instance.subgraphInstanceId) as AnyRecord[];
}

function validateCallEvidence(calls: ChildCall[], expectedComponents: readonly string[], label: string): void {
  const byComponent = new Map<string, string[]>();
  for (const call of calls) {
    if (!call || typeof call.componentId !== 'string' || typeof call.roleId !== 'string') throw new Error(`${label} has unstructured call evidence`);
    const roles = byComponent.get(call.componentId) || [];
    roles.push(call.roleId);
    byComponent.set(call.componentId, roles);
  }
  for (const componentId of expectedComponents) {
    const roles = byComponent.get(componentId);
    if (!roles || canonicalJson(roles) !== canonicalJson(['onboard', 'spec-review'])) throw new Error(`${label} missing onboard/spec-review evidence for ${componentId}`);
  }
  if ([...byComponent.keys()].some(componentId => !expectedComponents.includes(componentId))) throw new Error(`${label} contains an unexpected component`);
}

function validateScenario(baseline: AnyRecord, pause: AnyRecord, resumed: AnyRecord, replacement: AnyRecord, config: AnyRecord, proofChangedId: string, pauseCalls: ChildCall[], resumeCalls: ChildCall[], replacementCalls: ChildCall[]): AnyRecord {
  const baseView = checkpointProjection(baseline, config);
  const pauseView = checkpointProjection(pause, config);
  const resumedView = checkpointProjection(resumed, config);
  const replacementView = checkpointProjection(replacement, config);
  const components = Object.values(baseView.instancesById).filter((value: any) => value.itemKey !== 'jsonparser') as AnyRecord[];
  const ids = components.map(value => String(value.itemKey)).sort();
  if (ids.length < 2 || ids.length > 32) throw new Error(`dynamic component count out of bounds: ${ids.length}`);
  const baseItems = Object.values(baseView.claimsById).filter((value: any) => value.claim === 'component.work_item@1' && value.active && value.scope.length === 2) as AnyRecord[];
  if (baseItems.length !== ids.length) throw new Error('baseline WorkItem count does not match dynamic component count');
  const owned = baseItems.flatMap(value => (value.payload.sorted_owned_paths || []).map(String));
  if (owned.length !== new Set(owned).size) throw new Error('baseline WorkItem ownership overlaps');
  const inventory = Object.values(baseView.claimsById).find((value: any) => value.claim === 'proof.structural_inventory@1' && value.active && value.scope.length === 1) as AnyRecord | undefined;
  if (!inventory || canonicalJson(owned.sort()) !== canonicalJson((inventory.payload.sorted_paths || []).map(String).sort())) throw new Error('WorkItem partition differs from Proof inventory');
  const complete = ids.filter(id => STAGES.every(stage => componentGenerations(pauseView, id).some(generation => generation.checkId === stage && generation.status === 'completed')));
  const ready = ids.filter(id => {
    const instance = components.find(value => value.itemKey === id)!;
    return Object.values(pauseView.generationsById).some((value: any) => value.subgraphInstanceId === instance.subgraphInstanceId && value.checkId === 'inspect' && value.status === 'ready');
  });
  if (complete.length !== ids.length - 1 || ready.length !== 1) throw new Error(`pause frontier did not isolate N-1 complete/B-ready (${complete.length}/${ids.length - 1}/${ready.length})`);
  if (!complete.includes(proofChangedId)) throw new Error(`Proof affected set selected ${proofChangedId}, expected one completed component`);
  const changed = proofChangedId;
  const held = ready[0];
  validateCallEvidence(pauseCalls, complete, 'pause');
  validateCallEvidence(resumeCalls, [held], 'resume');
  validateCallEvidence(replacementCalls, [changed], 'replacement');
  if (resumed.sessionId !== pause.sessionId || resumed.graphSemanticDigest !== pause.graphSemanticDigest) throw new Error('resume changed session or graph digest');
  if (canonicalGraphCheckpointJson(resumed.events.slice(0, pause.events.length)) !== canonicalGraphCheckpointJson(pause.events)) throw new Error('resume did not preserve exact prefix');
  const suffix = replacement.events.slice(resumed.events.length).filter((value: any) => value.type === 'AttemptStarted');
  const changedInstance = components.find(value => value.itemKey === changed)!;
  const changedAttempts = suffix.filter((value: any) => value.scope?.some((scope: any) => scope.subgraphInstanceId === changedInstance.subgraphInstanceId));
  if (changedAttempts.map(value => value.checkId).sort().join(',') !== ['inspect', 'proof_admit', 'spec_review', 'spec_review_admit', 'verify'].sort().join(',')) throw new Error('replacement did not dispatch exactly the staged A cascade');
  for (const sibling of ids.filter(id => id !== changed)) {
    const siblingInstance = components.find(value => value.itemKey === sibling)!;
    if (suffix.some((value: any) => value.scope?.some((scope: any) => scope.subgraphInstanceId === siblingInstance.subgraphInstanceId))) throw new Error('replacement dispatched sibling work');
    const siblingClaimsBefore = Object.values(resumedView.claimsById).filter((value: any) => componentIdForScope(value) === sibling).sort((a: any, b: any) => a.claimId.localeCompare(b.claimId));
    const siblingClaimsAfter = Object.values(replacementView.claimsById).filter((value: any) => componentIdForScope(value) === sibling).sort((a: any, b: any) => a.claimId.localeCompare(b.claimId));
    if (canonicalJson(siblingClaimsBefore) !== canonicalJson(siblingClaimsAfter)) throw new Error('replacement changed unrelated sibling claims');
    const siblingGenerationsBefore = componentGenerations(resumedView, sibling).sort((a, b) => a.nodeGenerationId.localeCompare(b.nodeGenerationId));
    const siblingGenerationsAfter = componentGenerations(replacementView, sibling).sort((a, b) => a.nodeGenerationId.localeCompare(b.nodeGenerationId));
    if (canonicalJson(siblingGenerationsBefore) !== canonicalJson(siblingGenerationsAfter)) throw new Error('replacement changed unrelated sibling generations');
  }
  const stagedCandidate = Object.values(replacementView.claimsById).filter((value: any) => value.claim === 'proof.component_spec_review_candidate@1' && value.active && value.scope.length === 2 && componentIdForScope(value) === changed) as AnyRecord[];
  const stagedReceipt = Object.values(replacementView.claimsById).filter((value: any) => value.claim === 'proof.component_spec_review_admitted_receipt@1' && value.active && value.scope.length === 2 && componentIdForScope(value) === changed) as AnyRecord[];
  if (stagedCandidate.length !== 1 || stagedReceipt.length !== 1) throw new Error('staged candidate/receipt is not unique');
  if (stagedCandidate[0].parentClaimIds.length !== 3 || stagedReceipt[0].parentClaimIds.length !== 1) throw new Error('staged parent cardinality mismatch');
  const verify = Object.values(replacementView.generationsById).find((value: any) => {
    const instance = replacementView.instancesById[value.subgraphInstanceId];
    return instance?.itemKey === changed && value.checkId === 'verify' && value.status === 'completed';
  }) as AnyRecord | undefined;
  if (!verify || verify.activeInputClaimIds.length !== 4) throw new Error('staged verify does not bind four inputs');
  if (!Object.values(replacementView.claimsById).some((value: any) => value.claim === 'proof.project_reconciliation_receipt@1' && value.active)) throw new Error('current reconciliation receipt missing');
  if (!Object.values(replacementView.generationsById).some((value: any) => value.checkId === 'project_reconcile' && value.status === 'completed')) throw new Error('current reconciliation generation missing');
  const restored = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), replacement);
  if (canonicalGraphCheckpointJson(restored.getInstanceProjection()) !== canonicalGraphCheckpointJson(restored.replayInstanceProjection())) throw new Error('replacement replay differs');
  if (canonicalGraphCheckpointJson(restored.exportGraphCheckpoint(replacement.sessionId)) !== canonicalGraphCheckpointJson(replacement)) throw new Error('replacement re-export differs');
  return { component_count: ids.length, component_ids: ids, changed_component_id: changed, unaffected_component_id: held, staged_candidate_parents: 3, staged_receipt_parents: 1, verify_inputs: 4, current_reconciliation: true };
}

function graphDot(config: AnyRecord): string {
  const nodes = new Map<string, string>();
  const edges = new Set<string>();
  const nodeId = (scope: string, check: string): string =>
    `${scope.replace(/[^A-Za-z0-9_]/g, '_')}__${check.replace(/[^A-Za-z0-9_]/g, '_')}`;
  const dotQuote = (value: string): string => JSON.stringify(value);
  const addNode = (id: string, label: string): void => { nodes.set(id, label); };
  const addEdge = (from: string, to: string): void => { edges.add(`${from}\u0000${to}`); };
  const projectChecks = config.checks || {};
  for (const check of Object.keys(projectChecks).sort()) {
    const id = nodeId('project', check);
    addNode(id, `project.${check}`);
    const expansion = projectChecks[check]?.expand;
    if (expansion?.template) {
      const target = `subgraph__${String(expansion.template).replace(/[^A-Za-z0-9_]/g, '_')}`;
      addNode(target, `subgraph ${expansion.template}`);
      addEdge(id, target);
    }
  }
  for (const [subgraphName, subgraph] of Object.entries(config.subgraphs || {}).sort(([left], [right]) => left.localeCompare(right))) {
    const checks = (subgraph as AnyRecord).checks || {};
    const subgraphNode = `subgraph__${subgraphName.replace(/[^A-Za-z0-9_]/g, '_')}`;
    addNode(subgraphNode, `subgraph ${subgraphName}`);
    for (const check of Object.keys(checks).sort()) addNode(nodeId(subgraphName, check), `${subgraphName}.${check}`);
    for (const check of Object.keys(checks).sort()) {
      const value = checks[check] as AnyRecord;
      const current = nodeId(subgraphName, check);
      addEdge(subgraphNode, current);
      const dependencies = Array.isArray(value.depends_on) ? value.depends_on : value.depends_on ? [value.depends_on] : [];
      for (const dependency of dependencies) addEdge(nodeId(subgraphName, String(dependency)), current);
      for (const producer of Object.keys(checks).sort()) {
        const emissions = Array.isArray(checks[producer]?.emits) ? checks[producer].emits : [];
        for (const emission of emissions) {
          const claim = emission && typeof emission === 'object' ? emission.claim : undefined;
          const consumes = Array.isArray(value.consumes) ? value.consumes : [];
          if (claim && consumes.some((consumption: AnyRecord) => consumption?.claim === claim)) addEdge(nodeId(subgraphName, producer), current);
        }
      }
      const expansion = value.expand;
      if (expansion?.template) {
        const target = `subgraph__${String(expansion.template).replace(/[^A-Za-z0-9_]/g, '_')}`;
        addNode(target, `subgraph ${expansion.template}`);
        addEdge(current, target);
      }
    }
    for (const check of Object.keys(checks).sort()) {
      const wait = checks[check]?.wait_for_expansion;
      if (!wait?.owner || !wait.terminal_node) continue;
      const owner = checks[wait.owner]?.expand?.template;
      if (owner) addEdge(nodeId(String(owner), String(wait.terminal_node)), nodeId(subgraphName, check));
    }
  }
  const lines = [
    '// Generated by run-demo.ts from the effective Visor YAML.',
    'digraph visor_exp0210 {',
    '  rankdir=LR;',
    '  graph [fontname="Helvetica", labelloc="t", label="EXP-0210 staged discovery and reinspection"];',
    '  node [fontname="Helvetica", shape=box, style="rounded,filled", fillcolor="#eef4ff"];',
    '  edge [fontname="Helvetica"];',
  ];
  for (const [id, label] of [...nodes.entries()].sort(([left], [right]) => left.localeCompare(right))) lines.push(`  ${id} [label=${dotQuote(label)}];`);
  for (const edge of [...edges].sort()) {
    const [from, to] = edge.split('\u0000');
    lines.push(`  ${from} -> ${to};`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function renderGraph(stage: string, dot: string): void {
  fs.writeFileSync(path.join(stage, 'graph.dot'), dot, 'utf8');
  for (const format of ['svg', 'png']) {
    const result = spawnSync('dot', ['-T', format, path.join(stage, 'graph.dot'), '-o', path.join(stage, `graph.${format}`)], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Graphviz failed to render ${format}`);
  }
}

export async function runJsonparserStagedDemo(outputDirectory?: string): Promise<RunResult> {
  const requested = outputDirectory || path.join(os.tmpdir(), `visor-exp0210-${process.pid}-${Date.now()}`);
  let stage = '';
  let work = '';
  let proofBuild = '';
  try {
    stage = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0210-publish-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0210-work-'));
    proofBuild = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0210-proof-'));
    const before = sourceState();
    const baselineWorkspace = path.join(work, 'baseline');
    const fixedWorkspace = path.join(work, 'fixed');
    archive(SUBJECT_REPO, BASELINE_COMMIT, baselineWorkspace);
    archive(SUBJECT_REPO, FIX_COMMIT, fixedWorkspace);
    gitWorkspace(baselineWorkspace, 'EXP-0210 baseline');
    fs.rmSync(path.join(fixedWorkspace, '.git'), { recursive: true, force: true });
    fs.cpSync(path.join(baselineWorkspace, '.git'), path.join(fixedWorkspace, '.git'), { recursive: true });
    run('git', ['add', '--', ...SUBJECT_FILES, 'proof.yaml'], fixedWorkspace);
    run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'EXP-0210 fixed'], fixedWorkspace);
    const proof = buildProof(proofBuild);
    const prepared = child('prepare', { proofBinary: proof, workspace: baselineWorkspace, configPath: path.join(work, 'unused-config.json'), outputPath: path.join(work, 'prepare.output.json') }, work);
    if (!prepared.config || !prepared.inventory) throw new Error('prepare child omitted config or inventory');
    const config = prepared.config;
    writeJson(path.join(work, 'effective-config.json'), config);
    const configPath = path.join(work, 'effective-config.json');
    const pauseResult = child('pause', { proofBinary: proof, workspace: baselineWorkspace, configPath, outputPath: path.join(work, 'pause.output.json') }, work);
    const pause = pauseResult.checkpoint;
    writeJson(path.join(work, 'pause.checkpoint.json'), pause);
    const resumedResult = child('resume', { proofBinary: proof, workspace: baselineWorkspace, configPath, checkpointPath: path.join(work, 'pause.checkpoint.json'), outputPath: path.join(work, 'resume.output.json') }, work);
    const resumed = resumedResult.checkpoint;
    writeJson(path.join(work, 'resume.checkpoint.json'), resumed);
    const baseline = resumed;
    writeJson(path.join(work, 'baseline.checkpoint.json'), baseline);
    const replacementResult = child('replacement', {
      proofBinary: proof, workspace: fixedWorkspace, configPath,
      checkpointPath: path.join(work, 'resume.checkpoint.json'),
      projectSubgraphInstanceId: projectSubgraphInstanceId(resumed, config),
      outputPath: path.join(work, 'replacement.output.json'),
    }, work);
    const replacement = replacementResult.checkpoint;
    writeJson(path.join(work, 'replacement.checkpoint.json'), replacement);
    const evidence = validateScenario(baseline, pause, resumed, replacement, config, String(replacementResult.refreshed?.changedComponentId || ''), pauseResult.calls, resumedResult.calls, replacementResult.calls);
    const sourceAfter = sourceState();
    if (canonicalJson(before) !== canonicalJson(sourceAfter)) throw new Error('actual jsonparser checkout changed');
    const baselineManifest = sourceManifest(baselineWorkspace, BASELINE_COMMIT);
    const fixManifest = sourceManifest(fixedWorkspace, FIX_COMMIT);
    const baseArtifacts = catalogArtifacts(pause, config);
    const finalArtifacts = replacementResult.refreshed || {};
    fs.copyFileSync(PROFILE, path.join(stage, 'visor.yaml'));
    writeJson(path.join(stage, 'effective-config.json'), config);
    fs.writeFileSync(path.join(stage, 'effective-config.yaml'), yaml.dump(config, { noRefs: true, sortKeys: true, lineWidth: -1 }), 'utf8');
    writeJson(path.join(stage, 'inventory.json'), proofInvoke(proof, baselineWorkspace, ['onboarding', 'inventory']));
    writeJson(path.join(stage, 'candidate.json'), baseArtifacts.candidate);
    writeJson(path.join(stage, 'admission.json'), baseArtifacts.admission);
    writeJson(path.join(stage, 'revalidation.json'), baseArtifacts.revalidation);
    writeJson(path.join(stage, 'work-items.json'), baseArtifacts.work_items);
    writeJson(path.join(stage, 'baseline-source-manifest.json'), baselineManifest);
    writeJson(path.join(stage, 'fix-source-manifest.json'), fixManifest);
    if (finalArtifacts.revalidationBytes) fs.writeFileSync(path.join(stage, 'replacement-revalidation.json'), finalArtifacts.revalidationBytes, 'utf8');
    if (finalArtifacts.workItemsBytes) fs.writeFileSync(path.join(stage, 'replacement-work-items.json'), finalArtifacts.workItemsBytes, 'utf8');
    fs.copyFileSync(path.join(work, 'baseline.checkpoint.json'), path.join(stage, 'baseline.checkpoint.json'));
    fs.copyFileSync(path.join(work, 'pause.checkpoint.json'), path.join(stage, 'pause.checkpoint.json'));
    fs.copyFileSync(path.join(work, 'resume.checkpoint.json'), path.join(stage, 'continued.checkpoint.json'));
    fs.copyFileSync(path.join(work, 'replacement.checkpoint.json'), path.join(stage, 'replacement.checkpoint.json'));
    renderGraph(stage, graphDot(config));
    const report: AnyRecord = {
      version: 'urn:reqproof:agent-governance:exp-0210-jsonparser-staged:v1', status: 'passed',
      graph_semantic_digest: replacement.graphSemanticDigest, session_id: replacement.sessionId,
      ...evidence,
      execution_mode: 'deterministic-fake-probe', attestation_evidence: 'synthetic-fixture',
      modelCalls: 0, networkCalls: 0, model_calls: 0, network_calls: 0, retries: 0, fallback: false,
      subject: { git_status: before.git_status, git_status_after: sourceAfter.git_status, head_before: before.head, head_after: sourceAfter.head, tree_sha256_before: before.tree_sha256, tree_sha256_after: sourceAfter.tree_sha256, files_before: before.files, files_after: sourceAfter.files },
      calls: { pause: pauseResult.calls, resume: resumedResult.calls, replacement: replacementResult.calls },
      proof_commit: PROOF_COMMIT, baseline_commit: BASELINE_COMMIT, fix_commit: FIX_COMMIT,
      source_manifests: { baseline: 'baseline-source-manifest.json', fix: 'fix-source-manifest.json' },
      artifacts: { baseline: 'baseline.checkpoint.json', pause: 'pause.checkpoint.json', resumed: 'continued.checkpoint.json', replacement: 'replacement.checkpoint.json' },
    };
    writeJson(path.join(stage, 'demo-report.json'), report);
    fs.writeFileSync(path.join(stage, 'demo-report.md'), `# EXP-0210 staged jsonparser\n\nStatus: passed\nExecution mode: deterministic-fake-probe\nAttestation evidence: synthetic-fixture\nModel calls: 0\nNetwork calls: 0\nProof commit: ${PROOF_COMMIT}\nComponents: ${evidence.component_count}\nChanged component: ${evidence.changed_component_id}\n`, 'utf8');
    if (fs.existsSync(requested)) {
      if (fs.readdirSync(requested).length !== 0) throw new Error('output directory must be empty');
      fs.rmSync(requested, { recursive: true, force: true });
    } else fs.mkdirSync(path.dirname(requested), { recursive: true });
    fs.renameSync(stage, requested);
    return { outputDirectory: requested, report };
  } finally {
    if (process.env.VISOR_EXP0210_KEEP_WORK !== '1' && work) fs.rmSync(work, { recursive: true, force: true });
    if (proofBuild) fs.rmSync(proofBuild, { recursive: true, force: true });
    if (stage && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (require.main === module) {
  runJsonparserStagedDemo(process.argv[2]).then(result => process.stdout.write(`${JSON.stringify(result.report)}\n`)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
