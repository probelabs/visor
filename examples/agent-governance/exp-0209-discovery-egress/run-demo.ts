import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import { canonicalGraphCheckpointJson } from '../../../src/snapshot-store';
import { compileClaimPlan } from '../../../src/state-machine/graph/claim-plan';

type JsonRecord = Record<string, any>;

const ROOT = path.resolve(__dirname, '../../../');
const PROFILE = path.join(__dirname, 'visor.yaml');
const FIXTURE = path.join(ROOT, 'tests/fixtures/proof-current-catalog-checkpoint-child.ts');

function jsonBytes(value: unknown): string {
  return canonicalGraphCheckpointJson(value);
}

function assertInvariant(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`demo invariant failed: ${name}`);
}

function componentSlice(projection: JsonRecord, itemKey: string): JsonRecord | undefined {
  const instance = Object.values(projection.instancesById).find(
    (value: JsonRecord) => value.itemKey === itemKey
  ) as JsonRecord | undefined;
  if (!instance) return undefined;
  const nodeIds = Object.values(instance.nodeInstanceIdsByTemplateNode) as string[];
  return {
    instance,
    nodes: nodeIds.map(id => projection.nodesById[id]).sort((left, right) => left.nodeInstanceId.localeCompare(right.nodeInstanceId)),
    generations: Object.values(projection.generationsById)
      .filter((value: JsonRecord) => value.subgraphInstanceId === instance.subgraphInstanceId)
      .sort((left, right) => left.nodeGenerationId.localeCompare(right.nodeGenerationId)),
    claims: Object.values(projection.claimsById)
      .filter((value: JsonRecord) => value.subgraphInstanceId === instance.subgraphInstanceId)
      .sort((left, right) => left.claimId.localeCompare(right.claimId)),
  };
}

function readJson(file: string): JsonRecord {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonRecord;
}

function runChild(mode: 'produce' | 'continue' | 'negative', directory: string): void {
  try {
    execFileSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', FIXTURE, mode, directory],
      {
        cwd: ROOT,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
        encoding: 'utf8',
        timeout: 180_000,
        stdio: 'pipe',
      }
    );
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr || '')
        : String(error);
    throw new Error(`checkpoint fixture ${mode} failed${detail ? `: ${detail.trim()}` : ''}`);
  }
}

