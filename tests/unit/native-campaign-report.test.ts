import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {describe, expect, it} from '@jest/globals';
import {canonicalGraphCheckpointJson} from '../../src/snapshot-store';
import {canonicalJson} from '../../src/state-machine/graph/claim-kernel';
import type {InstanceProjection} from '../../src/state-machine/graph/instance-kernel';
import {
  buildNativeCampaignReport,
  deriveNativeCampaignRowsForTest,
  renderNativeCampaignReport,
  type NativeCampaignReport,
} from '../../examples/agent-governance/native-onboarding/native-campaign-report';

function scope(component: string, id?: string): any[] {
  return [
    {kind: 'keyed', key: 'project', subgraphInstanceId: 'p'},
    {kind: 'keyed', key: component, subgraphInstanceId: 'c'},
    ...(id ? [{kind: 'keyed', key: id, subgraphInstanceId: 'i'}] : []),
  ];
}

function makeFixture(): {
  root: string;
  projection: InstanceProjection;
  priorProjection: InstanceProjection;
  entries: Record<string, unknown>[];
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-campaign-report-'));
  const claims: Record<string, any> = {};
  const priorClaims: Record<string, any> = {};
  const entries: Record<string, unknown>[] = [];
  const rows = [
    {component: 'z|component', id: 'REQ|2', retained: false},
    {component: 'alpha', id: 'REQ-1', retained: true},
  ];
  for (const row of rows) {
    const itemClaimId = `item-${row.id}`;
    const candidateClaimId = `candidate-${row.id}`;
    const packetClaimId = `packet-${row.id}`;
    const itemPayload = {
      id: row.id,
      component_id: row.component,
      file_path: `specs/${row.id}.req.yaml`,
      proof_file_hash: `sha256:${'b'.repeat(64)}`,
    };
    const packetPayload = {
      ...itemPayload,
      candidate: {text: `candidate for ${row.id}`},
    };
    const itemScope = scope(row.component, row.id);
    claims[itemClaimId] = {
      claimId: itemClaimId,
      claim: 'native.requirement.item@1',
      payload: itemPayload,
      parentClaimIds: ['catalog'],
      scope: itemScope,
      active: true,
    };
    claims[candidateClaimId] = {
      claimId: candidateClaimId,
      claim: 'native.review.candidate@1',
      payload: {text: `candidate for ${row.id}`},
      producerCheckId: 'review-native-item',
      parentClaimIds: [itemClaimId],
      scope: itemScope,
      active: true,
    };
    claims[packetClaimId] = {
      claimId: packetClaimId,
      claim: 'native.review.packet@1',
      payload: packetPayload,
      payloadFingerprint: 'a'.repeat(64),
      parentClaimIds: [candidateClaimId, itemClaimId],
      producerCheckId: 'collect-proof-evidence',
      scope: itemScope,
      active: true,
    };
    if (row.retained) priorClaims[packetClaimId] = claims[packetClaimId];
    const relative = `review-packets/${encodeURIComponent(row.component)}/${encodeURIComponent(row.id)}.json`;
    const bytes = Buffer.from(JSON.stringify(packetPayload), 'utf8');
    const packetDirectory = path.join(root, path.dirname(relative));
    fs.mkdirSync(packetDirectory, {recursive: true});
    fs.writeFileSync(path.join(root, relative), bytes);
    entries.push({
      claim_id: packetClaimId,
      payload_fingerprint: 'a'.repeat(64),
      component_id: row.component,
      id: row.id,
      file_path: itemPayload.file_path,
      proof_file_hash: itemPayload.proof_file_hash,
      source_relative_path: relative,
      packet_bytes: bytes.length,
      packet_sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
    claims[`summary-${row.component}`] = {
      claimId: `summary-${row.component}`,
      claim: 'native.component.summary@1',
      payload: {
        component_id: row.component,
        open_native_checks: [{name: 'audit|gap', exit_code: 1}],
      },
      scope: scope(row.component),
      active: true,
    };
  }
  return {
    root,
    projection: {claimsById: claims} as unknown as InstanceProjection,
    priorProjection: {claimsById: priorClaims} as unknown as InstanceProjection,
    entries,
  };
}

function emptyCheckpoint(events: unknown[] = []): any {
  const body = {
    kind: 'visor.graph-journal-checkpoint',
    version: 1,
    sessionId: 'test-session',
    graphSemanticDigest: 'test-graph',
    frontier: {eventCount: events.length, lastEventId: events.length},
    events,
  };
  return {
    ...body,
    integrity: {
      algorithm: 'sha256',
      digest: createHash('sha256').update(canonicalGraphCheckpointJson(body), 'utf8').digest('hex'),
    },
  };
}

describe('native campaign report', () => {
  it('derives deterministic retained/retried rows and component audit gaps from active claims', () => {
    const fixture = makeFixture();
    try {
      const derived = deriveNativeCampaignRowsForTest(
        fixture.projection,
        fixture.root,
        fixture.entries,
        fixture.priorProjection,
        ['REQ|2'],
      );
      expect(derived.rows.map(row => `${row.component_id}:${row.id}:${row.disposition}`)).toEqual([
        'alpha:REQ-1:retained',
        'z|component:REQ|2:retried',
      ]);
      expect(derived.components.map(component => component.id)).toEqual(['alpha', 'z|component']);
      expect(derived.components.reduce((count, component) => count + component.audit_gaps.length, 0)).toBe(2);
      expect(derived.admitted).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, {recursive: true, force: true});
    }
  });

  it('escapes Markdown and uses collision-safe DOT identifiers with readable labels', () => {
    const fixture = makeFixture();
    try {
      const derived = deriveNativeCampaignRowsForTest(fixture.projection, fixture.root, fixture.entries, fixture.priorProjection, ['REQ|2']);
      const report: NativeCampaignReport = {
        version: 1,
        kind: 'native-campaign-report',
        epoch: 'author|review',
        source: {
          checkpoint_graph_semantic_digest: 'graph',
          checkpoint_event_count: 2,
          checkpoint_integrity_sha256: `sha256:${'c'.repeat(64)}`,
          prior_checkpoint_event_count: 1,
          prior_prefix_validated: true,
          packet_manifest_status: 'validated-reference-only',
        },
        counts: {components: 2, specification_rows: 2, retained_rows: 1, retried_rows: 1, audit_gaps: 2, admitted_components: 0},
        components: derived.components,
        rows: derived.rows,
        reconcile: {status: 'failed', failure_code: 'MANAGED_START_FAILED'},
        postflight: {checks: {}, failed_checks: []},
        warnings: ['pipe | and "quote" remain data'],
      };
      const rendered = renderNativeCampaignReport(report);
      expect(rendered.markdown).toContain('author\\|review');
      expect(rendered.markdown).toContain('[packet](review-packets/');
      expect(rendered.dot).toContain('\\n');
      const rowIds = [...new Set(rendered.dot.match(/\brow_[0-9a-f]{16}\b/g) ?? [])];
      expect(rowIds).toHaveLength(2);
      expect(rendered.dot).not.toContain('row_REQ_2');
      expect(rendered.json).toBe(`${canonicalJson(report)}\n`);
      expect(renderNativeCampaignReport(JSON.parse(canonicalJson(report)) as NativeCampaignReport)).toEqual(rendered);
    } finally {
      fs.rmSync(fixture.root, {recursive: true, force: true});
    }
  });

  it('rejects a prior checkpoint that is not the exact canonical final prefix', () => {
    const fixture = makeFixture();
    const packetManifest = {
      version: 1,
      kind: 'retained-native-review-packet-export',
      status: 'validated-reference-only',
      source: {},
      packet_count: 0,
      packets: [],
    };
    fs.writeFileSync(path.join(fixture.root, 'manifest.json'), JSON.stringify(packetManifest));
    try {
      const finalCheckpoint = emptyCheckpoint([{version: 1, eventId: 1, type: 'synthetic'}]);
      const priorCheckpoint = emptyCheckpoint([{version: 1, eventId: 1, type: 'different'}]);
      expect(() => buildNativeCampaignReport({
        epoch: 'test',
        checkpoint: finalCheckpoint,
        priorCheckpoint,
        packetRoot: fixture.root,
      })).toThrow(/canonical final event prefix/);
    } finally {
      fs.rmSync(fixture.root, {recursive: true, force: true});
    }
  });

  it('rejects duplicate and detached active identities', () => {
    const fixture = makeFixture();
    try {
      const duplicate = {...fixture.projection, claimsById: {
        ...(fixture.projection as any).claimsById,
        duplicate: {...(fixture.projection as any).claimsById['item-REQ-1'], claimId: 'duplicate'},
      }} as unknown as InstanceProjection;
      expect(() => deriveNativeCampaignRowsForTest(duplicate, fixture.root, fixture.entries, fixture.priorProjection, ['REQ|2'])).toThrow(/duplicate/);
      const detached = {...fixture.projection, claimsById: {
        ...(fixture.projection as any).claimsById,
        'packet-REQ-1': {
          ...(fixture.projection as any).claimsById['packet-REQ-1'],
          payload: {...(fixture.projection as any).claimsById['packet-REQ-1'].payload, component_id: 'z|component'},
        },
      }} as unknown as InstanceProjection;
      expect(() => deriveNativeCampaignRowsForTest(detached, fixture.root, fixture.entries, fixture.priorProjection, ['REQ|2'])).toThrow(/detached|does not match/);
      const candidateMismatch = {...fixture.projection, claimsById: {
        ...(fixture.projection as any).claimsById,
        'candidate-REQ-1': {
          ...(fixture.projection as any).claimsById['candidate-REQ-1'],
          payload: {text: 'not the packet candidate'},
        },
      }} as unknown as InstanceProjection;
      expect(() => deriveNativeCampaignRowsForTest(candidateMismatch, fixture.root, fixture.entries, fixture.priorProjection, ['REQ|2'])).toThrow(/reviewed candidate/);
    } finally {
      fs.rmSync(fixture.root, {recursive: true, force: true});
    }
  });

  it('rejects a packet manifest link that is a symlink outside the export root and never confirms a fake admission', () => {
    const fixture = makeFixture();
    const outside = path.join(path.dirname(fixture.root), 'native-campaign-outside.json');
    try {
      fs.writeFileSync(outside, '{}');
      const first = fixture.entries[0] as any;
      const target = path.join(fixture.root, first.source_relative_path);
      const originalPacket = fs.readFileSync(target);
      fs.unlinkSync(target);
      fs.symlinkSync(outside, target);
      expect(() => deriveNativeCampaignRowsForTest(fixture.projection, fixture.root, fixture.entries, fixture.priorProjection, ['REQ|2'])).toThrow(/symlink|regular file/);
      const admitted = {...fixture.projection, claimsById: {
        ...(fixture.projection as any).claimsById,
        fakeAdmission: {
          claimId: 'fakeAdmission',
          claim: 'proof.admitted_receipt@1',
          producerCheckId: 'proof_admit',
          payload: {Status: 'ADMITTED'},
          scope: scope('alpha'),
          active: true,
        },
      }} as unknown as InstanceProjection;
      // Restore the validated file before testing the independent admission guard.
      fs.unlinkSync(target);
      fs.writeFileSync(target, originalPacket);
      expect(() => deriveNativeCampaignRowsForTest(admitted, fixture.root, fixture.entries, fixture.priorProjection, ['REQ|2'])).toThrow(/admission receipt/);
    } finally {
      fs.rmSync(outside, {force: true});
      fs.rmSync(fixture.root, {recursive: true, force: true});
    }
  });
});
