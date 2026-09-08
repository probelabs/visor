import { describe, expect, it } from '@jest/globals';
import {
  buildNativeChecklistProgress,
  renderNativeChecklistProgress,
} from '../../examples/agent-governance/native-onboarding/native-checklist-progress';
import { sha256Canonical } from '../../src/state-machine/graph/claim-kernel';

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'proof.checklist.show.v1',
    checklist: 'onboard_v1',
    active: true,
    new_project: true,
    definition_source: 'builtin',
    steps_total: 3,
    steps_pending: 2,
    counts: { confirmed: 1, skipped: 0, not_applicable: 0, pending: 2, blocked: 0 },
    ok: false,
    verify_failed: [],
    eligible_step_ids: ['research'],
    next: { step_id: 'research', title: 'Research' },
    steps: [
      {
        step_id: 'init',
        title: 'Init',
        when: 'new_project',
        requires: [],
        stamp: 'confirm+verify',
        scope: 'repo',
        notes_required: false,
        invalidates: [],
        required_checks: ['structure'],
        stored_status: 'confirmed',
        effective_status: 'confirmed',
        applicable: true,
        eligible: false,
        unmet_requires: [],
        verify_result: { exit_code: 0, passed: true, at: '2026-09-08T00:00:00Z' },
        check_results: [{ id: 'structure', status: 'pass', at: '2026-09-08T00:00:00Z' }],
      },
      {
        step_id: 'research',
        title: 'Research',
        when: 'new_project',
        requires: ['init'],
        stamp: 'confirm',
        scope: 'repo',
        notes_required: true,
        invalidates: [],
        required_checks: [],
        stored_status: 'pending',
        effective_status: 'pending',
        applicable: true,
        eligible: true,
        unmet_requires: [],
        check_results: [],
      },
      {
        step_id: 'skeleton',
        title: 'Skeleton <unsafe>',
        when: 'new_project',
        requires: ['research'],
        stamp: 'confirm+verify',
        scope: 'repo',
        notes_required: false,
        invalidates: [],
        required_checks: ['requirements'],
        stored_status: 'confirmed',
        effective_status: 'confirmed',
        applicable: true,
        eligible: false,
        unmet_requires: [],
        verify_result: { exit_code: 1, passed: false, at: '2026-09-08T00:00:00Z' },
        check_results: [{ id: 'requirements', status: 'pass', at: '2026-09-08T00:00:00Z' }],
      },
    ],
    ...overrides,
  };
}

