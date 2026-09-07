import {describe, expect, it, jest} from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {canonicalJson, immutableCanonicalValue} from '../../src/state-machine/graph/claim-kernel';

// The default Jest setup replaces asynchronous child_process.spawn.  The
// retained path exercises the real managed Proof transport, so restore both
// aliases before dynamically importing the runner and providers.
jest.unmock('child_process');
jest.unmock('node:child_process');

type Json = Record<string, any>;

// This is an opt-in integration fixture.  Its Proof binary, already-promoted
// subject, and retained export are deliberately supplied by the caller so a
// checkout cannot accidentally read another machine's campaign state.
const proofBinary = process.env.PROOF_BIN || '';
const retainedExport = process.env.NATIVE_RETAINED_EXPORT_ROOT || '';
const sourceSubject = process.env.NATIVE_RETAINED_SUBJECT_ROOT || '';
const proofReady = (() => {
  if (!proofBinary) return false;
  try {
    const stat = fs.statSync(proofBinary);
    return path.isAbsolute(proofBinary) && stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
})();
if (proofBinary && !proofReady) throw new Error(`PROOF_BIN is configured but is not executable: ${proofBinary}`);
const inputsReady = Boolean(proofBinary && retainedExport && sourceSubject) &&
  fs.existsSync(retainedExport) && fs.existsSync(sourceSubject);
const describeRetained = inputsReady ? describe : describe.skip;

const COMPONENT_PATHS: Readonly<Record<string, readonly string[]>> = {
  'jsonparser-core': ['go.mod', 'go.sum', 'parser.go', 'parser_error_test.go', 'parser_test.go'],
  'byte-representation-adapters': ['bytes.go', 'bytes_safe.go', 'bytes_test.go', 'bytes_unsafe.go', 'bytes_unsafe_test.go'],
  'json-string-escape-codec': ['escape.go', 'escape_test.go'],
  'parser-fuzz-harness': ['fuzz.go'],
  'benchmark-suite': [
    'benchmark/benchmark.go', 'benchmark/benchmark_codecgen.go', 'benchmark/benchmark_delete_test.go',
    'benchmark/benchmark_easyjson.go', 'benchmark/benchmark_ffjson.go', 'benchmark/benchmark_large_payload_test.go',
    'benchmark/benchmark_medium_payload_test.go', 'benchmark/benchmark_small_payload_test.go',
    'benchmark/go.mod', 'benchmark/go.sum',
  ],
};
const COMPONENT_IDS = Object.keys(COMPONENT_PATHS).sort();
const FORBIDDEN_CHECKS = new Set([
  'author-native-component', 'promote-native-component', 'enumerate-native-requirements',
  'review-native-item', 'collect-proof-evidence', 'role-onboard-component',
  'role-spec-review-component', 'wait-for-native-items',
]);

function componentCandidate(projectId: string): Json {
  return immutableCanonicalValue({
    version: 'proof.component-catalog-candidate/v1',
    project_id: projectId,
    components: COMPONENT_IDS.map(componentId => ({
      id: componentId,
      responsibility: `Fresh no-model retained continuation fixture for ${componentId}`,
      owned_paths: [...COMPONENT_PATHS[componentId]],
      dependency_closure: [...COMPONENT_PATHS[componentId]],
    })),
  });
}

function componentData(subject: Json): Json {
  const firstPath = subject.sorted_owned_paths[0];
  const coordinate = {path: firstPath, line: 1};
  return immutableCanonicalValue({
    schema: 'reqproof.component-onboarding/v1',
    project: subject.project_id,
    shard: subject.component_id,
    reviewedFiles: subject.sorted_owned_paths.map((value: string) => ({path: value, coordinates: [coordinate]})),
    requirements: ['STK', 'SYS', 'SW', 'INT'].map((kind, index) => ({
      id: `${kind}-${subject.component_id}-${index + 1}`,
      text: `${kind} synthetic no-model evidence`,
      coordinates: [coordinate],
    })),
    interfaces: [{name: `${subject.component_id}-boundary`, coordinates: [coordinate]}],
    findings: [{
      id: `finding-${subject.component_id}`,
      severity: 'info',
      title: 'Synthetic no-model retained fixture',
      calibration: 'confirmed',
      confidence: 1,
      coordinates: [coordinate],
    }],
    unknowns: [],
    repositoryMutated: false,
    commandsExecuted: false,
    checklistCompleted: false,
  });
}

function fakeRunnerFactory(candidate: Json, governedResultDigest: (value: unknown) => string): any {
  return (request: any) => ({
    preview: () => ({source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'c'.repeat(64)}`, promptBytes: 0}),
    answer: () => {
      const data = request.invocation.subject.kind === 'project'
        ? candidate
        : componentData(request.invocation.component_authority.subject);
      const canonicalBytes = canonicalJson(data);
      const digest = 'a'.repeat(64);
      return {
        data,
        runtimeAttestation: {
          version: 'probe.governed-codex-attestation/v2',
          profileId: 'luna-xhigh-readonly-v1',
          requested: {
            profileDigest: digest, cwdDigest: digest, probeToolsDigest: digest,
            model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never',
          },
          observed: {
            source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai',
            reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: digest,
            permissionProfileDigest: digest, filesystem: 'restricted-read-root', network: 'restricted',
          },
          executionContext: {source: 'caller', invocationDigest: request.invocationDigest},
          dispatch: {source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'c'.repeat(64)}`, promptBytes: 0},
          evidence: {eventCount: 1}, usage: {status: 'unavailable'},
        },
        resultIdentity: {
          version: 'probe.governed-result-identity/v1',
          source: 'probe-host-schema-valid-json',
          resultDigest: governedResultDigest(data),
          canonicalBytes: Buffer.byteLength(canonicalBytes, 'utf8'),
        },
      };
    },
    cancel: () => undefined,
    close: () => undefined,
  });
}

