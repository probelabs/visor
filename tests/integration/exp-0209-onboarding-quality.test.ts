import { describe, expect, it } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { activeOnboardingWorkItemsFromCheckpoint, evaluateOnboardingQuality } from '../../examples/agent-governance/exp-0209-discovery-egress/run-live-demo';

const REPO_ROOT = resolve(__dirname, '../..');
const DETERMINISTIC_FIXTURE = join(REPO_ROOT, 'tests/fixtures/proof-current-catalog-checkpoint-child.ts');

const files = ['http.go', 'http_test.go', 'service.go', 'service_test.go', 'entry.go', 'store.go', 'go.mod'];
const sourceFiles = Object.fromEntries(files.map(file => [file, Array.from({ length: 80 }, () => '').join('\n')]));
sourceFiles['http.go'] = Array.from({ length: 80 }, (_, index) => index === 42 ? 'decoder := json.NewDecoder(r.Body)' : index === 43 ? 'decodeErr := decoder.Decode(&request)' : index === 44 ? 'if decodeErr == nil && decoder.Decode(&struct{}{}) != io.EOF {' : index === 45 ? 'decodeErr = errors.New("extra JSON value")' : index === 46 ? '}' : index === 47 ? 'if decodeErr != nil {' : index === 48 ? 'writeJSONError(w, 400, "invalid JSON")' : index === 49 ? 'return' : index === 50 ? '}' : '').join('\n');
sourceFiles['http_test.go'] = Array.from({ length: 80 }, (_, index) => index === 43 ? 'func TestMalformedWriteDoesNotPersist(t *testing.T) {' : index === 53 ? '}' : '').join('\n');
const baselineSourceFiles = { ...sourceFiles, 'http.go': sourceFiles['http.go'].replace('\nreturn\n', '\n// missing return\n') };

const coordinate = (path: string, line: number) => ({ path, line });
const component = (id: string, ownedPaths: string[], resolved = false): Record<string, unknown> => ({
  id,
  owned_paths: ownedPaths,
  dependency_closure: ownedPaths,
  reviewedFiles: ownedPaths.map(path => ({ path, coordinates: [coordinate(path, 1)] })),
  requirements: [{ id: `requirement-${id}`, text: resolved ? 'Malformed decode rejection has no persistence or effect.' : 'Reviewed.', coordinates: [coordinate(ownedPaths[0], 1)] }],
  interfaces: [{ name: `${id}-interface`, coordinates: [coordinate(ownedPaths[0], 1)] }],
  findings: [resolved
    ? { id: `finding-${id}`, severity: 'info', text: 'Resolved malformed decode rejection has no persistence or effect; added return; TestMalformedWriteDoesNotPersist.', coordinates: [coordinate('http.go', 50), coordinate('http_test.go', 44)] }
    : { id: `finding-${id}`, severity: id === 'http' ? 'medium' : 'info', likelihood: 'likely', confidence: 0.9, text: id === 'http' ? 'Malformed decode error falls through to a mutation and effect.' : 'No blocking finding.', coordinates: [coordinate(id === 'http' ? 'http.go' : ownedPaths[0], id === 'http' ? 48 : 1)] }],
});

function fixture() {
  const components = [
    component('http', ['http.go', 'http_test.go']),
    component('service', ['service.go', 'service_test.go']),
    component('entry', ['entry.go', 'store.go', 'go.mod']),
  ];
  const resumed = [component('http', ['http.go', 'http_test.go'], true), components[1], components[2]];
  return {
    baselineCandidate: { components },
    baselineComponentCandidates: components,
    resumeComponentCandidates: resumed,
    workItems: components.map(value => ({ component_id: value.id, sorted_owned_paths: value.owned_paths })),
    sourceFiles,
    baselineSourceFiles,
    patchedSourceFiles: sourceFiles,
    changedComponentId: 'http',
    oracle: { baseline: { status: 1, failed: true, expected_failure_marker: true, tree_sha256: 'baseline-tree', hidden_test_sha256: 'hidden' }, patched: { status: 0, passed: true, tree_sha256: 'patched-tree', hidden_test_sha256: 'hidden' } },
  };
}

