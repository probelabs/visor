import { describe, expect, it } from '@jest/globals';
import {
  ADMITTED_CATALOG_MAX_BYTES,
  materializeAdmittedCatalog,
  ProofAdmittedCatalogError,
} from '../../../src/providers/proof-admitted-catalog-check-provider';
import {
  immutableCanonicalValue,
  sha256Canonical,
} from '../../../src/state-machine/graph/claim-kernel';
import type { CandidateClaimInput } from '../../../src/providers/check-provider.interface';

const scope = Object.freeze([{
  kind: 'keyed' as const,
  expansionOwnerCheck: 'project',
  key: 'journalservice',
  subgraphInstanceId: 'a'.repeat(64),
}]);

function makeClaim(
  claim: string,
  payload: unknown,
  overrides: Partial<CandidateClaimInput> = {},
): CandidateClaimInput {
  const payloadFingerprint = sha256Canonical(payload);
  const base: any = {
    claimId: sha256Canonical({ claim, payloadFingerprint, producer: overrides.producerCheckId || 'fixture' }),
    claim,
    payload,
    payloadFingerprint,
    producerCheckId: overrides.producerCheckId || 'fixture',
    scope,
    parentClaimIds: overrides.parentClaimIds || [],
    provenance: 'attempt',
    attemptId: overrides.attemptId || 'b'.repeat(64),
    fence: overrides.fence || 1,
  };
  return immutableCanonicalValue({ ...base, ...overrides }) as CandidateClaimInput;
}

function workItem(id: string) {
  return {
    project_id: 'journalservice',
    component_id: id,
    sorted_owned_paths: [`${id}.go`],
    sorted_dependency_closure: [`${id}.go`],
    proof_path_mapping: [],
    proof_input_state: [],
    proof_component_subject: { kind: 'component', id },
    authority: { claimId: 'c'.repeat(64), claim: 'proof.component_role_authority@1' },
  };
}

function fixture() {
  const inventory = makeClaim('proof.structural_inventory@1', {
    version: 'proof.structural-inventory/v1',
    project_id: 'journalservice',
    revision_fingerprint: `sha256:${'9'.repeat(64)}`,
    boundary_fingerprint: `sha256:${'8'.repeat(64)}`,
    source_paths: ['alpha.go', 'beta.go', 'gamma.go'],
    package_identities: ['journalservice'],
  }, { producerCheckId: 'structural_inventory', parentClaimIds: ['d'.repeat(64)] });
  const candidatePayload = {
    components: [
      { component_id: 'alpha', responsibility: 'alpha' },
      { component_id: 'beta', responsibility: 'beta' },
      { component_id: 'gamma', responsibility: 'gamma' },
    ],
  };
  const candidate = makeClaim('proof.candidate@1', candidatePayload, {
    producerCheckId: 'inspect',
    parentClaimIds: ['d'.repeat(64)],
  });
  const admissionPayload = {
    Status: 'ADMITTED',
    ClaimID: candidate.claimId,
    Claim: candidate.claim,
    PayloadFingerprint: candidate.payloadFingerprint,
    ProducerCheckID: candidate.producerCheckId,
    ParentClaimIDs: candidate.parentClaimIds,
    receipt_id: 'e'.repeat(64),
  };
  const admission = makeClaim('proof.admitted_receipt@1', admissionPayload, {
    producerCheckId: 'proof_admit',
    parentClaimIds: [candidate.claimId],
  });
  const revalidationPayload = {
    version: 'proof.catalog-revalidation/v1',
    status: 'ACCEPTED',
    structural_inventory_claim_id: inventory.claimId,
    candidate_claim_id: candidate.claimId,
    admission_receipt_claim_id: admission.claimId,
    candidate_payload_fingerprint: candidate.payloadFingerprint,
    revision_fingerprint: (inventory.payload as any).revision_fingerprint,
    boundary_fingerprint: (inventory.payload as any).boundary_fingerprint,
    work_items: ['alpha', 'beta', 'gamma'].map(workItem),
  };
  const revalidation = makeClaim('proof.catalog_revalidation@1', revalidationPayload, {
    producerCheckId: 'revalidate_catalog',
    parentClaimIds: [inventory.claimId, candidate.claimId, admission.claimId].sort(),
  });
  return { inventory, candidate, admission, revalidation };
}

