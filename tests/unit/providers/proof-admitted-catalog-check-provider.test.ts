import { describe, expect, it } from '@jest/globals';
import {
  materializeAdmittedCatalog,
  ProofAdmittedCatalogError,
} from '../../../src/providers/proof-admitted-catalog-check-provider';
import { compareProofStrings } from '../../../src/providers/proof-catalog-check-providers';
import {
  canonicalJson,
  immutableCanonicalValue,
  sha256Canonical,
} from '../../../src/state-machine/graph/claim-kernel';
import type { CandidateClaimInput } from '../../../src/providers/check-provider.interface';
import { createHash } from 'node:crypto';

const scope = Object.freeze([{
  kind: 'keyed' as const,
  expansionOwnerCheck: 'project',
  key: 'journalservice',
  subgraphInstanceId: 'a'.repeat(64),
}]);

function goJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('not JSON');
  return encoded;
}

function domainDigest(domain: string, value: unknown): string {
  const bytes = Buffer.from(goJson(value), 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(domain).update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}
function encodedDigest(domain: string, encoded: string): string {
  const bytes = Buffer.from(encoded, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(domain).update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}

function plainDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(goJson(value), 'utf8').digest('hex')}`;
}

function topJson(value: Record<string, unknown>): string {
  return `{${Object.keys(value).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))).map(key => `${JSON.stringify(key)}:${goJson(value[key])}`).join(',')}}`;
}

function receiptID(value: Record<string, unknown>): string {
  const unsigned = { ...value };
  delete unsigned.receipt_id;
  return encodedDigest('proof.catalog-revalidation-receipt/id/v2', topJson(unsigned));
}

function admissionID(value: Record<string, unknown>): string {
  const unsigned = { ...value };
  delete unsigned.receipt_id;
  return encodedDigest('proof.role-result-candidate-receipt/id/v2', topJson(unsigned));
}

function makeClaim(claim: string, payload: unknown, producerCheckId: string, parentClaimIds: string[] = []): CandidateClaimInput {
  return immutableCanonicalValue({
    claimId: sha256Canonical({ claim, payload, producerCheckId }), claim, payload,
    payloadFingerprint: sha256Canonical(payload), producerCheckId, scope,
    parentClaimIds: [...parentClaimIds].sort(), provenance: 'attempt' as const,
    attemptId: 'b'.repeat(64), fence: 1,
  }) as CandidateClaimInput;
}

function inputRow(ownerID: string, path: string, hashDigit: string): Record<string, unknown> {
  return { owner_kind: 'onboarding_component', owner_id: ownerID, input_kind: 'code', path, file_hash: `sha256:${hashDigit.repeat(64)}` };
}

function inventory(): Record<string, unknown> {
  const paths = ['B.go', 'a.go', 'gamma.go'];
  return {
    version: 'proof.structural-inventory/v1',
    authority: { version: 'proof.project-authority/v1', project_id: 'journalservice', subject_fingerprint: `sha256:${'1'.repeat(64)}`, code_fingerprint: `sha256:${'2'.repeat(64)}`, tests_fingerprint: `sha256:${'3'.repeat(64)}` },
    sorted_paths: paths,
    sorted_module_paths: [],
    boundary_fingerprint: `sha256:${'8'.repeat(64)}`,
    input_state: paths.map(path => ({ owner_kind: 'onboarding_structural_inventory', owner_id: 'journalservice', input_kind: 'code', path, file_hash: `sha256:${({ 'B.go': '4', 'a.go': '5', 'gamma.go': '6' } as Record<string, string>)[path].repeat(64)}` })),
  };
}

function candidatePayload(): Record<string, unknown> {
  // B/a exercises Proof's bytewise ordering and deliberately leaves the
  // descriptive arrays in the order supplied by the model.
  return {
    version: 'proof.component-catalog-candidate/v1', project_id: 'journalservice',
    components: [
      { id: 'a', responsibility: 'a component', owned_paths: ['a.go'], entry_points: ['z', 'A'], state_effects: ['b', 'A'], interfaces: [{ name: 'a' }], uncertainty: ['u2', 'u1'] },
      { id: 'B', responsibility: 'B component', owned_paths: ['B.go'] },
      { id: 'gamma', responsibility: 'gamma component', owned_paths: ['gamma.go'], dependency_closure: ['gamma.go'] },
    ],
  };
}

function workItem(id: string, path: string, hashDigit: string): Record<string, unknown> {
  const subject = { version: 'proof.component-subject/v1', project_id: 'journalservice', component_id: id, sorted_owned_paths: [path], sorted_dependency_closure: [path], fingerprint: `sha256:${('7' + hashDigit).repeat(32)}` };
  return {
    version: 'reqproof.onboarding-component-work-item/v1', project_id: 'journalservice', component_id: id,
    sorted_owned_paths: [path], sorted_dependency_closure: [path],
    proof_path_mapping: { paths: [path], components: [id], owner: 'onboard', risk_tier: 0, enforcement: 'soft' },
    proof_input_state: [inputRow(id, path, hashDigit)], proof_component_subject: subject,
  };
}

function fixture() {
  const inventoryPayload = inventory();
  const inventoryClaim = makeClaim('proof.structural_inventory@1', inventoryPayload, 'structural_inventory');
  const candidate = makeClaim('proof.candidate@1', immutableCanonicalValue(candidatePayload()), 'inspect', [inventoryClaim.claimId]);
  const binding = { ManagedRunID: 'a'.repeat(64), SessionID: 'session', CheckID: 'inspect', Scope: [{ Kind: 'keyed', ExpansionOwnerCheck: 'project', Key: 'journalservice', SubgraphInstanceID: 'a'.repeat(64) }], NodeInstanceID: 'b'.repeat(64), NodeGenerationID: 'c'.repeat(64), AttemptID: 'd'.repeat(64), Fence: 1 };
  const termination = { Version: 1, Type: 'ManagedRunTerminated', SessionID: 'session', Scope: binding.Scope, Binding: binding, CleanupStatus: 'clean', ControllerDecision: 'completed', FailureCode: null };
  const candidateText = canonicalJson(candidate.payload);
  const admissionReceipt = {
    Version: 'proof.role-result-candidate-admission/v2', Status: 'ADMITTED', CandidateID: encodedDigest('proof.role-result-candidate-envelope/id/v1', candidateText),
    ProbeResultDigest: encodedDigest('probe.governed-result-identity/data/v1', candidateText), ProbeCanonicalBytes: Buffer.byteLength(candidateText), ClaimID: candidate.claimId,
    Claim: candidate.claim, PayloadFingerprint: candidate.payloadFingerprint, InvocationDigest: `sha256:${'b'.repeat(64)}`,
    RoleID: 'onboard', Stance: 'owner', Subject: { kind: 'project', id: 'journalservice', fingerprint: `sha256:${'1'.repeat(64)}` },
    ProducerCheckID: 'inspect', ParentClaimIDs: candidate.parentClaimIds, Binding: binding, Termination: termination, ProjectLineage: null, receipt_id: '',
  };
  admissionReceipt.receipt_id = admissionID(admissionReceipt);
  const admissionDecision = { version: 'proof.role-result-candidate-cli-decision/v1', status: 'ADMITTED', receipt: admissionReceipt, reject_code: null };
  const admissionWire = canonicalJson(admissionDecision);
  const admission = makeClaim('proof.admitted_receipt@1', { ...admissionReceipt, __proof_admission_wire: admissionWire }, 'proof_admit', [candidate.claimId]);
  const catalog = {
    version: 'proof.component-catalog-candidate/v1', project_id: 'journalservice', components: [
      { id: 'B', responsibility: 'B component', owned_paths: ['B.go'] },
      { id: 'a', responsibility: 'a component', owned_paths: ['a.go'], entry_points: ['A', 'z'], state_effects: ['A', 'b'], interfaces: [{ name: 'a' }], uncertainty: ['u1', 'u2'] },
      { id: 'gamma', responsibility: 'gamma component', owned_paths: ['gamma.go'], dependency_closure: ['gamma.go'] },
    ],
  };
  const workItems = [workItem('B', 'B.go', '4'), workItem('a', 'a.go', '5'), workItem('gamma', 'gamma.go', '6')];
  const authorities = workItems.map(item => ({ component_id: item.component_id, work_item_digest: plainDigest({
    version: item.version, project_id: item.project_id, component_id: item.component_id, sorted_owned_paths: item.sorted_owned_paths,
    sorted_dependency_closure: item.sorted_dependency_closure, proof_path_mapping: item.proof_path_mapping,
    proof_input_state: item.proof_input_state, proof_component_subject: item.proof_component_subject,
  }), subject: item.proof_component_subject }));
  const inventoryWire = {
    version: inventoryPayload.version, authority: inventoryPayload.authority, sorted_paths: inventoryPayload.sorted_paths,
    sorted_module_paths: inventoryPayload.sorted_module_paths, boundary_fingerprint: inventoryPayload.boundary_fingerprint, input_state: inventoryPayload.input_state,
  };
  const receiptUnsigned = {
    version: 'proof.catalog-revalidation-receipt/v2', decision: 'accepted', project_id: 'journalservice', project_fingerprint: (inventoryPayload.authority as any).subject_fingerprint,
    boundary_fingerprint: inventoryPayload.boundary_fingerprint, inventory_claim_id: domainDigest('proof.structural-inventory/claim/v1', inventoryWire),
    catalog_claim_id: domainDigest('proof.component-catalog-candidate/claim/v1', candidate.payload), admission_candidate_id: admissionReceipt.CandidateID,
    admission_result_digest: admissionReceipt.ProbeResultDigest, admission_receipt_id: admissionReceipt.receipt_id, component_authorities: authorities, project_lineage: null, receipt_id: '',
  };
  const receipt = { ...receiptUnsigned, receipt_id: receiptID(receiptUnsigned) };
  const revalidationPayload = { version: 'proof.catalog-revalidation/v2', inventory: inventoryPayload, catalog, work_items: workItems, receipt };
  const revalidation = makeClaim('proof.catalog_revalidation@1', revalidationPayload, 'revalidate_catalog', [inventoryClaim.claimId, candidate.claimId, admission.claimId]);
  return { inventory: inventoryClaim, candidate, admission, revalidation };
}

describe('proof-admitted catalog egress', () => {
  it('materializes the exact current Proof projection and retains complete admission wire', () => {
    const value = fixture();
    const result = materializeAdmittedCatalog(value);
    expect(result.components.map(item => item.component_id)).toEqual(['B', 'a', 'gamma']);
    expect((value.admission.payload as any).__proof_admission_wire).toContain('proof.role-result-candidate-cli-decision/v1');
  });

  it('uses Proof bytewise ordering rather than locale ordering', () => {
    expect(['a', 'B'].sort(compareProofStrings)).toEqual(['B', 'a']);
    expect(() => materializeAdmittedCatalog(fixture())).not.toThrow();
  });

  it.each([
    ['legacy revalidation shape', (value: any) => { value.revalidation = makeClaim('proof.catalog_revalidation@1', { version: 'proof.catalog-revalidation/v1', status: 'ACCEPTED', work_items: [] }, 'revalidate_catalog', value.revalidation.parentClaimIds); }],
    ['missing admission wire', (value: any) => { const receipt = { ...(value.admission.payload as any) }; delete receipt.__proof_admission_wire; value.admission = makeClaim('proof.admitted_receipt@1', receipt, 'proof_admit', [value.candidate.claimId]); }],
    ['foreign scope', (value: any) => { value.revalidation = { ...value.revalidation, scope: [{ ...scope[0], key: 'other' }] }; }],
    ['detached WorkItem path', (value: any) => { const item = value.revalidation.payload.work_items[0]; value.revalidation = makeClaim('proof.catalog_revalidation@1', { ...value.revalidation.payload, work_items: [{ ...item, sorted_owned_paths: ['other.go'] }, ...value.revalidation.payload.work_items.slice(1)] }, 'revalidate_catalog', value.revalidation.parentClaimIds); }],
    ['incomplete WorkItem catalog', (value: any) => { value.revalidation = makeClaim('proof.catalog_revalidation@1', { ...value.revalidation.payload, work_items: value.revalidation.payload.work_items.slice(0, 2) }, 'revalidate_catalog', value.revalidation.parentClaimIds); }],
  ])('fails closed for %s', (_name, mutate) => {
    const value: any = fixture(); mutate(value);
    expect(() => materializeAdmittedCatalog(value)).toThrow(ProofAdmittedCatalogError);
  });
});