function cloneSubject(): {root: string; output: string} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-native-retained-'));
  const subject = path.join(root, 'subject');
  fs.cpSync(sourceSubject, subject, {recursive: true});
  const output = path.join(root, 'output');
  fs.mkdirSync(output, {recursive: true, mode: 0o700});
  return {root, output};
}

function attemptEvents(checkpoint: Json): Json[] {
  return checkpoint.events.filter((event: Json) => event && event.type === 'AttemptStarted');
}

function componentClaims(projection: Json, componentId: string, claim: string, producerCheckId: string): Json[] {
  return Object.values(projection.claimsById).filter((value: any) => value.active === true && value.claim === claim && value.producerCheckId === producerCheckId &&
    Array.isArray(value.scope) && value.scope[value.scope.length - 1]?.key === componentId);
}

describeRetained('native onboarding retained continuation (real Proof, engine gate/resume)', () => {
  jest.setTimeout(180_000);

  it('revalidates the actual retained archive, gates the fresh prefix, and resumes the permanent suffix', async () => {
    const phaseLogPath = process.env.NATIVE_RETAINED_TEST_LOG;
    const runId = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const phase = (event: string, details: Json = {}): void => {
      if (!phaseLogPath) return;
      fs.mkdirSync(path.dirname(phaseLogPath), {recursive: true});
      fs.appendFileSync(phaseLogPath, `${JSON.stringify({
        run_id: runId,
        event,
        at: new Date().toISOString(),
        ...details,
      })}\n`, {encoding: 'utf8', mode: 0o600});
    };
    const publicError = (error: unknown): Json => ({
      name: error instanceof Error ? error.name : 'UnknownError',
      message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    phase('run-start');
    jest.resetModules();
    jest.doMock('child_process', () => jest.requireActual('child_process'));
    jest.doMock('node:child_process', () => jest.requireActual('node:child_process'));
    const [runner, sdk, registryModule, governedModule, capabilityModule] = await Promise.all([
      import('../../examples/agent-governance/native-onboarding/run-onboarding'),
      import('../../src/sdk'),
      import('../../src/providers/check-provider-registry'),
      import('../../src/providers/governed-proof-inspect-check-provider'),
      import('../../src/providers/proof-admission-cli-child'),
    ]);
    const paths = cloneSubject();
    let assertionsComplete = false;
    const previousProofBin = process.env.PROOF_BIN;
    const previousCwd = process.cwd();
    try {
      const capability = capabilityModule.createProofAdmissionCapability(proofBinary);
      process.env.PROOF_BIN = proofBinary;
      const registry = registryModule.CheckProviderRegistry.getInstance();
      registry.bootstrapProofAdmission(capability);
      phase('prepare-start', {fixture_root: paths.root, proof_output: paths.output});
      const preparation = await runner.loadRetainedContinuationConfig(
        retainedExport, proofBinary, paths.root + '/subject', paths.output, 120_000,
      );
      phase('prepare-end', {
        packet_count: preparation.retained.packetCount,
        current_requirement_count: preparation.currentRequirements.length,
        aggregate_component_count: Object.keys(preparation.aggregateMap).length,
      });
      expect(preparation.retained.packetCount).toBe(92);
      expect(preparation.currentRequirements).toHaveLength(92);
      expect(Object.keys(preparation.aggregateMap).sort()).toEqual(COMPONENT_IDS);
      expect(preparation.aggregateMapBase64).toBe(Buffer.from(preparation.aggregateMapBase64, 'base64').toString('base64'));

      const inventory = JSON.parse(fs.readFileSync(path.join(paths.output, 'preflight/inventory.json'), 'utf8')) as Json;
      const projectId = inventory.authority.project_id;
      const candidate = componentCandidate(projectId);
      // The shipped demo disables Visor worktree isolation.  Match the
      // runner's launch boundary so command checks inherit the cloned
      // initialized subject as their cwd.
      process.chdir(paths.root + '/subject');
      const governed = governedModule.createGovernedProofInspectProviderForFocusedTest(
        fakeRunnerFactory(candidate, governedModule.governedResultDigest), capability,
      );
      // bootstrapProofAdmission intentionally installs the controller-owned
      // provider. This test substitutes only the governed inspect boundary;
      // every Proof admission/catalog/reconcile provider remains real.
      (registry as any).providers.set('governed-proof-inspect', governed);

      const engine = new sdk.StateMachineExecutionEngine(paths.root + '/subject');
      phase('prefix-start', {expected_component_count: COMPONENT_IDS.length});
      const engineRun = await runner.executeRetainedContinuationEngine(
        engine,
        preparation.config,
        120_000,
        COMPONENT_IDS,
        frontier => {
          phase('prefix-end');
          phase('frontier-saved', {
            component_attempts_started: frontier.componentAttemptsStarted,
            zero_component_attempts: frontier.zeroComponentAttempts,
            sets_equal: frontier.setsEqual,
            materialized_component_count: frontier.materializedComponentIds.length,
          });
          phase('resume-start');
        }
      );
      phase('resume-end', {failed_executions: engineRun.result.statistics.failedExecutions});
      expect(engineRun.initialResult.statistics.failedExecutions).toBe(0);
      expect(engineRun.result.statistics.failedExecutions).toBe(0);
      const frontier = engineRun.frontier.checkpoint;
      const checkpoint = engineRun.checkpoint;
      expect(runner.retainedFrontierHasNoComponentAttempts(frontier)).toBe(true);
      expect(runner.materializedComponentIds(preparation.config, frontier)).toEqual(COMPONENT_IDS);
      expect(attemptEvents(frontier).some(event => Array.isArray(event.scope) && event.scope.length > 1)).toBe(false);
      expect(attemptEvents(frontier).some(event => FORBIDDEN_CHECKS.has(event.checkId))).toBe(false);
      const projection = engine.getInstanceProjection() as any;
      expect(Object.values(projection.generationsById).some((generation: any) => FORBIDDEN_CHECKS.has(generation.checkId))).toBe(false);
      expect(runner.retainedContinuationCheckpointIsComplete(preparation.config, checkpoint, COMPONENT_IDS)).toBe(true);

      for (const componentId of COMPONENT_IDS) {
        const candidates = componentClaims(projection, componentId, 'proof.candidate@1', 'inspect');
        const receipts = componentClaims(projection, componentId, 'proof.admitted_receipt@1', 'proof_admit');
        const staged = componentClaims(projection, componentId, 'proof.component_spec_review_candidate@1', 'spec_review');
        const stagedReceipts = componentClaims(projection, componentId, 'proof.component_spec_review_admitted_receipt@1', 'spec_review_admit');
        expect(candidates).toHaveLength(1);
        expect(receipts).toHaveLength(1);
        expect(staged).toHaveLength(1);
        expect(stagedReceipts).toHaveLength(1);
        expect(candidates[0].parentClaimIds).toHaveLength(2);
        expect(staged[0].parentClaimIds).toHaveLength(3);
        expect(preparation.aggregateMap[componentId]).toEqual(expect.objectContaining({
          component_id: componentId,
          source: expect.objectContaining({kind: 'retained_checkpoint'}),
          reviews: expect.arrayContaining([expect.objectContaining({
            component_id: componentId,
            retained_claim: expect.objectContaining({claim_id: expect.any(String)}),
          })]),
        }));
        expect((receipts[0].payload as Json).Status).toBe('ADMITTED');
        expect((stagedReceipts[0].payload as Json).Status).toBe('ADMITTED');
      }
      const reconciliations = Object.values(projection.claimsById).filter((claim: any) => claim.active && claim.claim === 'proof.project_reconciliation_receipt@1');
      expect(reconciliations).toHaveLength(1);
      expect((reconciliations[0] as any).payload.component_admissions).toHaveLength(COMPONENT_IDS.length);

      const restored = runner.retainedContinuationCheckpointIsComplete(preparation.config, JSON.parse(JSON.stringify(checkpoint)), COMPONENT_IDS);
      expect(restored).toBe(true);
      expect(projection).toEqual(engine.replayInstanceProjection());
      phase('assertions-complete', {component_count: COMPONENT_IDS.length});
      assertionsComplete = true;
    } catch (error) {
      phase('assertion-error', {error: publicError(error)});
      throw error;
    } finally {
      registryModule.CheckProviderRegistry.clearInstance();
      if (previousProofBin === undefined) delete process.env.PROOF_BIN;
      else process.env.PROOF_BIN = previousProofBin;
      process.chdir(previousCwd);
      if (assertionsComplete) {
        fs.rmSync(paths.root, {recursive: true, force: true});
      } else {
        phase('fixture-retained', {fixture_root: paths.root, proof_output: paths.output});
      }
    }
  });
});