describe('proof-admitted catalog egress', () => {
  it('materializes only the exact admitted, current, same-scope receipt', () => {
    const value = materializeAdmittedCatalog(fixture());
    expect(value.components.map(item => item.component_id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(JSON.stringify(value)).toBe(JSON.stringify(immutableCanonicalValue(value)));
  });

  it.each([
    ['missing revalidation', (value: any) => { delete value.revalidation; }],
    ['foreign candidate binding', (value: any) => { value.revalidation = immutableCanonicalValue({ ...value.revalidation, payload: { ...value.revalidation.payload, candidate_claim_id: '1'.repeat(64) } }); }],
    ['foreign scope', (value: any) => { value.revalidation = immutableCanonicalValue({ ...value.revalidation, scope: [{ ...scope[0], key: 'other' }] }); }],
    ['unadmitted receipt', (value: any) => { value.admission = immutableCanonicalValue({ ...value.admission, payload: { ...value.admission.payload, Status: 'REJECTED' } }); }],
    ['cross-candidate admission', (value: any) => { value.admission = immutableCanonicalValue({ ...value.admission, payload: { ...value.admission.payload, ClaimID: '2'.repeat(64) } }); }],
  ])('fails closed for %s', (_name, mutate) => {
    const value: any = fixture();
    mutate(value);
    expect(() => materializeAdmittedCatalog(value)).toThrow(ProofAdmittedCatalogError);
  });

  it.each([
    ['one item', [{ component_id: 'alpha', responsibility: 'alpha' }]],
    ['five items', [
      { component_id: 'a' }, { component_id: 'b' }, { component_id: 'c' },
      { component_id: 'd' }, { component_id: 'e' },
    ]],
  ])('rejects discovery candidate with %s', (_name, components) => {
    const value: any = fixture();
    value.candidate = makeClaim('proof.candidate@1', { components }, {
      producerCheckId: 'inspect',
      parentClaimIds: ['d'.repeat(64)],
    });
    expect(() => materializeAdmittedCatalog(value)).toThrow(ProofAdmittedCatalogError);
  });

  it('rejects a stale current revision even when the receipt claim is recomputed', () => {
    const value: any = fixture();
    value.revalidation = makeClaim('proof.catalog_revalidation@1', {
      ...value.revalidation.payload,
      revision_fingerprint: `sha256:${'7'.repeat(64)}`,
    }, { producerCheckId: 'revalidate_catalog', parentClaimIds: value.revalidation.parentClaimIds });
    expect(() => materializeAdmittedCatalog(value)).toThrow(ProofAdmittedCatalogError);
  });

  it.each([
    ['duplicate WorkItem', (value: any) => { value.revalidation = makeClaim('proof.catalog_revalidation@1', { ...value.revalidation.payload, work_items: [workItem('alpha'), workItem('alpha'), workItem('gamma')] }, { producerCheckId: 'revalidate_catalog', parentClaimIds: value.revalidation.parentClaimIds }); }],
    ['incomplete WorkItem catalog', (value: any) => { value.revalidation = makeClaim('proof.catalog_revalidation@1', { ...value.revalidation.payload, work_items: [workItem('alpha'), workItem('beta')] }, { producerCheckId: 'revalidate_catalog', parentClaimIds: value.revalidation.parentClaimIds }); }],
    ['oversized catalog', (value: any) => { const item = workItem('alpha') as any; item.authority = { padding: 'x'.repeat(ADMITTED_CATALOG_MAX_BYTES) }; value.revalidation = makeClaim('proof.catalog_revalidation@1', { ...value.revalidation.payload, work_items: [item, workItem('beta'), workItem('gamma')] }, { producerCheckId: 'revalidate_catalog', parentClaimIds: value.revalidation.parentClaimIds }); }],
  ])('rejects %s', (_name, mutate) => {
    const value: any = fixture(); mutate(value);
    expect(() => materializeAdmittedCatalog(value)).toThrow(ProofAdmittedCatalogError);
  });

  it('rejects noncanonical WorkItem/catalog bytes', () => {
    const value: any = fixture();
    const payload = { work_items: value.revalidation.payload.work_items, version: value.revalidation.payload.version,
      status: value.revalidation.payload.status, structural_inventory_claim_id: value.revalidation.payload.structural_inventory_claim_id,
      revision_fingerprint: value.revalidation.payload.revision_fingerprint, boundary_fingerprint: value.revalidation.payload.boundary_fingerprint,
      candidate_claim_id: value.revalidation.payload.candidate_claim_id, admission_receipt_claim_id: value.revalidation.payload.admission_receipt_claim_id,
      candidate_payload_fingerprint: value.revalidation.payload.candidate_payload_fingerprint };
    value.revalidation = { ...value.revalidation, payload, payloadFingerprint: sha256Canonical(payload) };
    expect(() => materializeAdmittedCatalog(value)).toThrow(ProofAdmittedCatalogError);
  });

  it('bounds candidate bytes before component inspection', () => {
    const value: any = fixture();
    value.candidate = makeClaim('proof.candidate@1', { components: [
      { component_id: 'alpha', responsibility: 'x'.repeat(ADMITTED_CATALOG_MAX_BYTES) },
      { component_id: 'beta', responsibility: 'beta' },
    ] }, { producerCheckId: 'inspect', parentClaimIds: value.candidate.parentClaimIds });
    expect(() => materializeAdmittedCatalog(value)).toThrow(ProofAdmittedCatalogError);
  });
});