describe('native checklist progress projection', () => {
  it('projects effective Proof states and validates required-check/verify evidence', () => {
    const progress = buildNativeChecklistProgress({
      proofSnapshot: snapshot(),
      checkpoint: {
        frontier: { eventCount: 12, lastEventId: 12 },
        graphSemanticDigest: 'sha256:graph',
        integrity: { digest: 'sha256:checkpoint' },
      },
      paused: true,
      instanceProjection: {
        generationsById: {
          project: {
            status: 'completed',
            checkId: 'research',
            scope: [{ kind: 'keyed', key: 'project' }],
          },
          component: {
            status: 'running',
            checkId: 'promote-native-component',
            scope: [
              { kind: 'keyed', key: 'project' },
              { kind: 'keyed', key: 'alpha' },
            ],
          },
          spec: {
            status: 'ready',
            nodeGenerationId: 'spec',
            checkId: 'review-native-item',
            scope: [
              { kind: 'keyed', key: 'project' },
              { kind: 'keyed', key: 'alpha' },
              { kind: 'keyed', key: 'REQ-1' },
            ],
          },
        },
        activeGenerationIdByNode: { spec: 'spec' },
      },
    });

    expect(progress.checklist.counts).toEqual({
      confirmed: 1,
      skipped: 0,
      not_applicable: 0,
      pending: 1,
      blocked: 0,
      stale: 0,
      failed: 1,
      unknown: 0,
    });
    expect(progress.checklist.steps_pending).toBe(2);
    expect(progress.checklist.steps[0].state).toBe('confirmed');
    expect(progress.checklist.steps[1].state).toBe('pending');
    expect(progress.checklist.steps[2].state).toBe('failed');
    expect(progress.operational.project.state).toBe('completed');
    expect(progress.operational.components.items).toEqual([
      { id: 'alpha', state: 'running', check_ids: ['promote-native-component'] },
    ]);
    expect(progress.operational.specifications.items[0].state).toBe('pending');
    expect(progress.evidence.journal.event_count).toBe(12);
    expect(progress.paused).toBe(true);
    expect(progress.resumable).toBe(true);
    expect(JSON.stringify(progress)).not.toMatch(/percent|eta/i);
  });

  it('marks missing or non-pass required-check evidence stale without treating snapshot ok as authority', () => {
    const missing = snapshot({
      ok: true,
      steps: [
        {
          step_id: 'init',
          title: 'Init',
          stamp: 'confirm',
          effective_status: 'confirmed',
          stored_status: 'confirmed',
          applicable: true,
          eligible: false,
          requires: [],
          unmet_requires: [],
          required_checks: ['structure'],
          check_results: [],
        },
      ],
    });
    expect(buildNativeChecklistProgress({ proofSnapshot: missing }).checklist.steps[0].state).toBe(
      'stale'
    );
    const warning = snapshot({
      steps: [
        {
          step_id: 'init',
          title: 'Init',
          stamp: 'confirm',
          effective_status: 'confirmed',
          stored_status: 'confirmed',
          applicable: true,
          eligible: false,
          requires: [],
          unmet_requires: [],
          required_checks: ['structure'],
          check_results: [{ id: 'structure', status: 'warn' }],
        },
      ],
    });
    expect(buildNativeChecklistProgress({ proofSnapshot: warning }).checklist.steps[0].state).toBe(
      'stale'
    );
  });

  it('keeps skipped and not-applicable dispositions distinct from pending work', () => {
    const progress = buildNativeChecklistProgress({
      proofSnapshot: snapshot({
        steps: [
          {
            step_id: 'skip',
            title: 'Skip me',
            stamp: 'confirm',
            effective_status: 'skipped',
            stored_status: 'skipped',
            applicable: true,
            eligible: false,
            requires: [],
            unmet_requires: [],
            required_checks: [],
            check_results: [],
            skip_reason: 'operator',
          },
          {
            step_id: 'na',
            title: 'Not here',
            stamp: 'confirm',
            effective_status: 'not_applicable',
            stored_status: 'pending',
            applicable: false,
            eligible: false,
            requires: [],
            unmet_requires: [],
            required_checks: [],
            check_results: [],
          },
          {
            step_id: 'blocked',
            title: 'Blocked',
            stamp: 'confirm',
            effective_status: 'pending',
            stored_status: 'pending',
            applicable: true,
            eligible: false,
            requires: ['skip'],
            unmet_requires: ['skip'],
            required_checks: [],
            check_results: [],
          },
        ],
      }),
    });
    expect(progress.checklist.steps.map(step => step.state)).toEqual([
      'skipped',
      'not_applicable',
      'blocked',
    ]);
    expect(progress.checklist.counts).toMatchObject({ skipped: 1, not_applicable: 1, blocked: 1 });
    expect(progress.checklist.steps_pending).toBe(2);
  });

  it('requires exact recorded pass stamps and consistent verification fields', () => {
    const base = snapshot({
      steps: [
        {
          step_id: 'init',
          title: 'Init',
          stamp: 'confirm+verify',
          effective_status: 'confirmed',
          stored_status: 'confirmed',
          applicable: true,
          eligible: false,
          requires: [],
          unmet_requires: [],
          required_checks: ['structure'],
          check_results: [{ id: 'structure', status: 'pass', at: '2026-09-08T00:00:00Z' }],
          verify_result: { exit_code: 0, passed: true, at: '2026-09-08T00:00:00Z' },
        },
      ],
    });
    expect(buildNativeChecklistProgress({ proofSnapshot: base }).checklist.steps[0].state).toBe(
      'confirmed'
    );
    const baseStep = (base.steps as Array<Record<string, unknown>>)[0];
    expect(
      buildNativeChecklistProgress({
        proofSnapshot: snapshot({
          steps: [
            {
              ...baseStep,
              check_results: [
                { id: 'structure', status: 'pass', at: '2026-09-08T00:00:00Z', exit_code: 0 },
              ],
            },
          ],
        }),
      }).checklist.steps[0].state
    ).toBe('stale');
    expect(
      buildNativeChecklistProgress({
        proofSnapshot: snapshot({
          steps: [
            {
              ...baseStep,
              verify_result: { exit_code: 1, passed: true, at: '2026-09-08T00:00:00Z' },
            },
          ],
        }),
      }).checklist.steps[0].state
    ).toBe('failed');
  });

  it('marks unsupported or absent operational expansion unknown and only resumes from a ready frontier', () => {
    const checkpoint = {
      frontier: { eventCount: 3, lastEventId: 3 },
      graphSemanticDigest: 'sha256:graph',
      integrity: { digest: 'sha256:checkpoint' },
    };
    const unknown = buildNativeChecklistProgress({
      proofSnapshot: snapshot(),
      checkpoint,
      paused: true,
    });
    expect(unknown.operational.components.known).toBe(false);
    expect(unknown.operational.components.unexpanded_count).toBe(1);
    expect(unknown.resumable).toBe(false);
    const terminal = buildNativeChecklistProgress({
      proofSnapshot: snapshot(),
      checkpoint,
      paused: true,
      instanceProjection: {
        generationsById: {
          done: { status: 'completed', scope: [{ kind: 'keyed', key: 'project' }] },
        },
      },
    });
    expect(terminal.resumable).toBe(false);
    const ready = buildNativeChecklistProgress({
      proofSnapshot: snapshot(),
      checkpoint,
      paused: true,
      instanceProjection: {
        generationsById: {
          next: {
            status: 'ready',
            nodeGenerationId: 'next',
            scope: [
              { kind: 'keyed', key: 'project' },
              { kind: 'keyed', key: 'alpha' },
            ],
          },
        },
        activeGenerationIdByNode: { next: 'next' },
      },
    });
    expect(ready.resumable).toBe(true);
  });

  it('keeps mixed completed and ready generations pending instead of unknown or complete', () => {
    const progress = buildNativeChecklistProgress({
      proofSnapshot: snapshot(),
      instanceProjection: {
        generationsById: {
          done: {
            status: 'completed',
            checkId: 'inventory',
            scope: [{ kind: 'keyed', key: 'project' }],
          },
          next: {
            status: 'ready',
            checkId: 'skeleton',
            scope: [{ kind: 'keyed', key: 'project' }],
          },
        },
      },
    });
    expect(progress.operational.project.state).toBe('pending');
  });

  it('requires a linked claim for live views and validates checkpoint timestamp', () => {
    expect(() =>
      buildNativeChecklistProgress({ proofSnapshot: snapshot(), requireProofSnapshotClaim: true })
    ).toThrow(/lineage-linked/);
    const claim = {
      claim: 'proof.checklist.snapshot@1',
      claimId: 'snapshot-1',
      active: true,
      payload: snapshot(),
    };
    const linkedClaim = {
      ...claim,
      claimId: 'a'.repeat(64),
      payloadFingerprint: sha256Canonical(claim.payload),
    };
    expect(
      buildNativeChecklistProgress({
        proofSnapshot: claim.payload,
        proofSnapshotClaim: linkedClaim,
        requireProofSnapshotClaim: true,
      }).evidence.proof_snapshot.claim_id
    ).toBe('a'.repeat(64));
    const researchClaim = {
      ...linkedClaim,
      claim: 'proof.checklist.research-snapshot@1',
    };
    expect(
      buildNativeChecklistProgress({
        proofSnapshot: claim.payload,
        proofSnapshotClaim: researchClaim,
        requireProofSnapshotClaim: true,
      }).evidence.proof_snapshot
    ).toMatchObject({
      source: 'proof.checklist.research-snapshot@1',
      stage: 'research',
    });
    const progress = buildNativeChecklistProgress({
      proofSnapshot: claim.payload,
      proofSnapshotClaim: claim,
      checkpoint: { frontier: { eventCount: 0, lastEventId: 0 } },
      checkpointTimestamp: '2026-09-08T00:00:00Z',
    });
    expect(progress.evidence.journal.checkpoint_timestamp).toBe('2026-09-08T00:00:00Z');
    expect(() =>
      buildNativeChecklistProgress({
        proofSnapshot: snapshot(),
        checkpoint: {},
        checkpointTimestamp: 'not-a-date',
      })
    ).toThrow(/RFC3339/);
  });

  it('requires a lineage-linked snapshot claim when supplied', () => {
    const proofSnapshot = snapshot();
    const claim = {
      claim: 'proof.checklist.snapshot@1',
      claimId: 'snapshot-1',
      active: true,
      payload: proofSnapshot,
    };
    expect(
      buildNativeChecklistProgress({ proofSnapshot, proofSnapshotClaim: claim }).evidence
        .proof_snapshot.claim_id
    ).toBe('snapshot-1');
    expect(() =>
      buildNativeChecklistProgress({
        proofSnapshot,
        proofSnapshotClaim: { ...claim, payload: snapshot({ checklist: 'other' }) },
      })
    ).toThrow(/does not match/);
    expect(() =>
      buildNativeChecklistProgress({
        proofSnapshot,
        proofSnapshotClaim: { ...claim, claim: 'other' },
      })
    ).toThrow(/active proof.checklist/);
  });

  it('renders deterministic text and escaped HTML without changing the JSON payload', () => {
    const progress = buildNativeChecklistProgress({ proofSnapshot: snapshot() });
    const rendered = renderNativeChecklistProgress(progress);
    expect(rendered.json).toBe(renderNativeChecklistProgress(JSON.parse(rendered.json)).json);
    expect(rendered.text).toContain('onboard_v1 (3 steps)');
    expect(rendered.html).toContain('data-native-checklist-progress="v1"');
    expect(rendered.html).toContain('Skeleton &lt;unsafe&gt;');
    expect(rendered.html).not.toContain('<unsafe>');
    expect(rendered.html).toContain('\\u003c');
    expect(rendered.text).toContain('checks=none');
    expect(rendered.html).toContain('required checks: none / not required');
    expect(rendered.html).not.toContain('required checks: pass</td>');
    const embedded = rendered.html.match(
      /<script type="application\/json" id="native-checklist-progress">([\s\S]*)<\/script>/
    )?.[1];
    expect(embedded).toBeDefined();
    expect(JSON.parse(embedded as string)).toEqual(JSON.parse(rendered.json));
  });

  it('rejects an unversioned or malformed Proof snapshot', () => {
    expect(() =>
      buildNativeChecklistProgress({ proofSnapshot: { schema_version: 'old' } })
    ).toThrow(/proof.checklist.show.v1/);
    expect(() =>
      buildNativeChecklistProgress({ proofSnapshot: snapshot({ steps: ['not-an-object'] }) })
    ).toThrow(/steps must be an array/);
  });
});