describe('EXP-0209 onboarding quality gate', () => {
  it('scores a complete controller evidence fixture at seven', () => {
    const evidence = fixture();
    expect(evidence.baselineCandidate.components).toHaveLength(3);
    expect(evidence.workItems).toHaveLength(3);
    expect(evidence.baselineCandidate.components.flatMap((value: any) => value.owned_paths).sort()).toEqual(files.slice().sort());
    const result = evaluateOnboardingQuality(evidence);
    expect(result.score).toBe(7);
    expect(result.overall_pass).toBe(true);
    expect(result.criteria).toHaveLength(7);
  });

  it('accepts the exact runEvaluationOracle producer shape', () => {
    const result = evaluateOnboardingQuality(fixture());
    expect(result.criterion_results.hidden_oracle.pass).toBe(true);
    expect(result.criterion_results.hidden_oracle.details.baseline_failed_expected_marker).toBe(true);
    expect(result.criterion_results.hidden_oracle.details.patched_passed).toBe(true);
  });

  it('accepts the retained Attempt010 HTTP decoder finding wording', () => {
    const value = fixture();
    value.baselineComponentCandidates[0].findings[0] = {
      id: 'F-HTTP-DECODER-001',
      severity: 'medium',
      title: 'A valid JSON draft followed by another JSON value makes the second decode fail the EOF check at http.go:45 and sets decodeErr at http.go:46. writeEntry emits a 400 response at http.go:48-50 but does not return. It then calls Service.Create at http.go:51, which can pass validation at service.go:49-58, commit the entry at store.go:36-46, and invoke the notifier at service.go:63-65. The client can receive an invalid-JSON result while journal state changes.',
      calibration: 'confirmed',
      confidence: 0.99,
      coordinates: [coordinate('http.go', 45), coordinate('http.go', 48), coordinate('http.go', 51), coordinate('service.go', 59), coordinate('store.go', 42)],
    };
    expect(evaluateOnboardingQuality(value).criterion_results.baseline_http_candidate.pass).toBe(true);
  });

  it.each(['can', 'may', 'does'])('recognizes %s as control-flow evidence only with decode and effect evidence', (controlWord) => {
    const value = fixture();
    value.baselineComponentCandidates[0].findings[0].text = `Malformed JSON ${controlWord} still fall through to a persisted state effect.`;
    expect(evaluateOnboardingQuality(value).criterion_results.baseline_http_candidate.pass).toBe(true);
    value.baselineComponentCandidates[0].findings[0].text = `The request ${controlWord} fall through.`;
    expect(evaluateOnboardingQuality(value).criterion_results.baseline_http_candidate.pass).toBe(false);
  });

  it('accepts Attempt010 wording, ignores an unrelated notifier persistence finding, and rejects an unresolved decoder signature', () => {
    const value = fixture();
    value.resumeComponentCandidates[0].findings[0].text = 'Attempt010: malformed JSON decode did not return at the HTTP boundary; persistence/state effect is now prevented; added return; TestMalformedWriteDoesNotPersist.';
    expect(evaluateOnboardingQuality(value).criterion_results.resume_http_resolution.pass).toBe(true);
    value.resumeComponentCandidates[0].findings.push({ severity: 'medium', confidence: 0.95, likelihood: 'confirmed', text: 'Notifier persistence has no delivery isolation.', coordinates: [coordinate('service.go', 64)] });
    expect(evaluateOnboardingQuality(value).criterion_results.resume_http_resolution.pass).toBe(true);
    value.resumeComponentCandidates[0].findings[0].severity = 'medium';
    value.resumeComponentCandidates[0].findings[0].confidence = 0.95;
    value.resumeComponentCandidates[0].findings[0].likelihood = 'confirmed';
    value.resumeComponentCandidates[0].findings[0].text = 'Malformed JSON decode did not return at the HTTP boundary; persistence/state effect remains; TestMalformedWriteDoesNotPersist.';
    expect(evaluateOnboardingQuality(value).criterion_results.resume_http_resolution.pass).toBe(false);
  });

  it('accepts Attempt011 grouping and textual source citations', () => {
    const value = fixture();
    const actualGroups = [
      component('http', ['http.go', 'http_test.go']),
      component('service', ['entry.go', 'go.mod', 'service.go', 'service_test.go']),
      component('memory-store', ['store.go']),
    ];
    actualGroups[2].dependency_closure = ['entry.go', 'go.mod', 'store.go'];
    value.baselineCandidate.components = actualGroups;
    value.baselineComponentCandidates = actualGroups;
    value.workItems = actualGroups.map(group => ({ component_id: group.id, sorted_owned_paths: group.owned_paths }));
    const resolvedHttp = value.resumeComponentCandidates[0];
    value.resumeComponentCandidates = [resolvedHttp, actualGroups[1], actualGroups[2]];
    const finding: any = value.resumeComponentCandidates[0].findings[0];
    finding.coordinates = [coordinate('http_test.go', 44)];
    finding.text = 'Current http.go:45-50 checks malformed JSON and returns before http.go:52; the decoder has no persistence/state effect. TestMalformedWriteDoesNotPersist is named at http_test.go:44-55.';
    const result = evaluateOnboardingQuality(value);
    expect(result.score).toBe(7);
    expect(result.overall_pass).toBe(true);
    expect(result.criterion_results.resume_http_resolution.details.return_citation).toBe(true);
  });

  it('rejects a separated source/test group and a textual citation range that misses return', () => {
    const separated: any = fixture();
    separated.baselineComponentCandidates[0].owned_paths = ['http.go'];
    separated.baselineComponentCandidates[0].dependency_closure = ['http.go'];
    separated.baselineComponentCandidates[1].owned_paths.push('http_test.go');
    separated.baselineComponentCandidates[1].dependency_closure.push('http_test.go');
    expect(evaluateOnboardingQuality(separated).criterion_results.grouping.pass).toBe(false);
    const citation: any = fixture();
    const finding: any = citation.resumeComponentCandidates[0].findings[0];
    finding.coordinates = [coordinate('http_test.go', 44)];
    finding.text = 'Current http.go:45-49 checks malformed JSON and returns before http.go:52; the decoder has no persistence/state effect. TestMalformedWriteDoesNotPersist is named at http_test.go:44-55.';
    const result = evaluateOnboardingQuality(citation);
    expect(result.criterion_results.resume_http_resolution.details.return_citation).toBe(false);
    expect(result.criterion_results.resume_http_resolution.pass).toBe(false);
  });

  it('rejects an empty component ID', () => {
    const value: any = fixture();
    value.baselineComponentCandidates[0].id = '';
    expect(evaluateOnboardingQuality(value).criterion_results.grouping.pass).toBe(false);
  });

  it('recognizes ordinary create verb forms only when the control wording includes still', () => {
    const value = fixture();
    value.baselineComponentCandidates[0].findings[0].text = 'Malformed JSON can still create an entry';
    expect(evaluateOnboardingQuality(value).criterion_results.baseline_http_candidate.pass).toBe(true);
    value.baselineComponentCandidates[0].findings[0].text = 'Malformed JSON can create an entry';
    expect(evaluateOnboardingQuality(value).criterion_results.baseline_http_candidate.pass).toBe(false);
  });

  it('locates the invalid-JSON return with a one-based line while retaining citation tolerance', () => {
    const result = evaluateOnboardingQuality(fixture());
    expect(result.criterion_results.resume_http_resolution.details.scanned_spans).toEqual({ returnLine: 50, testStart: 44, testEnd: 54 });
    expect(result.criterion_results.resume_http_resolution.details.return_citation).toBe(true);
  });

  it('does not borrow a return from an unrelated later branch', () => {
    const value = fixture();
    const lines = value.sourceFiles['http.go'].split('\n');
    lines[49] = '}';
    lines[52] = 'if otherErr != nil {';
    lines[53] = 'return';
    lines[54] = '}';
    value.sourceFiles = { ...value.sourceFiles, 'http.go': lines.join('\n') };
    value.patchedSourceFiles = value.sourceFiles;
    const result = evaluateOnboardingQuality(value);
    expect(result.criterion_results.resume_http_resolution.details.scanned_spans.returnLine).toBeUndefined();
    expect(result.criterion_results.resume_http_resolution.pass).toBe(false);
  });

  it('rejects valid relative proof.yaml citations outside the component closure for baseline and resumed checks', () => {
    const value = fixture();
    const proofSource = Array.from({ length: 8 }, () => '').join('\n');
    value.sourceFiles = { ...value.sourceFiles, 'proof.yaml': proofSource };
    value.baselineSourceFiles = { ...value.baselineSourceFiles, 'proof.yaml': proofSource };
    value.patchedSourceFiles = { ...value.patchedSourceFiles, 'proof.yaml': proofSource };
    value.baselineComponentCandidates[0].reviewedFiles.push({ path: 'proof.yaml', coordinates: [coordinate('proof.yaml', 1)] });
    value.resumeComponentCandidates[0].reviewedFiles.push({ path: 'proof.yaml', coordinates: [coordinate('proof.yaml', 1)] });
    const result = evaluateOnboardingQuality(value);
    expect(result.criterion_results.coordinates.details.baseline.errors).toContain('http reviewed path');
    expect(result.criterion_results.coordinates.details.resumed_changed.errors).toContain('http reviewed path');
    expect(result.criterion_results.coordinates.pass).toBe(false);
  });

  it('rejects an otherwise-correct resolution when the http_test coordinate is outside lines 44 through 55', () => {
    const value = fixture();
    value.resumeComponentCandidates[0].findings[0].coordinates = [coordinate('http.go', 50), coordinate('http_test.go', 56)];
    const result = evaluateOnboardingQuality(value);
    expect(result.criterion_results.resume_http_resolution.details.test_citation).toBe(false);
    expect(result.criterion_results.resume_http_resolution.pass).toBe(false);
  });

  it('rejects an otherwise-correct resolution when the exact regression function name is absent', () => {
    const value = fixture();
    value.resumeComponentCandidates[0].findings[0].text = 'Resolved malformed decode rejection has no persistence or effect; added return; regression test covers it.';
    const result = evaluateOnboardingQuality(value);
    expect(result.criterion_results.resume_http_resolution.details.test_citation).toBe(false);
    expect(result.criterion_results.resume_http_resolution.pass).toBe(false);
  });

  it.each([
    ['grouping', (value: any) => { value.baselineCandidate.components[0].owned_paths = ['http.go']; }],
    ['coordinates', (value: any) => { value.resumeComponentCandidates[0].reviewedFiles[0].path = '../outside.go'; }],
    ['baseline defect', (value: any) => { value.baselineComponentCandidates[0].findings[0].severity = 'info'; }],
    ['baseline malformed-only finding', (value: any) => { value.baselineComponentCandidates[0].findings[0].text = 'Malformed JSON'; }],
    ['XSS false positive', (value: any) => { value.baselineComponentCandidates[1].findings.push({ severity: 'high', text: 'Potential XSS / HTML injection', confidence: 1, likelihood: 'confirmed' }); }],
    ['resolution', (value: any) => { value.resumeComponentCandidates[0].findings[0].text = 'Reviewed.'; value.resumeComponentCandidates[0].requirements[0].text = 'Reviewed.'; }],
  ])('rejects a representative %s mutation', (_label, mutate) => {
    const value = JSON.parse(JSON.stringify(fixture()));
    mutate(value);
    expect(evaluateOnboardingQuality(value).overall_pass).toBe(false);
  });

  it('rejects evaluation replay without overwriting the started marker', () => {
    const directory = mkdtempSync(join(tmpdir(), 'visor-exp0209-evaluation-replay-'));
    chmodSync(directory, 0o700);
    const marker = '{"status":"started","controller_pid":999999}\n';
    const markerPath = join(directory, 'evaluation.started.json');
    writeFileSync(markerPath, marker, { mode: 0o600 });
    try {
      const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', resolve(__dirname, '../../examples/agent-governance/exp-0209-discovery-egress/run-live-demo.ts'), '--evaluate-only', '--output', directory], { encoding: 'utf8', env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' } });
      expect(result.status).not.toBe(0);
      expect(readFileSync(markerPath, 'utf8')).toBe(marker);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('extracts ownership and coordinates from a real deterministic checkpoint without synthetic WorkItems', () => {
    const directory = mkdtempSync(join(tmpdir(), 'visor-exp0209-quality-checkpoint-'));
    try {
      execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', DETERMINISTIC_FIXTURE, 'produce', directory], {
        cwd: REPO_ROOT,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
        encoding: 'utf8',
        timeout: 180_000,
        stdio: 'pipe',
      });
      const artifact = JSON.parse(readFileSync(join(directory, 'baseline.json'), 'utf8')) as Record<string, any>;
      const checkpoint = JSON.parse(artifact.checkpoint) as Record<string, any>;
      const candidates = checkpoint.events
        .filter((event: Record<string, any>) => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1' && event.scope?.length === 2)
        .map((event: Record<string, any>) => event.payload);
      const root = artifact.config.checks.project.value.projects[0].root as string;
      const checkpointSources = Object.fromEntries(['alpha.go', 'beta.go', 'gamma.go'].map(file => [file, readFileSync(join(root, file), 'utf8')]));
      const workItems = activeOnboardingWorkItemsFromCheckpoint(checkpoint, artifact.config);
      expect(workItems.map(item => item.component_id).sort()).toEqual(['alpha', 'beta', 'gamma']);
      const result = evaluateOnboardingQuality({
        baselineCheckpoint: checkpoint,
        resumeCheckpoint: checkpoint,
        baselineComponentCandidates: candidates,
        resumeComponentCandidates: candidates,
        baselineSourceFiles: checkpointSources,
        patchedSourceFiles: checkpointSources,
        changedComponentId: 'alpha',
        oracle: { baseline: { status: 1, expected_failure_marker: true }, patched: { status: 0, passed: true } },
      });
      expect(result.criterion_results.ownership.details.work_item_paths).toEqual(['alpha.go', 'beta.go', 'gamma.go']);
      expect(result.criterion_results.coordinates.pass).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
