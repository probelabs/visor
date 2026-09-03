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
sourceFiles['http.go'] = Array.from({ length: 80 }, (_, index) => index === 45 ? 'decodeErr := json.NewDecoder(r.Body).Decode(&request)' : index === 46 ? 'if decodeErr != nil {' : index === 47 ? 'writeJSONError(w, 400, "invalid JSON")' : index === 48 ? 'return' : index === 49 ? '}' : '').join('\n');
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
    const result = evaluateOnboardingQuality(fixture());
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
