import { describe, expect, it } from '@jest/globals';
import {
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
    ProducerCheckID: 'proof_admit',
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
    candidate_claim_id: candidate.claimId,
    admission_receipt_claim_id: admission.claimId,
    candidate_payload_fingerprint: candidate.payloadFingerprint,
    revision_fingerprint: 'f'.repeat(64),
    work_items: ['alpha', 'beta', 'gamma'].map(workItem),
  };
  const revalidation = makeClaim('proof.catalog_revalidation@1', revalidationPayload, {
    producerCheckId: 'revalidate_catalog',
    parentClaimIds: [candidate.claimId, admission.claimId, 'd'.repeat(64)].sort(),
  });
  const input = makeClaim('project.discovery_item@1', { project_id: 'journalservice', root: '.' }, {
    producerCheckId: 'project',
    parentClaimIds: [],
  });
  return { input, candidate, admission, revalidation };
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
});