function dotQuote(value: string): string {
  return JSON.stringify(value.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
}

function nodeId(scope: string, check: string): string {
  return `${scope.replace(/[^A-Za-z0-9_]/g, '_')}__${check.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function graphFromProfile(): string {
  const config = yaml.load(fs.readFileSync(PROFILE, 'utf8')) as JsonRecord;
  const nodes = new Map<string, string>();
  const edges = new Set<string>();
  const addNode = (id: string, label: string) => nodes.set(id, label);
  const addEdge = (from: string, to: string) => edges.add(`${from}\u0000${to}`);

  for (const check of Object.keys(config.checks || {}).sort()) {
    const id = nodeId('project', check);
    addNode(id, `project.${check}`);
    const expansion = config.checks[check]?.expand;
    if (expansion?.template) {
      const target = `subgraph__${String(expansion.template).replace(/[^A-Za-z0-9_]/g, '_')}`;
      addNode(target, `subgraph ${expansion.template}`);
      addEdge(id, target);
    }
  }

  for (const [subgraphName, subgraph] of Object.entries(config.subgraphs || {}).sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    const checks = (subgraph as JsonRecord).checks || {};
    const subgraphNode = `subgraph__${subgraphName.replace(/[^A-Za-z0-9_]/g, '_')}`;
    addNode(subgraphNode, `subgraph ${subgraphName}`);
    for (const check of Object.keys(checks).sort())
      addNode(nodeId(subgraphName, check), `${subgraphName}.${check}`);
    for (const check of Object.keys(checks).sort())
      addEdge(subgraphNode, nodeId(subgraphName, check));
    for (const check of Object.keys(checks).sort()) {
      const value = checks[check] as JsonRecord;
      const current = nodeId(subgraphName, check);
      const dependencies = Array.isArray(value.depends_on)
        ? value.depends_on
        : value.depends_on
          ? [value.depends_on]
          : [];
      for (const dependency of dependencies)
        addEdge(nodeId(subgraphName, String(dependency)), current);
      for (const producer of Object.keys(checks).sort()) {
        const emissions = Array.isArray(checks[producer]?.emits) ? checks[producer].emits : [];
        for (const emission of emissions) {
          const claim = emission && typeof emission === 'object' ? emission.claim : undefined;
          if (!claim) continue;
          const consumes = Array.isArray(value.consumes) ? value.consumes : [];
          if (consumes.some((consumption: JsonRecord) => consumption?.claim === claim)) {
            addEdge(nodeId(subgraphName, producer), current);
          }
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
      if (!owner) continue;
      addEdge(nodeId(owner, String(wait.terminal_node)), nodeId(subgraphName, check));
    }
  }

  const lines = [
    '// Generated by run-demo.ts from visor.yaml; edit visor.yaml, not this file.',
    'digraph visor_exp0209 {',
    '  rankdir=LR;',
    '  graph [fontname="Helvetica", labelloc="t", label="EXP-0209 discovery egress"];',
    '  node [fontname="Helvetica", shape=box, style="rounded,filled", fillcolor="#eef4ff"];',
    '  edge [fontname="Helvetica"];',
  ];
  for (const [id, label] of [...nodes.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    lines.push(`  ${id} [label=${dotQuote(label)}];`);
  }
  for (const edge of [...edges].sort()) {
    const [from, to] = edge.split('\u0000');
    lines.push(`  ${from} -> ${to};`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function projectReconciliationReceipt(
  projection: JsonRecord,
  activeOnly: boolean
): JsonRecord | undefined {
  return Object.values(projection.claimsById).find(
    (claim: JsonRecord) =>
      claim.claim === 'proof.project_reconciliation_receipt@1' &&
      (!activeOnly || claim.active === true)
  ) as JsonRecord | undefined;
}

function dispatchSequence(
  checkpoint: JsonRecord,
  projection: JsonRecord,
  prefixLength: number
): string[] {
  return checkpoint.events
    .slice(prefixLength)
    .filter((event: JsonRecord) => event.type === 'AttemptStarted')
    .map((event: JsonRecord) => {
      const generation = projection.generationsById[event.nodeGenerationId];
      const instance = generation && projection.instancesById[generation.subgraphInstanceId];
      return `${instance?.itemKey || '<unknown>'}:${event.checkId}`;
    });
}

function markdownReport(report: JsonRecord, outputDirectory: string): string {
  const projectReceipts = report.receiptIds.projectReconciliation;
  const catalogReceipts = report.receiptIds.catalogRevalidation;
  return [
    '# EXP-0209 deterministic onboarding / re-onboarding demo',
    '',
    `- Job: ${report.job}`,
    `- Output directory: \`${outputDirectory}\``,
    `- Changed source: ${report.changed.file} (${report.changed.component})`,
    `- Continuation dispatches: ${report.dispatchSequence.join(', ')}`,
    `- Reused unchanged components: ${report.unchangedReusedComponents.join(', ')}`,
    `- Producer/continuation PIDs: ${report.processes.producerPid} / ${report.processes.continuationPid}`,
    `- Session: \`${report.processes.sessionId}\` (same session: ${report.processes.sameSession})`,
    `- Project reconciliation receipt IDs: baseline \`${projectReceipts.baseline}\` -> replacement \`${projectReceipts.replacement}\``,
    `- Catalog revalidation receipt IDs: baseline \`${catalogReceipts.baseline}\` -> replacement \`${catalogReceipts.replacement}\``,
    '',
    'Invariants:',
    '',
    `- Checkpoint event prefix byte-identical: ${report.invariants.checkpointPrefixByteIdentical}`,
    `- Restore equals live / re-export canonical: ${report.invariants.restoreEqualsLive} / ${report.invariants.restoreReexportCanonical}`,
    `- Replay equals live projection: ${report.invariants.replayEqualsLive}`,
    `- Repeat mutation count / fake Probe calls / receipt count: ${report.invariants.repeat.mutationEventCount} / ${report.invariants.repeat.fakeProbeCalls} / ${report.invariants.repeat.receiptCount}`,
    `- Malformed, foreign, non-quiescent, standalone-inactivation, and retired-receipt-rebind inputs rejected: ${report.invariants.negatives.malformed && report.invariants.negatives.foreign && report.invariants.negatives.nonquiescent && report.invariants.negatives.standaloneInactivation && report.invariants.negatives.retiredReceiptRebind}`,
    '',
    `- Effective runtime root: \`${report.runtimeConfig.effectiveProjectRoot}\``,
    `- Checkpoint graph digest / effective-config digest: \`${report.checkpoint.graphSemanticDigest}\` / \`${report.runtimeConfig.graphSemanticDigest}\``,
    `- Checkpoint portable after run: ${report.checkpointPortability.checkpointPortableAfterRun} (${report.checkpointPortability.reason})`,
    '',
    'The graph is generated from the bundled human-readable `visor.template.yaml`; checkpoint and report files are runtime evidence.',
    '',
  ].join('\n');
}

function renderGraph(dotPath: string, outputDirectory: string): string[] {
  try {
    execFileSync('dot', ['-V'], { stdio: 'ignore' });
  } catch {
    return [];
  }
  const outputs = [
    ['-Tsvg', 'graph.svg'],
    ['-Tpng', 'graph.png'],
  ] as const;
  for (const [format, name] of outputs)
    execFileSync('dot', [format, dotPath, '-o', path.join(outputDirectory, name)], {
      stdio: 'ignore',
    });
  return outputs.map(([, name]) => name);
}

function main(): void {
  const outputDirectory = path.resolve(
    process.argv[2] || path.join(os.tmpdir(), `visor-exp-0209-discovery-egress-demo-${process.pid}`)
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  const stagingDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'visor-exp-0209-discovery-egress-staging-')
  );
  try {
    runChild('produce', stagingDirectory);
    runChild('continue', stagingDirectory);
    runChild('negative', stagingDirectory);
    const baseline = readJson(path.join(stagingDirectory, 'baseline.json'));
    const continuation = readJson(path.join(stagingDirectory, 'continuation.json'));
    const repeat = readJson(path.join(stagingDirectory, 'repeat.json'));
    const negative = readJson(path.join(stagingDirectory, 'negative.json'));
    const baselineCheckpoint = JSON.parse(baseline.checkpoint) as JsonRecord;
    const continuedCheckpoint = JSON.parse(continuation.checkpoint) as JsonRecord;
    const effectivePlan = compileClaimPlan(baseline.config);
    const effectiveGraphSemanticDigest = effectivePlan.expansionPlan.graphSemanticDigest;
    assertInvariant('effective runtime graph digest is present', typeof effectiveGraphSemanticDigest === 'string' && effectiveGraphSemanticDigest.length > 0);
    assertInvariant('baseline checkpoint uses effective runtime graph digest', baselineCheckpoint.graphSemanticDigest === effectiveGraphSemanticDigest);
    assertInvariant('continuation checkpoint preserves effective runtime graph digest', continuedCheckpoint.graphSemanticDigest === effectiveGraphSemanticDigest);
    const prefixLength = baselineCheckpoint.events.length;
    const dispatches = dispatchSequence(continuedCheckpoint, continuation.projection, prefixLength);
    const expectedDispatches = [
      'alpha:inspect',
      'alpha:proof_admit',
      'alpha:verify',
      'journalservice:project_reconcile',
    ];
    const baselineProject = Object.values(baseline.projection.instancesById).find(
      (value: JsonRecord) => value.itemKey === 'journalservice' && !value.parentSubgraphInstanceId
    ) as JsonRecord | undefined;
    assertInvariant('baseline project instance', baselineProject);
    const baselineGenerations = Object.values(baseline.projection.generationsById).filter(
      (value: JsonRecord) => value.subgraphInstanceId === baselineProject.subgraphInstanceId && value.checkId === 'project_reconcile'
    ) as JsonRecord[];
    const baselineReconcileGeneration = baselineGenerations.find(value => value.status === 'completed');
    assertInvariant('baseline completed project_reconcile generation', baselineReconcileGeneration);
    const baselineProjectReceipts = Object.values(baseline.projection.claimsById).filter(
      (value: JsonRecord) => value.claim === 'proof.project_reconciliation_receipt@1' && value.subgraphInstanceId === baselineProject.subgraphInstanceId
    ) as JsonRecord[];
    assertInvariant('one active baseline project reconciliation receipt', baselineProjectReceipts.length === 1 && baselineProjectReceipts[0].active === true);
    const baselineReceipt = projectReconciliationReceipt(baseline.projection, true);
    const continuedProjectReceipts = Object.values(continuation.projection.claimsById).filter(
      (value: JsonRecord) => value.claim === 'proof.project_reconciliation_receipt@1' && value.subgraphInstanceId === baselineProject.subgraphInstanceId
    ) as JsonRecord[];
    const replacementReceipt = projectReconciliationReceipt(continuation.projection, true);
    assertInvariant('baseline and replacement project reconciliation receipts', baselineReceipt && replacementReceipt);
    assertInvariant('exactly two project reconciliation receipts after continuation', continuedProjectReceipts.length === 2);
    assertInvariant('exactly one active replacement receipt', continuedProjectReceipts.filter(value => value.active === true).length === 1);
    assertInvariant('baseline receipt retired', continuation.projection.claimsById[baselineReceipt.claimId]?.active === false);
    const continuedGenerations = Object.values(continuation.projection.generationsById).filter(
      (value: JsonRecord) => value.subgraphInstanceId === baselineProject.subgraphInstanceId && value.checkId === 'project_reconcile'
    ) as JsonRecord[];
    const replacementGeneration = continuedGenerations.find(
      value => value.nodeGenerationId !== baselineReconcileGeneration.nodeGenerationId && value.status === 'completed'
    );
    assertInvariant('old project_reconcile generation retired', continuation.projection.generationsById[baselineReconcileGeneration.nodeGenerationId]?.status === 'inactive');
    assertInvariant('one completed replacement project_reconcile generation', continuedGenerations.length === 2 && replacementGeneration);
    assertInvariant('replacement receipt is the generation output', replacementGeneration.completedOutputClaimIds.length === 1 && replacementGeneration.completedOutputClaimIds[0] === replacementReceipt.claimId);
    assertInvariant('replacement generation is active', continuation.projection.activeGenerationIdByNode[replacementGeneration.nodeInstanceId] === replacementGeneration.nodeGenerationId);

    const componentKeys = ['alpha', 'beta', 'gamma'];
    assertInvariant('baseline contains all component slices', componentKeys.every(component => componentSlice(baseline.projection, component)));
    assertInvariant('continuation contains all component slices', componentKeys.every(component => componentSlice(continuation.projection, component)));
    const changedComponents = componentKeys.filter(component => jsonBytes(componentSlice(baseline.projection, component)) !== jsonBytes(componentSlice(continuation.projection, component)));
    const unchangedComponents = componentKeys.filter(component => jsonBytes(componentSlice(baseline.projection, component)) === jsonBytes(componentSlice(continuation.projection, component)));
    assertInvariant('only alpha component changed', jsonBytes(changedComponents) === jsonBytes(['alpha']) && jsonBytes(unchangedComponents) === jsonBytes(['beta', 'gamma']));
    assertInvariant('exactly alpha.go edited', jsonBytes(continuation.editedPaths) === jsonBytes(['alpha.go']));
    assertInvariant('beta source unchanged', baseline.sourceDigests['beta.go'] === continuation.sourceAfter['beta.go']);
    assertInvariant('gamma source unchanged', baseline.sourceDigests['gamma.go'] === continuation.sourceAfter['gamma.go']);
    assertInvariant('alpha source changed', baseline.sourceDigests['alpha.go'] !== continuation.sourceAfter['alpha.go']);
    assertInvariant('continuation component Probe dispatch', jsonBytes(continuation.calls) === jsonBytes(['alpha']) && jsonBytes(continuation.probeDispatches) === jsonBytes([{ kind: 'component', componentId: 'alpha' }]));
    assertInvariant('producer and continuation are distinct processes', baseline.pid !== continuation.pid);
    assertInvariant('checkpoint session is preserved', baselineCheckpoint.sessionId === continuedCheckpoint.sessionId);
    assertInvariant('checkpoint prefix is present and canonical', prefixLength > 0 && baseline.checkpoint === jsonBytes(baselineCheckpoint) && continuation.checkpoint === jsonBytes(continuedCheckpoint));
    assertInvariant('checkpoint prefix is byte-identical', jsonBytes(continuedCheckpoint.events.slice(0, prefixLength)) === jsonBytes(baselineCheckpoint.events));
    assertInvariant('exact continuation dispatch sequence', jsonBytes(dispatches) === jsonBytes(expectedDispatches));
    assertInvariant('restore equals live', jsonBytes(continuation.restored) === jsonBytes(continuation.projection));
    assertInvariant('restore re-export is canonical', continuation.restoredReexport === continuation.checkpoint);
    assertInvariant('replay equals live', jsonBytes(continuation.replay) === jsonBytes(continuation.projection));
    assertInvariant('outer project receipt identity is fresh', baselineReceipt.payload.receipt_id !== replacementReceipt.payload.receipt_id);
    assertInvariant('nested catalog revalidation identity is fresh', baselineReceipt.payload.catalog_revalidation_receipt.receipt_id !== replacementReceipt.payload.catalog_revalidation_receipt.receipt_id);
    assertInvariant('repeat is a semantic no-op', repeat.mutationEventCount === 0 && repeat.calls.length === 0 && repeat.probeDispatches.length === 0 && repeat.receiptCount === 2);
    const repeatCheckpoint = JSON.parse(repeat.checkpoint) as JsonRecord;
    assertInvariant('repeat checkpoint is canonical', repeat.checkpoint === jsonBytes(repeatCheckpoint));
    const repeatSuffix = repeatCheckpoint.events.slice(continuedCheckpoint.events.length);
    assertInvariant('repeat has no generation or attempt mutations', repeatSuffix.every((event: JsonRecord) => !['AttemptStarted', 'NodeGenerationActivated', 'NodeGenerationInactivated'].includes(event.type)));
    assertInvariant('all negative checkpoint inputs are rejected', negative.calls.length === 0 && negative.malformed === true && negative.foreign === true && negative.nonquiescent === true && negative.standaloneInactivation === true && negative.retiredReceiptRebind === true);
    const report: JsonRecord = {
      job: 'EXP-0209 deterministic Proof onboarding / re-onboarding checkpoint continuation',
      changed: { file: continuation.editedPaths[0], component: changedComponents[0] },
      dispatchSequence: dispatches,
      unchangedReusedComponents: unchangedComponents,
      receiptIds: {
        projectReconciliation: {
          baseline: baselineReceipt.payload.receipt_id,
          replacement: replacementReceipt.payload.receipt_id,
        },
        catalogRevalidation: {
          baseline: baselineReceipt.payload.catalog_revalidation_receipt.receipt_id,
          replacement: replacementReceipt.payload.catalog_revalidation_receipt.receipt_id,
        },
      },
      checkpoint: {
        graphSemanticDigest: baselineCheckpoint.graphSemanticDigest,
        effectiveConfigMatches: baselineCheckpoint.graphSemanticDigest === effectiveGraphSemanticDigest && continuedCheckpoint.graphSemanticDigest === effectiveGraphSemanticDigest,
      },
      runtimeConfig: {
        template: 'visor.template.yaml',
        effective: 'effective-config.yaml',
        graphSemanticDigest: effectiveGraphSemanticDigest,
        effectiveProjectRoot: baseline.config.checks.project.value.projects[0].root,
      },
      checkpointPortability: {
        checkpointPortableAfterRun: false,
        reason: 'The fixture repository and absolute project root are temporary and removed after this run; path rebinding is not claimed.',
      },
      processes: {
        producerPid: baseline.pid,
        continuationPid: continuation.pid,
        sessionId: baselineCheckpoint.sessionId,
        sameSession: baselineCheckpoint.sessionId === continuedCheckpoint.sessionId,
      },
      invariants: {
        checkpointEventPrefixLength: prefixLength,
        checkpointPrefixByteIdentical:
          jsonBytes(continuedCheckpoint.events.slice(0, prefixLength)) ===
          jsonBytes(baselineCheckpoint.events),
        restoreEqualsLive: jsonBytes(continuation.restored) === jsonBytes(continuation.projection),
        restoreReexportCanonical: continuation.restoredReexport === continuation.checkpoint,
        replayEqualsLive: jsonBytes(continuation.replay) === jsonBytes(continuation.projection),
        repeat: {
          mutationEventCount: repeat.mutationEventCount,
          fakeProbeCalls: repeat.calls.length,
          receiptCount: repeat.receiptCount,
          noThirdReceipt: repeat.receiptCount === 2,
        },
        negatives: {
          malformed: negative.malformed,
          foreign: negative.foreign,
          nonquiescent: negative.nonquiescent,
          standaloneInactivation: negative.standaloneInactivation,
          retiredReceiptRebind: negative.retiredReceiptRebind,
        },
      },
    };

    const profileBytes = fs.readFileSync(PROFILE);
    const stagedDotPath = path.join(stagingDirectory, 'graph.dot');
    fs.writeFileSync(stagedDotPath, graphFromProfile(), 'utf8');
    fs.writeFileSync(path.join(stagingDirectory, 'visor.template.yaml'), profileBytes);
    fs.writeFileSync(
      path.join(stagingDirectory, 'effective-config.yaml'),
      yaml.dump(baseline.config, { noRefs: true, sortKeys: true, lineWidth: -1 }),
      'utf8'
    );
    const rendered = renderGraph(stagedDotPath, stagingDirectory);
    report.graph = { source: 'visor.template.yaml', dot: 'graph.dot', rendered };
    const artifactNames = ['baseline.checkpoint.json', 'continued.checkpoint.json', 'visor.template.yaml', 'effective-config.yaml', 'graph.dot', ...rendered];
    fs.writeFileSync(path.join(stagingDirectory, 'baseline.checkpoint.json'), baseline.checkpoint, 'utf8');
    fs.writeFileSync(path.join(stagingDirectory, 'continued.checkpoint.json'), continuation.checkpoint, 'utf8');
    fs.writeFileSync(
      path.join(stagingDirectory, 'demo-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(stagingDirectory, 'demo-report.md'),
      markdownReport(report, outputDirectory),
      'utf8'
    );
    for (const name of [...artifactNames, 'demo-report.json', 'demo-report.md'])
      fs.copyFileSync(path.join(stagingDirectory, name), path.join(outputDirectory, name));
    process.stdout.write(`EXP-0209 demo artifacts written to ${outputDirectory}\n`);
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
